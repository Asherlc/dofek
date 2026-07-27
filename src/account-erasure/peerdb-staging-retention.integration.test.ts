import { randomUUID } from "node:crypto";
import {
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type PeerDbStagingStorage,
  S3PeerDbStagingStorage,
  verifyPeerDbStagingRetention,
} from "./peerdb-staging-retention.ts";
import {
  capturePeerDbStagingBoundary,
  type PeerDbStagingBarrierDatabase,
} from "./peerdb-staging-writer-barrier.ts";

const bucket = "peerdbbucket";
const minioImage =
  "minio/minio:latest@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e";
const password = "peerdb-integration-secret";
const username = "peerdb";

describe("PeerDB staging retention against MinIO", () => {
  let client: S3Client;
  let container: Awaited<ReturnType<GenericContainer["start"]>> | undefined;

  beforeAll(async () => {
    container = await new GenericContainer(minioImage)
      .withCommand(["server", "/data"])
      .withEnvironment({
        MINIO_API_STALE_UPLOADS_CLEANUP_INTERVAL: "15m",
        MINIO_API_STALE_UPLOADS_EXPIRY: "24h",
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
    await client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: bucket,
        LifecycleConfiguration: {
          Rules: [
            {
              Expiration: { Days: 1 },
              Filter: { Prefix: "" },
              ID: "peerdb-transient-stage-retention",
              Status: "Enabled",
            },
          ],
        },
      }),
    );
    await client.send(
      new PutObjectCommand({
        Body: "transient-stage",
        Bucket: bucket,
        Key: "current-object",
      }),
    );
    await client.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: "current-multipart-upload",
      }),
    );
  }, 120_000);

  afterAll(async () => {
    client?.destroy();
    if (container) await container.stop();
  });

  it("proves the unversioned one-day lifecycle and enumerates live transient state", async () => {
    const storage = new S3PeerDbStagingStorage(client, bucket);
    const marker = await storage.createBoundaryMarker(
      "account-erasure-boundaries/10000000-0000-4000-8000-000000001994",
    );
    expect(marker.eTag).not.toBe("");
    expect(marker.lastModified.getTime()).toBeGreaterThan(0);
    await expect(
      verifyPeerDbStagingRetention(storage, {
        cutoff: new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000),
        now: new Date(),
      }),
    ).resolves.toEqual({
      lifecycleRetentionDays: 1,
      multipartUploadsInspected: 1,
      objectsInspected: 2,
      verified: true,
    });
  });

  it("rejects a one-day lifecycle rule that applies to only a prefix", async () => {
    const restrictedBucket = "peerdb-restricted";
    await client.send(new CreateBucketCommand({ Bucket: restrictedBucket }));
    await client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: restrictedBucket,
        LifecycleConfiguration: {
          Rules: [
            {
              Expiration: { Days: 1 },
              Filter: { Prefix: "peerdb-only/" },
              ID: "peerdb-transient-stage-retention",
              Status: "Enabled",
            },
          ],
        },
      }),
    );

    await expect(
      verifyPeerDbStagingRetention(new S3PeerDbStagingStorage(client, restrictedBucket), {
        cutoff: new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000),
        now: new Date(),
      }),
    ).rejects.toThrow(
      "PeerDB staging bucket is missing the required global one-day lifecycle rule",
    );
  });

  it("moves the cutoff past an MPU that completes after the paused marker", async () => {
    const transitionBucket = `peerdb-transition-${randomUUID()}`;
    const transitionKey = "transition-completion.avro";
    const lateUploadKey = "late-pending-stage.avro";
    await client.send(new CreateBucketCommand({ Bucket: transitionBucket }));
    await client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: transitionBucket,
        LifecycleConfiguration: {
          Rules: [
            {
              Expiration: { Days: 1 },
              Filter: { Prefix: "" },
              ID: "peerdb-transient-stage-retention",
              Status: "Enabled",
            },
          ],
        },
      }),
    );
    const multipart = await client.send(
      new CreateMultipartUploadCommand({
        Bucket: transitionBucket,
        Key: transitionKey,
      }),
    );
    if (!multipart.UploadId) throw new Error("MinIO did not create the transition MPU");
    const part = await client.send(
      new UploadPartCommand({
        Body: "completed while PeerDB was entering STATUS_PAUSED",
        Bucket: transitionBucket,
        Key: transitionKey,
        PartNumber: 1,
        UploadId: multipart.UploadId,
      }),
    );
    if (!part.ETag) throw new Error("MinIO did not return the transition MPU part ETag");

    const storage = new S3PeerDbStagingStorage(client, transitionBucket);
    const markerKey = "account-erasure-boundaries/10000000-0000-4000-8000-000000001994";
    const storageWithCompletion: PeerDbStagingStorage = {
      createBoundaryMarker: async (key) => {
        const marker = await storage.createBoundaryMarker(key);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 1_100);
        });
        await client.send(
          new CompleteMultipartUploadCommand({
            Bucket: transitionBucket,
            Key: transitionKey,
            MultipartUpload: {
              Parts: [{ ETag: part.ETag, PartNumber: 1 }],
            },
            UploadId: multipart.UploadId,
          }),
        );
        const lateUpload = await client.send(
          new CreateMultipartUploadCommand({
            Bucket: transitionBucket,
            Key: lateUploadKey,
          }),
        );
        if (!lateUpload.UploadId) {
          throw new Error("MinIO did not create the late transition MPU");
        }
        return marker;
      },
      getLifecycleConfiguration: () => storage.getLifecycleConfiguration(),
      getVersioningStatus: () => storage.getVersioningStatus(),
      listMultipartUploads: (keyMarker, uploadIdMarker) =>
        storage.listMultipartUploads(keyMarker, uploadIdMarker),
      listObjects: (continuationToken) => storage.listObjects(continuationToken),
    };
    let mirrorState = "STATUS_RUNNING";
    const database: PeerDbStagingBarrierDatabase = {
      transaction: (operation) =>
        operation({
          execute: async () => [],
        }),
    };
    const boundary = await capturePeerDbStagingBoundary(
      database,
      {
        changeMirrorState: async (request) => {
          mirrorState = request.requestedFlowState;
        },
        getMirrorStatus: async () => ({
          currentFlowState: mirrorState,
          tableMappings: [],
        }),
        listMirrors: async () => [
          {
            destinationType: "CLICKHOUSE",
            isCdc: true,
            name: "dofek_fitness_raw_analytics",
          },
        ],
      },
      storageWithCompletion,
      {
        loadProgress: async () => null,
        requestId: "10000000-0000-4000-8000-000000001994",
        saveProgress: async () => undefined,
      },
    );
    const markerObject = await client.send(
      new HeadObjectCommand({
        Bucket: transitionBucket,
        Key: markerKey,
      }),
    );
    const completedObject = await client.send(
      new HeadObjectCommand({
        Bucket: transitionBucket,
        Key: transitionKey,
      }),
    );
    if (!completedObject.LastModified) {
      throw new Error("MinIO did not return the completed transition object timestamp");
    }
    if (!markerObject.LastModified) {
      throw new Error("MinIO did not return the transition marker timestamp");
    }
    const remainingUploads = await storage.listMultipartUploads(null, null);
    const lateUpload = remainingUploads.uploads.find((upload) => upload.key === lateUploadKey);
    if (!lateUpload?.initiated) {
      throw new Error("MinIO did not return the late transition MPU timestamp");
    }
    const expectedCutoff = new Date(
      Math.max(
        markerObject.LastModified.getTime(),
        completedObject.LastModified.getTime(),
        lateUpload.initiated.getTime(),
      ),
    );

    expect(boundary.cutoff).toBe(expectedCutoff.toISOString());
    expect(expectedCutoff.getTime()).toBeGreaterThan(markerObject.LastModified.getTime());

    await expect(
      verifyPeerDbStagingRetention(storage, {
        cutoff: new Date(boundary.cutoff),
        now: new Date(),
      }),
    ).rejects.toThrow(
      "PeerDB staging bucket still contains an object from at or before the account-erasure cutoff",
    );
  });
});
