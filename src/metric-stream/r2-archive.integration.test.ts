import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { sql } from "drizzle-orm";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  eraseMetricStreamArchive,
  R2MetricStreamArchiveStorage,
} from "../account-erasure/archive-erasure.ts";
import { archiveIdentityFixture } from "../account-erasure/archive-erasure-test-helpers.ts";
import { createSeaweedFsS3Container } from "../account-erasure/test-helpers.ts";
import { analyticsPosition } from "../analytics/test-helpers.ts";
import { lockAccountErasureActivation } from "../db/account-erasure-locks.ts";
import { createDatabase } from "../db/index.ts";
import {
  createTestBarrier,
  hasDatabaseLockWaiter,
  setupTestDatabase,
  type TestContext,
} from "../db/test-helpers.ts";
import type { MetricStreamRedpandaEvent } from "./events.ts";
import type { PulsarMetricStreamBatchContext } from "./pulsar-consumer.ts";
import { archiveMetricStreamDeliveries } from "./r2-archive.ts";
import { parseMetricStreamArchiveObjectKey } from "./r2-replay.ts";

const bucket = "native-archive";
const stream = {
  transport: "pulsar" as const,
  epoch: "archive-qualification",
  topic: "persistent://public/default/archive",
  partition: -1,
};
const deletingUserId = "10000000-0000-4000-8000-000000000111";
const otherUserId = "20000000-0000-4000-8000-000000000111";

function rowEvent(userId: string, id: string): MetricStreamRedpandaEvent {
  return {
    version: 1,
    generation: 0,
    id,
    userId,
    providerId: "fixture",
    sourceType: "sensor",
    channel: "heart_rate",
    recordedAt: "2026-01-01T00:00:00.000Z",
    scalar: 71,
  };
}

function batch(entry: bigint, users: readonly string[]): PulsarMetricStreamBatchContext {
  const events = users.map((userId, index) =>
    rowEvent(
      userId,
      index === 0 ? "30000000-0000-4000-8000-000000000111" : "40000000-0000-4000-8000-000000000111",
    ),
  );
  return {
    topic: stream.topic,
    partition: -1,
    assertActive: async () => undefined,
    positions: users.map((_user, index) => analyticsPosition(stream, entry + BigInt(index))),
    deliveries: events.map((event) => ({
      key: "source",
      properties: {},
      publishTimestamp: Date.UTC(2026, 10, 5, 10),
      data: Buffer.from(JSON.stringify(event)),
    })),
  };
}

