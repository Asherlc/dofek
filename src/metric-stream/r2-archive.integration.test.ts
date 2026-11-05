import { gunzipSync } from "node:zlib";
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  eraseMetricStreamArchive,
  R2MetricStreamArchiveStorage,
} from "../account-erasure/archive-erasure.ts";
import { archiveIdentityFixture } from "../account-erasure/archive-erasure-test-helpers.ts";
import { createSeaweedFsS3Container } from "../account-erasure/test-helpers.ts";
import { analyticsPosition } from "../analytics/test-helpers.ts";
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
function batch(entry: bigint, users: readonly string[]): PulsarMetricStreamBatchContext {
  return {
    topic: stream.topic,
    partition: -1,
    assertActive: async () => undefined,
    positions: users.map((_user, index) => analyticsPosition(stream, entry + BigInt(index))),
    deliveries: users.map((userId, index) => ({
      key: "source",
      properties: {},
      publishTimestamp: Date.UTC(2026, 10, 5, 10),
      data: Buffer.from(
        ` ${JSON.stringify({ version: 1, generation: 0, id: index === 0 ? "30000000-0000-4000-8000-000000000111" : "40000000-0000-4000-8000-000000000111", userId, providerId: "fixture", sourceType: "sensor", channel: "heart_rate", recordedAt: "2026-01-01T00:00:00.000Z", scalar: 71 })} `,
      ),
    })),
  };
}

describe("native archive against the existing bounded SeaweedFS S3 fixture", () => {
  let container: StartedTestContainer | undefined;
  let client: S3Client;
  beforeAll(async () => {
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
  });
  it("durably stores exact JSONL and verifies identical create-only redelivery", async () => {
    const context = batch(1n, [otherUserId]);
    await archiveMetricStreamDeliveries(client, bucket, context, new AbortController().signal);
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
    await archiveMetricStreamDeliveries(client, bucket, context, new AbortController().signal);
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
    await archiveMetricStreamDeliveries(client, bucket, context, new AbortController().signal);
    const result = await eraseMetricStreamArchive(
      new R2MetricStreamArchiveStorage(client, bucket),
      { userId: deletingUserId, stage: "initial", store: archiveIdentityFixture() },
    );
    expect(result).toMatchObject({ objectsRewritten: 1, recordsRemoved: 1 });
    await expect(
      archiveMetricStreamDeliveries(client, bucket, context, new AbortController().signal),
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
});
