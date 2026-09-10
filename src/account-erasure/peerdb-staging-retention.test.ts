import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capturePeerDbStagingInventory,
  createPeerDbStagingStorageFromEnv,
  type PeerDbStagingStorage,
  peerDbStagingInventoriesEqual,
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
  ])(
    "rejects a one-day lifecycle rule scoped by $restriction",
    async ({ filter, legacyPrefix }) => {
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
    },
  );

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

describe("PeerDB staging inventory", () => {
  it("captures and sorts object and multipart inventory while tracking the latest timestamp", async () => {
    const objects = [
      stagingObject(new Date("2026-08-02T10:00:00.000Z"), "object-b"),
      stagingObject(new Date("2026-08-02T11:00:00.000Z"), "object-a"),
    ];
    const uploads = [
      stagingUpload(new Date("2026-08-02T09:00:00.000Z"), "upload-b"),
      stagingUpload(new Date("2026-08-02T12:00:00.000Z"), "upload-a"),
    ];
    const inventory = await capturePeerDbStagingInventory(
      storage({
        listMultipartUploads: vi.fn(async () => ({
          isTruncated: false,
          nextKeyMarker: null,
          nextUploadIdMarker: null,
          uploads,
        })),
        listObjects: vi.fn(async () => ({
          isTruncated: false,
          nextContinuationToken: null,
          objects,
        })),
      }),
    );

    expect(inventory.objects.map((object) => object.key)).toEqual(["object-a", "object-b"]);
    expect(inventory.multipartUploads.map((upload) => upload.key)).toEqual([
      "upload-a",
      "upload-b",
    ]);
    expect(inventory.latestStorageTimestamp).toEqual(new Date("2026-08-02T12:00:00.000Z"));
  });

  it("compares every inventory evidence field", () => {
    const timestamp = new Date("2026-08-02T12:00:00.000Z");
    const inventory = {
      latestStorageTimestamp: timestamp,
      multipartCursors: [
        {
          isTruncated: false,
          keyMarker: null,
          nextKeyMarker: null,
          nextUploadIdMarker: null,
          uploadIdMarker: null,
        },
      ],
      multipartUploads: [
        {
          initiated: timestamp,
          key: "upload",
          uploadId: "upload-id",
        },
      ],
      objectCursors: [
        {
          continuationToken: null,
          isTruncated: false,
          nextContinuationToken: null,
        },
      ],
      objects: [{ eTag: "etag", key: "object", lastModified: timestamp }],
    };

    expect(peerDbStagingInventoriesEqual(inventory, inventory)).toBe(true);
    expect(
      peerDbStagingInventoriesEqual(inventory, {
        ...inventory,
        latestStorageTimestamp: new Date(timestamp.getTime() + 1),
      }),
    ).toBe(false);
    expect(
      peerDbStagingInventoriesEqual(inventory, {
        ...inventory,
        objectCursors: [],
      }),
    ).toBe(false);
    expect(
      peerDbStagingInventoriesEqual(inventory, {
        ...inventory,
        multipartCursors: [],
      }),
    ).toBe(false);
    expect(
      peerDbStagingInventoriesEqual(inventory, {
        ...inventory,
        objects: [{ eTag: "other-etag", key: "object", lastModified: timestamp }],
      }),
    ).toBe(false);
    expect(
      peerDbStagingInventoriesEqual(inventory, {
        ...inventory,
        objects: [{ eTag: "etag", key: "other-object", lastModified: timestamp }],
      }),
    ).toBe(false);
    expect(
      peerDbStagingInventoriesEqual(inventory, {
        ...inventory,
        objects: [{ eTag: "etag", key: "object", lastModified: new Date(timestamp.getTime() + 1) }],
      }),
    ).toBe(false);
    expect(
      peerDbStagingInventoriesEqual(inventory, {
        ...inventory,
        multipartUploads: [{ initiated: timestamp, key: "other-upload", uploadId: "upload-id" }],
      }),
    ).toBe(false);
    expect(
      peerDbStagingInventoriesEqual(inventory, {
        ...inventory,
        multipartUploads: [{ initiated: timestamp, key: "upload", uploadId: "other-id" }],
      }),
    ).toBe(false);
    expect(
      peerDbStagingInventoriesEqual(inventory, {
        ...inventory,
        multipartUploads: [
          { initiated: new Date(timestamp.getTime() + 1), key: "upload", uploadId: "upload-id" },
        ],
      }),
    ).toBe(false);
  });
});