describe("native archive against the existing bounded SeaweedFS S3 fixture", () => {
  let container: StartedTestContainer | undefined;
  let client: S3Client;
  let postgres: TestContext;

  beforeAll(async () => {
    postgres = await setupTestDatabase();
    const credentials = {
      accessKeyId: "archive-writer",
      secretAccessKey: "archive-writer-test-secret",
    };
    container = await createSeaweedFsS3Container(credentials)
      .withResourcesQuota({ memory: 0.5, cpu: 1 })
      .start();
    client = new S3Client({
      credentials,
      endpoint: `http://${container.getHost()}:${container.getMappedPort(9000)}`,
      forcePathStyle: true,
      region: "us-east-1",
    });
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }, 120000);

  afterAll(async () => {
    client?.destroy();
    if (container) await container.stop();
    await postgres?.cleanup();
  });

  it("durably stores exact JSONL and verifies identical create-only redelivery", async () => {
    const context = batch(1n, [otherUserId]);
    await archiveMetricStreamDeliveries(
      client,
      bucket,
      context,
      postgres.db,
      new AbortController().signal,
    );
    const listing = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: "metric-stream/v1/" }),
    );
    const key = listing.Contents?.[0]?.Key;
    if (!key) throw new Error("Native archive object missing");
    expect(parseMetricStreamArchiveObjectKey(key)).toMatchObject({
      transport: "pulsar",
      epoch: stream.epoch,
      topic: stream.topic,
      date: "2026-11-05",
      hour: "10",
    });
    const before = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    await archiveMetricStreamDeliveries(
      client,
      bucket,
      context,
      postgres.db,
      new AbortController().signal,
    );
    const after = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    expect(after.ETag).toBe(before.ETag);
    expect(after).toMatchObject({ ContentEncoding: "gzip", ContentType: "application/x-ndjson" });
    const stored = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!stored.Body) throw new Error("Native archive body missing");
    expect(gunzipSync(await stored.Body.transformToByteArray())).toEqual(
      Buffer.concat(context.deliveries.flatMap(({ data }) => [data, Buffer.from("\n")])),
    );
  });

  it("uses the production eraser for native keys and refuses to overwrite its rewrite", async () => {
    const context = batch(10n, [deletingUserId, otherUserId]);
    await archiveMetricStreamDeliveries(
      client,
      bucket,
      context,
      postgres.db,
      new AbortController().signal,
    );
    const result = await eraseMetricStreamArchive(
      new R2MetricStreamArchiveStorage(client, bucket),
      { userId: deletingUserId, stage: "initial", store: archiveIdentityFixture() },
    );
    expect(result).toMatchObject({ objectsRewritten: 1, recordsRemoved: 1 });
    await expect(
      archiveMetricStreamDeliveries(
        client,
        bucket,
        context,
        postgres.db,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/collision content/i);
    const keys = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: "metric-stream/v1/" }),
    );
    const originalFirst = context.positions[0];
    if (originalFirst?.transport !== "pulsar") throw new Error("Native position missing");
    const key = keys.Contents?.find((object) =>
      object.Key?.includes(
        `/first=${Buffer.from(originalFirst.serializedMessageId, "base64").toString("hex")}/`,
      ),
    )?.Key;
    if (!key) throw new Error("Rewritten native archive missing");
    const stored = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!stored.Body) throw new Error("Rewritten archive body missing");
    expect(gunzipSync(await stored.Body.transformToByteArray())).toEqual(
      Buffer.concat(context.deliveries.slice(1).flatMap(({ data }) => [data, Buffer.from("\n")])),
    );
  });

  it("holds the shared delivery fence through PutObject so exclusive activation waits, and omits postfence rows", async () => {
    const putStarted = createTestBarrier();
    const finishPut = createTestBarrier();
    const originalSend = client.send.bind(client);
    const send = vi.spyOn(client, "send").mockImplementation(async (command, options) => {
      if (command instanceof PutObjectCommand) {
        putStarted.resolve();
        await finishPut.promise;
      }
      return originalSend(command, options);
    });
    const contested = createDatabase(postgres.connectionString);
    let activationEntered = false;
    const openUpload = batch(20n, [deletingUserId, otherUserId]);
    const upload = archiveMetricStreamDeliveries(
      client,
      bucket,
      openUpload,
      postgres.db,
      new AbortController().signal,
    );
    try {
      await putStarted.promise;
      const waiting = contested.transaction(async (transaction) => {
        await lockAccountErasureActivation(transaction, deletingUserId);
        activationEntered = true;
      });
      const settled = Promise.allSettled([upload, waiting]);
      try {
        await expect.poll(() => hasDatabaseLockWaiter(postgres.db)).toBe(true);
        expect(activationEntered).toBe(false);
      } finally {
        finishPut.resolve();
      }
      const outcomes = await settled;
      expect(outcomes[0]?.status).toBe("fulfilled");
      expect(outcomes[1]?.status).toBe("fulfilled");
      expect(activationEntered).toBe(true);

      const digest = (value: string) => createHash("sha256").update(value).digest("hex");
      const requestId = randomUUID();
      await postgres.db.execute(sql`
        INSERT INTO fitness.user_profile (id, name)
        VALUES (${deletingUserId}::uuid, 'Archive fence fixture')
        ON CONFLICT (id) DO NOTHING`);
      await postgres.db.execute(sql`
        INSERT INTO fitness.account_erasure_request (
          id, user_id, user_hash, user_hash_key_id, write_fence_hash, status_token_hash,
          encrypted_remote_snapshot, replay_retained_until, completion_deadline, status
        ) VALUES (
          ${requestId}::uuid,
          ${deletingUserId}::uuid,
          ${digest(requestId)},
          'test-v1',
          ${digest(deletingUserId)},
          ${digest(requestId)},
          'retained-snapshot',
          now() + interval '7 days',
          now() + interval '30 days',
          'running'
        )`);
      const postfence = batch(30n, [deletingUserId, otherUserId]);
      await archiveMetricStreamDeliveries(
        client,
        bucket,
        postfence,
        postgres.db,
        new AbortController().signal,
      );
      const listing = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: "metric-stream/v1/" }),
      );
      const originalFirst = postfence.positions[0];
      if (originalFirst?.transport !== "pulsar") throw new Error("Native position missing");
      const key = listing.Contents?.find((object) =>
        object.Key?.includes(
          `/first=${Buffer.from(originalFirst.serializedMessageId, "base64").toString("hex")}/`,
        ),
      )?.Key;
      if (!key) throw new Error("Postfence archive object missing");
      const stored = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!stored.Body) throw new Error("Postfence archive body missing");
      expect(gunzipSync(await stored.Body.transformToByteArray())).toEqual(
        Buffer.concat(
          postfence.deliveries.slice(1).flatMap(({ data }) => [data, Buffer.from("\n")]),
        ),
      );
      expect(parseMetricStreamArchiveObjectKey(key)).toMatchObject({
        firstHex: Buffer.from(originalFirst.serializedMessageId, "base64").toString("hex"),
        lastHex: Buffer.from(
          postfence.positions[1]?.transport === "pulsar"
            ? postfence.positions[1].serializedMessageId
            : "",
          "base64",
        ).toString("hex"),
      });
    } finally {
      finishPut.resolve();
      send.mockRestore();
      await contested.$client.end();
      await Promise.allSettled([upload]);
    }
  });
});
