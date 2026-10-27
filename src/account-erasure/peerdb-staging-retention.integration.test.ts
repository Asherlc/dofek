import {
  CreateBucketCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  S3PeerDbStagingStorage,
  verifyPeerDbStagingRetention,
} from "./peerdb-staging-retention.ts";
import { createSeaweedFsS3Container } from "./test-helpers.ts";

const bucket = "peerdbbucket";
const password = "peerdb-integration-secret";
const username = "peerdb";

describe("PeerDB staging retention against SeaweedFS S3", () => {
  let client: S3Client;
  let container: StartedTestContainer | undefined;

  beforeAll(async () => {
    container = await createSeaweedFsS3Container().start();
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
              AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
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
    // SeaweedFS ListMultipartUploads omits Initiated timestamps, so this stand-in
    // cannot prove multipart retention ages. Object + lifecycle coverage remains.
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
      multipartUploadsInspected: 0,
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
});
