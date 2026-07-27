import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPeerDbStagingStorageFromEnv,
  type PeerDbStagingStorage,
  S3PeerDbStagingStorage,
  verifyPeerDbStagingRetention,
} from "./peerdb-staging-retention.ts";

const now = new Date("2026-08-02T12:00:00.000Z");
const cutoff = new Date("2026-07-26T12:00:00.000Z");
const verificationInput = { cutoff, now };

afterEach(() => {
  vi.unstubAllEnvs();
});

function storage(overrides: Partial<PeerDbStagingStorage> = {}): PeerDbStagingStorage {
  return {
    createBoundaryMarker: vi.fn(async () => ({
      eTag: '"boundary-etag"',
      lastModified: cutoff,
    })),
    getLifecycleConfiguration: vi.fn(async () => ({
      rules: [
        {
          expirationDays: 1,
          filter: {
            hasAnd: false,
            hasTag: false,
            objectSizeGreaterThan: null,
            objectSizeLessThan: null,
            prefix: "",
          },
          id: "peerdb-transient-stage-retention",
          legacyPrefix: null,
          status: "Enabled",
        },
      ],
    })),
    getVersioningStatus: vi.fn(async () => null),
    listMultipartUploads: vi.fn(async () => ({
      isTruncated: false,
      nextKeyMarker: null,
      nextUploadIdMarker: null,
      uploads: [],
    })),
    listObjects: vi.fn(async () => ({
      isTruncated: false,
      nextContinuationToken: null,
      objects: [],
    })),
    ...overrides,
  };
}

function stagingObject(lastModified: Date, key: string) {
  return {
    eTag: `"${key}-etag"`,
    key,
    lastModified,
  };
}

function stagingUpload(initiated: Date, key: string) {
  return {
    initiated,
    key,
    uploadId: `${key}-upload`,
  };
}

function s3StorageWithResponses(...responses: unknown[]): S3PeerDbStagingStorage {
  const client = new S3Client({
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    region: "us-east-1",
  });
  const send = vi.spyOn(client, "send");
  for (const response of responses) {
    Reflect.apply(send.mockResolvedValueOnce, send, [response]);
  }
  return new S3PeerDbStagingStorage(client, "peerdbbucket");
}

