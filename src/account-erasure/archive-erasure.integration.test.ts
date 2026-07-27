import { gzipSync } from "node:zlib";
import {
  CreateBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eraseMetricStreamArchive, R2MetricStreamArchiveStorage } from "./archive-erasure.ts";

const bucket = "metric-archive";
const deletingUserId = "10000000-0000-4000-8000-000000001994";
const otherUserId = "20000000-0000-4000-8000-000000001994";
const minioImage =
  "minio/minio:latest@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e";
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

describe("R2 archive erasure against MinIO", () => {
  let client: S3Client;
  let container: Awaited<ReturnType<GenericContainer["start"]>> | undefined;

  beforeAll(async () => {
    container = await new GenericContainer(minioImage)
      .withCommand(["server", "/data"])
      .withEnvironment({
        MINIO_ROOT_PASSWORD: password,
        MINIO_ROOT_USER: username,
      })
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forLogMessage(/API:/))
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
});
