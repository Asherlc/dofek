import {
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type DatabaseBackupStorage,
  sweepExpiredDatabaseBackups,
  verifyAccountErasureBackupRetention,
} from "./backup-retention.ts";
import { R2DatabaseBackupStorage } from "./database-backup-storage.ts";

const minioImage =
  "minio/minio:latest@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e";
const password = "backup-retention-integration-secret";
const username = "backup-retention";
const requestedAt = new Date("2026-07-01T00:00:00.000Z");
const scrubbedAt = new Date("2026-07-08T00:00:00.000Z");
const beforeScrub = "Health-20260707-235959-10000000-0000-4000-8000-000000001994";
const afterScrub = "Health-20260720-000001-30000000-0000-4000-8000-000000001994";

describe("R2 database backup retention against MinIO", () => {
  let bucketSequence = 0;
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
  }, 120_000);

  afterAll(async () => {
    client?.destroy();
    if (container) await container.stop();
  });

  async function createBucket(): Promise<string> {
    bucketSequence += 1;
    const bucket = `backup-retention-${bucketSequence}`;
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    return bucket;
  }

  async function listObjectKeys(bucket: string): Promise<string[]> {
    const response = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
    return (response.Contents ?? []).flatMap((object) => (object.Key ? [object.Key] : []));
  }

  it("uses snapshot-start timestamps despite recent uploads and removes chunk companions", async () => {
    const bucket = await createBucket();
    for (const key of [
      beforeScrub,
      `${beforeScrub}.metadata`,
      `${beforeScrub}.part000001`,
      `${beforeScrub}.parts`,
      afterScrub,
    ]) {
      await client.send(new PutObjectCommand({ Body: key, Bucket: bucket, Key: key }));
    }

    await expect(
      verifyAccountErasureBackupRetention(new R2DatabaseBackupStorage(client, bucket), {
        maxSweepPasses: 3,
        now: new Date("2026-07-29T00:00:01.000Z"),
        piiScrubbedAt: scrubbedAt,
        requestedAt,
        retentionDays: 21,
      }),
    ).resolves.toEqual({ deletedObjects: 4 });

    await expect(listObjectKeys(bucket)).resolves.toEqual([afterScrub]);
  });

  it("aborts an in-flight upload based on snapshot start, not initiation time", async () => {
    const bucket = await createBucket();
    await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: beforeScrub }));

    await expect(
      verifyAccountErasureBackupRetention(new R2DatabaseBackupStorage(client, bucket), {
        maxSweepPasses: 3,
        now: new Date("2026-07-29T00:00:01.000Z"),
        piiScrubbedAt: scrubbedAt,
        requestedAt,
        retentionDays: 21,
      }),
    ).resolves.toEqual({ deletedObjects: 0 });

    const response = await client.send(new ListMultipartUploadsCommand({ Bucket: bucket }));
    expect(response.Uploads ?? []).toEqual([]);
  });

  it("follows multipart marker pairs across a real paginated listing", async () => {
    const bucket = await createBucket();
    const uploadCount = 1_001;
    const uploads = Array.from({ length: uploadCount }, (_, index) => {
      const suffix = index.toString().padStart(6, "0");
      return client.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: `${beforeScrub}.part${suffix}`,
        }),
      );
    });
    await Promise.all(uploads);

    await expect(
      sweepExpiredDatabaseBackups(new R2DatabaseBackupStorage(client, bucket), {
        maxSweepPasses: 3,
        now: new Date("2026-07-29T00:00:01.000Z"),
        retentionDays: 21,
      }),
    ).resolves.toEqual({ deletedObjects: 0 });

    const response = await client.send(new ListMultipartUploadsCommand({ Bucket: bucket }));
    expect(response.Uploads ?? []).toEqual([]);
  }, 120_000);

  it("fails closed without deleting an unknown managed-bucket object", async () => {
    const bucket = await createBucket();
    const unknownKey = "unknown-backup.sql.gz";
    await client.send(new PutObjectCommand({ Body: unknownKey, Bucket: bucket, Key: unknownKey }));

    await expect(
      sweepExpiredDatabaseBackups(new R2DatabaseBackupStorage(client, bucket), {
        maxSweepPasses: 3,
        now: new Date("2026-07-29T00:00:01.000Z"),
        retentionDays: 21,
      }),
    ).rejects.toThrow(`Unknown database backup object key: ${unknownKey}`);

    await expect(listObjectKeys(bucket)).resolves.toEqual([unknownKey]);
  });

  it("repeats verification when an upload appears after the object pass", async () => {
    const bucket = await createBucket();
    await client.send(
      new PutObjectCommand({ Body: beforeScrub, Bucket: bucket, Key: beforeScrub }),
    );
    const delegate = new R2DatabaseBackupStorage(client, bucket);
    let injectedUpload = false;
    const racingStorage: DatabaseBackupStorage = {
      abortMultipartUpload: (key, uploadId) => delegate.abortMultipartUpload(key, uploadId),
      deleteObjects: async (keys) => {
        const result = await delegate.deleteObjects(keys);
        if (!injectedUpload) {
          injectedUpload = true;
          await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: beforeScrub }));
        }
        return result;
      },
      listMultipartUploads: (keyMarker, uploadIdMarker) =>
        delegate.listMultipartUploads(keyMarker, uploadIdMarker),
      listPage: (continuationToken) => delegate.listPage(continuationToken),
    };

    await expect(
      sweepExpiredDatabaseBackups(racingStorage, {
        maxSweepPasses: 3,
        now: new Date("2026-07-29T00:00:01.000Z"),
        retentionDays: 21,
      }),
    ).resolves.toEqual({ deletedObjects: 1 });

    const response = await client.send(new ListMultipartUploadsCommand({ Bucket: bucket }));
    expect(response.Uploads ?? []).toEqual([]);
  });
});
