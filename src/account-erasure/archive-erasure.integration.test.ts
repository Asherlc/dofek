import { gunzipSync, gzipSync } from "node:zlib";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createMetricStreamBatchCompletedEvent,
  createMetricStreamDeletedEvent,
} from "../metric-stream/events.ts";
import { eraseMetricStreamArchive, R2MetricStreamArchiveStorage } from "./archive-erasure.ts";
import { createSeaweedFsS3Container } from "./test-helpers.ts";

const bucket = "metric-archive";
const deletingUserId = "10000000-0000-4000-8000-000000001994";
const otherUserId = "20000000-0000-4000-8000-000000001994";
const password = "archive-erasure-integration-secret";
const username = "archive-erasure";

function metricEvent(userId: string, id: string): Record<string, unknown> {
  return {
    channel: "heart_rate",
    generation: 0,
    id,
    providerId: "apple_health",
    recordedAt: "2026-07-26T10:00:00.000Z",
    scalar: 70,
    sourceType: "api",
    userId,
    version: 1,
  };
}

describe("R2 archive erasure against SeaweedFS S3", () => {
  let client: S3Client;
  let container: StartedTestContainer | undefined;

  beforeAll(async () => {
    container = await createSeaweedFsS3Container()
      .withResourcesQuota({ memory: 0.5, cpu: 1 })
      .start();
    client = new S3Client({
      credentials: {
        accessKeyId: username,
        secretAccessKey: password,
      },
      endpoint: `http://${container.getHost()}:${container.getMappedPort(9000)}`,
      forcePathStyle: true,
      region: "us-east-1",
    });
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }, 120_000);

  afterAll(async () => {
    client?.destroy();
    if (container) await container.stop();
  });

  it("preserves content headers and all custom metadata through a real multipart rewrite", async () => {
    const key = "metric-stream/v1/date=2026-07-26/hour=10/metric-stream-v1-0-10-11.jsonl.gz";
    const foreign = JSON.stringify(
      metricEvent(otherUserId, "40000000-0000-4000-8000-000000001994"),
    );
    const preserved = ` ${foreign}\r\n\r${foreign}\n\t${foreign}`;
    await client.send(
      new PutObjectCommand({
        Body: gzipSync(
          `${JSON.stringify(
            metricEvent(deletingUserId, "30000000-0000-4000-8000-000000001994"),
          )}\n${preserved}`,
        ),
        Bucket: bucket,
        ContentEncoding: "x-gzip",
        ContentType: "application/vnd.dofek.metric-stream+jsonl",
        Key: key,
        Metadata: {
          "archive-generation": "7",
          "source-cluster": "redpanda-production",
        },
      }),
    );

    await expect(
      eraseMetricStreamArchive(new R2MetricStreamArchiveStorage(client, bucket), {
        activityIds: new Set(),
        operationIds: new Set(),
        userId: deletingUserId,
      }),
    ).resolves.toEqual({
      lastKey: key,
      objectsRewritten: 1,
      recordsRemoved: 1,
    });

    await expect(
      client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })),
    ).resolves.toMatchObject({
      ContentEncoding: "x-gzip",
      ContentType: "application/vnd.dofek.metric-stream+jsonl",
      Metadata: {
        "archive-generation": "7",
        "source-cluster": "redpanda-production",
      },
    });
    const rewritten = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!rewritten.Body) throw new Error("Rewritten archive has no body");
    expect(gunzipSync(await rewritten.Body.transformToByteArray())).toEqual(Buffer.from(preserved));
  });

  it("erases native-key payloads and controls while preserving exact foreign bytes and metadata", async () => {
    const key = `metric-stream/v1/date=2026-11-05/hour=03/pulsar/epoch=e1/topic=${encodeURIComponent("persistent://public/default/sensor-partition-2")}/first=ff/last=00.jsonl.gz`;
    const operationId = "50000000-0000-4000-8000-000000001994";
    const owned = [
      metricEvent(deletingUserId, "30000000-0000-4000-8000-000000001994"),
      createMetricStreamDeletedEvent({ userId: deletingUserId }, "1"),
      createMetricStreamBatchCompletedEvent(
        { operationId, batchId: "batch-1994", datasetKeys: ["metric-stream"] },
        1,
      ),
    ].map((event) => JSON.stringify(event));
    const foreign = JSON.stringify(
      metricEvent(otherUserId, "40000000-0000-4000-8000-000000001994"),
    );
    const preserved = `  ${foreign}\r\n\r${foreign}\n\t${foreign}`;
    await client.send(
      new PutObjectCommand({
        Body: gzipSync(`${owned.join("\n")}\n${preserved}`),
        Bucket: bucket,
        Key: key,
        ContentEncoding: "x-gzip",
        ContentType: "application/vnd.dofek.metric-stream+jsonl",
        Metadata: { "archive-generation": "7", "source-cluster": "pulsar-qualification" },
      }),
    );
    const identifiers = {
      activityIds: new Set<string>(),
      operationIds: new Set([operationId]),
      userId: deletingUserId,
    };
    await expect(
      eraseMetricStreamArchive(new R2MetricStreamArchiveStorage(client, bucket), identifiers),
    ).resolves.toEqual({ lastKey: key, objectsRewritten: 1, recordsRemoved: 3 });
    await expect(
      client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })),
    ).resolves.toMatchObject({
      ContentEncoding: "x-gzip",
      ContentType: "application/vnd.dofek.metric-stream+jsonl",
      Metadata: { "archive-generation": "7", "source-cluster": "pulsar-qualification" },
    });
    const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!object.Body) throw new Error("Rewritten archive has no body");
    expect(gunzipSync(await object.Body.transformToByteArray()).toString("utf8")).toBe(preserved);
    await expect(
      eraseMetricStreamArchive(new R2MetricStreamArchiveStorage(client, bucket), identifiers),
    ).resolves.toEqual({ lastKey: key, objectsRewritten: 0, recordsRemoved: 0 });
  });

  it.each([900000, 900001])(
    "enforces the %i-byte record boundary against stored S3 objects",
    async (bytes) => {
      const key = `metric-stream/v1/date=2026-11-06/hour=04/metric-stream-v1-0-${bytes}-${bytes + 1}.jsonl.gz`;
      const foreign = JSON.stringify(
        metricEvent(otherUserId, "40000000-0000-4000-8000-000000001994"),
      );
      const preserved = foreign + " ".repeat(bytes - Buffer.byteLength(foreign));
      const original = gzipSync(
        `${JSON.stringify(metricEvent(deletingUserId, "30000000-0000-4000-8000-000000001994"))}\n${preserved}`,
      );
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: original }));
      try {
        const completed: string[] = [];
        const operation = eraseMetricStreamArchive(
          new R2MetricStreamArchiveStorage(client, bucket),
          {
            activityIds: new Set(),
            operationIds: new Set(),
            userId: deletingUserId,
          },
          {
            onObjectCompleted: async (value) => {
              completed.push(value);
            },
          },
        );
        if (bytes === 900000) {
          await expect(operation).resolves.toMatchObject({ recordsRemoved: 1 });
          expect(completed).toContain(key);
        } else {
          await expect(operation).rejects.toThrow("900000-byte limit");
          expect(completed).not.toContain(key);
        }
        const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!object.Body) throw new Error("Stored archive has no body");
        const actual = Buffer.from(await object.Body.transformToByteArray());
        expect(bytes === 900000 ? gunzipSync(actual) : actual).toEqual(
          bytes === 900000 ? Buffer.from(preserved) : original,
        );
      } finally {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      }
    },
  );

  it("keeps a stored object and its checkpoint unchanged when gzip EOF is corrupt", async () => {
    const key = "metric-stream/v1/date=2026-11-06/hour=05/metric-stream-v1-0-40-41.jsonl.gz";
    const original = gzipSync(
      `${JSON.stringify(metricEvent(deletingUserId, "30000000-0000-4000-8000-000000001994"))}\n`,
    ).subarray(0, -4);
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: original }));
    try {
      const completed: string[] = [];
      await expect(
        eraseMetricStreamArchive(
          new R2MetricStreamArchiveStorage(client, bucket),
          {
            activityIds: new Set(),
            operationIds: new Set(),
            userId: deletingUserId,
          },
          {
            onObjectCompleted: async (value) => {
              completed.push(value);
            },
          },
        ),
      ).rejects.toThrow();
      expect(completed).not.toContain(key);
      const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!object.Body) throw new Error("Stored archive has no body");
      expect(Buffer.from(await object.Body.transformToByteArray())).toEqual(original);
    } finally {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    }
  });

  it("rejects a changed S3 ETag between scan and rewrite without overwriting the newer object", async () => {
    const key = "metric-stream/v1/date=2026-11-06/hour=06/metric-stream-v1-0-50-51.jsonl.gz";
    const original = gzipSync(
      `${JSON.stringify(metricEvent(deletingUserId, "30000000-0000-4000-8000-000000001994"))}\n`,
    );
    const newer = gzipSync(
      `${JSON.stringify(metricEvent(otherUserId, "40000000-0000-4000-8000-000000001994"))}\r\n`,
    );
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: original }));
    class ConcurrentArchiveStorage extends R2MetricStreamArchiveStorage {
      #reads = 0;
      override async getObject(objectKey: string) {
        if (objectKey === key && ++this.#reads === 2)
          await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: newer }));
        return super.getObject(objectKey);
      }
    }
    try {
      const completed: string[] = [];
      await expect(
        eraseMetricStreamArchive(
          new ConcurrentArchiveStorage(client, bucket),
          {
            activityIds: new Set(),
            operationIds: new Set(),
            userId: deletingUserId,
          },
          {
            onObjectCompleted: async (value) => {
              completed.push(value);
            },
          },
        ),
      ).rejects.toThrow("changed during account erasure scan");
      expect(completed).not.toContain(key);
      const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!object.Body) throw new Error("Stored archive has no body");
      expect(Buffer.from(await object.Body.transformToByteArray())).toEqual(newer);
    } finally {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    }
  });
});
