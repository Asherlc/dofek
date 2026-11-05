import { gunzipSync, gzipSync } from "node:zlib";
import {
  CreateBucketCommand,
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
    await client.send(
      new PutObjectCommand({
        Body: gzipSync(
          `${JSON.stringify(
            metricEvent(deletingUserId, "30000000-0000-4000-8000-000000001994"),
          )}\n${JSON.stringify(
            metricEvent(otherUserId, "40000000-0000-4000-8000-000000001994"),
          )}\n`,
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
    const preserved = `  ${JSON.stringify(metricEvent(otherUserId, "40000000-0000-4000-8000-000000001994"))} `;
    await client.send(
      new PutObjectCommand({
        Body: gzipSync(`${owned.join("\n")}\n${preserved}\n`),
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
    expect(gunzipSync(await object.Body.transformToByteArray()).toString("utf8")).toBe(
      `${preserved}\n`,
    );
    await expect(
      eraseMetricStreamArchive(new R2MetricStreamArchiveStorage(client, bucket), identifiers),
    ).resolves.toEqual({ lastKey: key, objectsRewritten: 0, recordsRemoved: 0 });
  });
});