describe("verifyPeerDbStagingRetention", () => {
  it("accepts the managed one-day lifecycle and paginates fresh stage objects", async () => {
    const listObjects = vi
      .fn<PeerDbStagingStorage["listObjects"]>()
      .mockResolvedValueOnce({
        isTruncated: true,
        nextContinuationToken: "next-page",
        objects: [stagingObject(new Date("2026-08-02T11:00:00.000Z"), "fresh-stage-a")],
      })
      .mockResolvedValueOnce({
        isTruncated: false,
        nextContinuationToken: null,
        objects: [stagingObject(new Date("2026-08-02T10:00:00.000Z"), "fresh-stage-b")],
      });

    await expect(
      verifyPeerDbStagingRetention(storage({ listObjects }), verificationInput),
    ).resolves.toEqual({
      lifecycleRetentionDays: 1,
      multipartUploadsInspected: 0,
      objectsInspected: 2,
      verified: true,
    });
    expect(listObjects).toHaveBeenNthCalledWith(1, null);
    expect(listObjects).toHaveBeenNthCalledWith(2, "next-page");
  });

  it("fails when the deterministic lifecycle rule is absent or too long", async () => {
    await expect(
      verifyPeerDbStagingRetention(
        storage({
          getLifecycleConfiguration: vi.fn(async () => ({
            rules: [
              {
                expirationDays: 2,
                filter: {
                  hasAnd: false,
                  hasTag: false,
                  objectSizeGreaterThan: null,
                  objectSizeLessThan: null,
                  prefix: "",
                },
                id: "different-rule",
                legacyPrefix: null,
                status: "Enabled",
              },
            ],
          })),
        }),
        verificationInput,
      ),
    ).rejects.toThrow(
      "PeerDB staging bucket is missing the required global one-day lifecycle rule",
    );
  });

  it.each([
    {
      filter: {
        hasAnd: false,
        hasTag: false,
        objectSizeGreaterThan: null,
        objectSizeLessThan: null,
        prefix: "peerdb-only/",
      },
      legacyPrefix: null,
      restriction: "a nonempty prefix",
    },
    {
      filter: {
        hasAnd: false,
        hasTag: true,
        objectSizeGreaterThan: null,
        objectSizeLessThan: null,
        prefix: "",
      },
      legacyPrefix: null,
      restriction: "a tag",
    },
    {
      filter: {
        hasAnd: false,
        hasTag: false,
        objectSizeGreaterThan: 1,
        objectSizeLessThan: null,
        prefix: "",
      },
      legacyPrefix: null,
      restriction: "a minimum size",
    },
    {
      filter: {
        hasAnd: false,
        hasTag: false,
        objectSizeGreaterThan: null,
        objectSizeLessThan: 1_000,
        prefix: "",
      },
      legacyPrefix: null,
      restriction: "a maximum size",
    },
    {
      filter: {
        hasAnd: true,
        hasTag: false,
        objectSizeGreaterThan: null,
        objectSizeLessThan: null,
        prefix: "",
      },
      legacyPrefix: null,
      restriction: "an And expression",
    },
    {
      filter: {
        hasAnd: false,
        hasTag: false,
        objectSizeGreaterThan: null,
        objectSizeLessThan: null,
        prefix: "",
      },
      legacyPrefix: "peerdb-only/",
      restriction: "a legacy prefix",
    },
  ])("rejects a one-day lifecycle rule scoped by $restriction", async ({
    filter,
    legacyPrefix,
  }) => {
    await expect(
      verifyPeerDbStagingRetention(
        storage({
          getLifecycleConfiguration: vi.fn(async () => ({
            rules: [
              {
                expirationDays: 1,
                filter,
                id: "peerdb-transient-stage-retention",
                legacyPrefix,
                status: "Enabled",
              },
            ],
          })),
        }),
        verificationInput,
      ),
    ).rejects.toThrow(
      "PeerDB staging bucket is missing the required global one-day lifecycle rule",
    );
  });

  it("fails closed when bucket versioning could retain hidden object versions", async () => {
    await expect(
      verifyPeerDbStagingRetention(
        storage({
          getVersioningStatus: vi.fn(async () => "Enabled"),
        }),
        verificationInput,
      ),
    ).rejects.toThrow("PeerDB staging bucket versioning must be disabled");
  });

  it("fails when the MinIO scanner has left an object past the lifecycle boundary", async () => {
    await expect(
      verifyPeerDbStagingRetention(
        storage({
          listObjects: vi.fn(async () => ({
            isTruncated: false,
            nextContinuationToken: null,
            objects: [stagingObject(new Date("2026-08-01T11:59:59.999Z"), "expired-stage-object")],
          })),
        }),
        verificationInput,
      ),
    ).rejects.toThrow(
      "PeerDB staging bucket still contains objects past the one-day lifecycle boundary",
    );
  });

  it("fails when an incomplete multipart upload survives past one day", async () => {
    await expect(
      verifyPeerDbStagingRetention(
        storage({
          listMultipartUploads: vi.fn(async () => ({
            isTruncated: false,
            nextKeyMarker: null,
            nextUploadIdMarker: null,
            uploads: [stagingUpload(new Date("2026-08-01T11:59:59.999Z"), "expired-stage-upload")],
          })),
        }),
        verificationInput,
      ),
    ).rejects.toThrow(
      "PeerDB staging bucket still contains multipart uploads past the one-day lifecycle boundary",
    );
  });

  it("fails on a truncated page without continuation markers", async () => {
    await expect(
      verifyPeerDbStagingRetention(
        storage({
          listMultipartUploads: vi.fn(async () => ({
            isTruncated: true,
            nextKeyMarker: null,
            nextUploadIdMarker: null,
            uploads: [],
          })),
        }),
        verificationInput,
      ),
    ).rejects.toThrow(
      "PeerDB staging multipart listing was truncated without continuation markers",
    );
  });

  it("rejects a repeated object continuation token before issuing a third request", async () => {
    const listObjects = vi.fn<PeerDbStagingStorage["listObjects"]>(async () => {
      if (listObjects.mock.calls.length > 2) {
        throw new Error("PeerDB staging object listing issued an unexpected third request");
      }
      return {
        isTruncated: true,
        nextContinuationToken: "repeated-object-cursor",
        objects: [],
      };
    });

    await expect(
      verifyPeerDbStagingRetention(storage({ listObjects }), verificationInput),
    ).rejects.toThrow("PeerDB staging object listing repeated a continuation token");
    expect(listObjects).toHaveBeenCalledTimes(2);
  });

  it("rejects repeated multipart continuation markers before issuing a third request", async () => {
    const listMultipartUploads = vi.fn<PeerDbStagingStorage["listMultipartUploads"]>(async () => {
      if (listMultipartUploads.mock.calls.length > 2) {
        throw new Error("PeerDB staging multipart listing issued an unexpected third request");
      }
      return {
        isTruncated: true,
        nextKeyMarker: "repeated-key",
        nextUploadIdMarker: "repeated-upload",
        uploads: [],
      };
    });

    await expect(
      verifyPeerDbStagingRetention(storage({ listMultipartUploads }), verificationInput),
    ).rejects.toThrow("PeerDB staging multipart listing repeated continuation markers");
    expect(listMultipartUploads).toHaveBeenCalledTimes(2);
  });

  it("fails closed when an object listing omits identity evidence", async () => {
    await expect(
      verifyPeerDbStagingRetention(
        storage({
          listObjects: vi.fn(async () => ({
            isTruncated: false,
            nextContinuationToken: null,
            objects: [
              {
                eTag: null,
                key: "stage-object",
                lastModified: new Date("2026-08-02T11:00:00.000Z"),
              },
            ],
          })),
        }),
        verificationInput,
      ),
    ).rejects.toThrow("PeerDB staging objects are missing required ETags");
  });

  it("fails closed when a multipart listing omits its upload identity", async () => {
    await expect(
      verifyPeerDbStagingRetention(
        storage({
          listMultipartUploads: vi.fn(async () => ({
            isTruncated: false,
            nextKeyMarker: null,
            nextUploadIdMarker: null,
            uploads: [
              {
                initiated: new Date("2026-08-02T11:00:00.000Z"),
                key: "stage-upload",
                uploadId: null,
              },
            ],
          })),
        }),
        verificationInput,
      ),
    ).rejects.toThrow("PeerDB staging multipart uploads are missing required upload IDs");
  });

  it("rejects a duplicate object identity across listing pages", async () => {
    const duplicateObject = stagingObject(
      new Date("2026-08-02T11:00:00.000Z"),
      "duplicate-stage-object",
    );
    const listObjects = vi
      .fn<PeerDbStagingStorage["listObjects"]>()
      .mockResolvedValueOnce({
        isTruncated: true,
        nextContinuationToken: "next-page",
        objects: [duplicateObject],
      })
      .mockResolvedValueOnce({
        isTruncated: false,
        nextContinuationToken: null,
        objects: [duplicateObject],
      });

    await expect(
      verifyPeerDbStagingRetention(storage({ listObjects }), verificationInput),
    ).rejects.toThrow(
      "PeerDB staging object listing returned duplicate key duplicate-stage-object",
    );
  });

  it("rejects a duplicate multipart identity across listing pages", async () => {
    const duplicateUpload = stagingUpload(
      new Date("2026-08-02T11:00:00.000Z"),
      "duplicate-stage-upload",
    );
    const listMultipartUploads = vi
      .fn<PeerDbStagingStorage["listMultipartUploads"]>()
      .mockResolvedValueOnce({
        isTruncated: true,
        nextKeyMarker: "next-key",
        nextUploadIdMarker: "next-upload",
        uploads: [duplicateUpload],
      })
      .mockResolvedValueOnce({
        isTruncated: false,
        nextKeyMarker: null,
        nextUploadIdMarker: null,
        uploads: [duplicateUpload],
      });

    await expect(
      verifyPeerDbStagingRetention(storage({ listMultipartUploads }), verificationInput),
    ).rejects.toThrow("PeerDB staging multipart listing returned duplicate upload");
  });

  it("rejects an object completed at the storage-native erasure cutoff", async () => {
    await expect(
      verifyPeerDbStagingRetention(
        storage({
          listObjects: vi.fn(async () => ({
            isTruncated: false,
            nextContinuationToken: null,
            objects: [stagingObject(cutoff, "boundary-object")],
          })),
        }),
        verificationInput,
      ),
    ).rejects.toThrow(
      "PeerDB staging bucket still contains an object from at or before the account-erasure cutoff",
    );
  });

  it("rejects a multipart upload initiated at the storage-native erasure cutoff", async () => {
    await expect(
      verifyPeerDbStagingRetention(
        storage({
          listMultipartUploads: vi.fn(async () => ({
            isTruncated: false,
            nextKeyMarker: null,
            nextUploadIdMarker: null,
            uploads: [stagingUpload(cutoff, "boundary-upload")],
          })),
        }),
        verificationInput,
      ),
    ).rejects.toThrow(
      "PeerDB staging bucket still contains a multipart upload from at or before the account-erasure cutoff",
    );
  });

  it("rejects a whitespace-only MinIO secret before worker startup", () => {
    vi.stubEnv("POSTGRES_PASSWORD", " ");

    expect(() => createPeerDbStagingStorageFromEnv()).toThrow("POSTGRES_PASSWORD is required");
  });

  it("rejects missing boundary marker PUT identity evidence", async () => {
    await expect(
      s3StorageWithResponses({}).createBoundaryMarker("account-erasure-boundaries/request"),
    ).rejects.toThrow("PeerDB staging boundary marker PUT did not return an ETag");
  });

  it("rejects a boundary marker that changes between PUT and HEAD", async () => {
    await expect(
      s3StorageWithResponses(
        { ETag: '"put-etag"' },
        {
          ContentLength: 0,
          ETag: '"head-etag"',
          LastModified: cutoff,
        },
      ).createBoundaryMarker("account-erasure-boundaries/request"),
    ).rejects.toThrow("PeerDB staging boundary marker changed between PUT and HEAD");
  });

  it("rejects a boundary marker HEAD without its storage timestamp", async () => {
    await expect(
      s3StorageWithResponses(
        { ETag: '"boundary-etag"' },
        {
          ContentLength: 0,
          ETag: '"boundary-etag"',
        },
      ).createBoundaryMarker("account-erasure-boundaries/request"),
    ).rejects.toThrow("PeerDB staging boundary marker HEAD returned invalid object evidence");
  });
});