describe("S3PeerDbStagingStorage", () => {
  it("maps lifecycle, versioning, multipart, and object responses", async () => {
    const lifecycle = s3StorageWithResponses({
      Rules: [
        {
          Expiration: { Days: 1 },
          Filter: {
            And: { Prefix: "" },
            ObjectSizeGreaterThan: 10,
            ObjectSizeLessThan: 100,
            Prefix: "objects/",
            Tag: { Key: "kind", Value: "stage" },
          },
          ID: "rule",
          Prefix: "legacy/",
          Status: "Enabled",
        },
      ],
    });
    await expect(lifecycle.getLifecycleConfiguration()).resolves.toEqual({
      rules: [
        {
          expirationDays: 1,
          filter: {
            hasAnd: true,
            hasTag: true,
            objectSizeGreaterThan: 10,
            objectSizeLessThan: 100,
            prefix: "objects/",
          },
          id: "rule",
          legacyPrefix: "legacy/",
          status: "Enabled",
        },
      ],
    });

    await expect(
      s3StorageWithResponses({ Status: "Suspended" }).getVersioningStatus(),
    ).resolves.toBe("Suspended");
    await expect(s3StorageWithResponses({}).getVersioningStatus()).resolves.toBeNull();

    const initiated = new Date("2026-08-02T11:00:00.000Z");
    await expect(
      s3StorageWithResponses({
        IsTruncated: true,
        NextKeyMarker: "next-key",
        NextUploadIdMarker: "next-upload",
        Uploads: [{ Initiated: initiated, Key: "stage-key", UploadId: "upload-id" }],
      }).listMultipartUploads("key-marker", "upload-marker"),
    ).resolves.toEqual({
      isTruncated: true,
      nextKeyMarker: "next-key",
      nextUploadIdMarker: "next-upload",
      uploads: [{ initiated, key: "stage-key", uploadId: "upload-id" }],
    });
    await expect(s3StorageWithResponses({}).listMultipartUploads(null, null)).resolves.toEqual({
      isTruncated: false,
      nextKeyMarker: null,
      nextUploadIdMarker: null,
      uploads: [],
    });

    const lastModified = new Date("2026-08-02T11:00:00.000Z");
    await expect(
      s3StorageWithResponses({
        Contents: [{ ETag: '"etag"', Key: "stage-key", LastModified: lastModified }],
        IsTruncated: true,
        NextContinuationToken: "next-page",
      }).listObjects("page-token"),
    ).resolves.toEqual({
      isTruncated: true,
      nextContinuationToken: "next-page",
      objects: [{ eTag: '"etag"', key: "stage-key", lastModified }],
    });
    await expect(s3StorageWithResponses({}).listObjects(null)).resolves.toEqual({
      isTruncated: false,
      nextContinuationToken: null,
      objects: [],
    });
  });

  it("accepts a valid boundary marker and environment configuration", async () => {
    await expect(
      s3StorageWithResponses(
        { ETag: '"boundary-etag"' },
        { ContentLength: 0, ETag: '"boundary-etag"', LastModified: cutoff },
      ).createBoundaryMarker("account-erasure-boundaries/request"),
    ).resolves.toEqual({ eTag: '"boundary-etag"', lastModified: cutoff });

    vi.stubEnv("POSTGRES_PASSWORD", "password");
    vi.stubEnv("PEERDB_STAGE_S3_ACCESS_KEY_ID", "access");
    vi.stubEnv("PEERDB_STAGE_S3_ENDPOINT", "http://minio:9000");
    vi.stubEnv("PEERDB_STAGE_S3_BUCKET", "bucket");
    const configured = createPeerDbStagingStorageFromEnv();
    expect(configured.storage).toBeInstanceOf(S3PeerDbStagingStorage);
    configured.close();
  });
});
