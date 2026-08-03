import { describe, expect, it, vi } from "vitest";
import {
  type BackupMultipartUploadPage,
  type BackupObjectPage,
  type DatabaseBackupStorage,
  sweepExpiredDatabaseBackups,
  verifyAccountErasureBackupRetention,
} from "./backup-retention.ts";

const requestedAt = new Date("2026-07-01T00:00:00.000Z");
const scrubbedAt = new Date("2026-07-08T00:00:00.000Z");
const beforeScrub = "Health-20260707-235959-10000000-0000-4000-8000-000000001994";
const atScrub = "Health-20260708-000000-20000000-0000-4000-8000-000000001994";
const afterScrub = "Health-20260720-000001-30000000-0000-4000-8000-000000001994";

interface StorageOptions {
  onAbortMultipartUpload?(key: string, uploadId: string, objects: Set<string>): void;
  preserveDeletedObjects?: boolean;
}

function storage(
  initialObjects: readonly string[],
  initialUploads: readonly { key: string; uploadId: string }[] = [],
  options: StorageOptions = {},
) {
  const objects = new Set(initialObjects);
  const uploads = new Map(
    initialUploads.map((upload) => [`${upload.key}\0${upload.uploadId}`, upload] as const),
  );
  const listPage = vi.fn<DatabaseBackupStorage["listPage"]>(
    async (): Promise<BackupObjectPage> => ({
      objects: [...objects].map((key) => ({ key })),
    }),
  );
  const listMultipartUploads = vi.fn<DatabaseBackupStorage["listMultipartUploads"]>(
    async (): Promise<BackupMultipartUploadPage> => ({
      uploads: [...uploads.values()],
    }),
  );
  const deleteObjects = vi.fn<DatabaseBackupStorage["deleteObjects"]>(async (keys) => {
    if (!options.preserveDeletedObjects) {
      for (const key of keys) objects.delete(key);
    }
    return { errors: [] };
  });
  const abortMultipartUpload = vi.fn<DatabaseBackupStorage["abortMultipartUpload"]>(
    async (key, uploadId) => {
      uploads.delete(`${key}\0${uploadId}`);
      options.onAbortMultipartUpload?.(key, uploadId, objects);
    },
  );
  return {
    abortMultipartUpload,
    deleteObjects,
    listMultipartUploads,
    listPage,
    objects,
    uploads,
  };
}

describe("verifyAccountErasureBackupRetention", () => {
  it("uses the canonical snapshot start and deletes every Databasus companion", async () => {
    const backupStorage = storage([
      beforeScrub,
      `${beforeScrub}.metadata`,
      `${beforeScrub}.part000001`,
      `${beforeScrub}.part000002`,
      `${beforeScrub}.parts`,
      `${beforeScrub}.metadata.part000001`,
      `${beforeScrub}.metadata.parts`,
      atScrub,
      afterScrub,
    ]);

    await expect(
      verifyAccountErasureBackupRetention(backupStorage, {
        maxSweepPasses: 3,
        now: new Date("2026-07-29T00:00:01.000Z"),
        piiScrubbedAt: scrubbedAt,
        requestedAt,
        retentionDays: 21,
      }),
    ).resolves.toEqual({ deletedObjects: 8 });

    expect(backupStorage.deleteObjects).toHaveBeenCalledWith([
      beforeScrub,
      `${beforeScrub}.metadata`,
      `${beforeScrub}.part000001`,
      `${beforeScrub}.part000002`,
      `${beforeScrub}.parts`,
      `${beforeScrub}.metadata.part000001`,
      `${beforeScrub}.metadata.parts`,
      atScrub,
    ]);
    expect(backupStorage.objects).toEqual(new Set([afterScrub]));
  });

  it("deletes a young backup when active-store PII was scrubbed late", async () => {
    const lateScrubbedAt = new Date("2026-07-30T00:00:00.000Z");
    const youngPreScrub = "Health-20260729-235959-40000000-0000-4000-8000-000000001994";
    const backupStorage = storage([youngPreScrub]);

    await expect(
      verifyAccountErasureBackupRetention(backupStorage, {
        maxSweepPasses: 3,
        now: new Date("2026-07-31T00:00:00.000Z"),
        piiScrubbedAt: lateScrubbedAt,
        requestedAt,
        retentionDays: 21,
      }),
    ).resolves.toEqual({ deletedObjects: 1 });
  });

  it("aborts pre-scrub multipart uploads and catches their completion race", async () => {
    const uploadId = "pre-scrub-upload";
    const backupStorage = storage([], [{ key: beforeScrub, uploadId }], {
      onAbortMultipartUpload: (key, _uploadId, objects) => {
        objects.add(key);
      },
    });

    await expect(
      verifyAccountErasureBackupRetention(backupStorage, {
        maxSweepPasses: 3,
        now: new Date("2026-07-29T00:00:01.000Z"),
        piiScrubbedAt: scrubbedAt,
        requestedAt,
        retentionDays: 21,
      }),
    ).resolves.toEqual({ deletedObjects: 1 });

    expect(backupStorage.abortMultipartUpload).toHaveBeenCalledWith(beforeScrub, uploadId);
    expect(backupStorage.deleteObjects).toHaveBeenCalledWith([beforeScrub]);
    expect(backupStorage.objects).toEqual(new Set());
  });

  it("accepts the exact managed manual-backup key and uses its embedded timestamp", async () => {
    const manualBackup = "manual/health-pre-metric-stream-drop-20260609T182251Z.dump";
    const backupStorage = storage([manualBackup]);

    await expect(
      verifyAccountErasureBackupRetention(backupStorage, {
        maxSweepPasses: 3,
        now: new Date("2026-07-29T00:00:01.000Z"),
        piiScrubbedAt: scrubbedAt,
        requestedAt,
        retentionDays: 21,
      }),
    ).resolves.toEqual({ deletedObjects: 1 });

    expect(backupStorage.deleteObjects).toHaveBeenCalledWith([manualBackup]);
  });

  it("fails closed on unknown object keys before deleting them", async () => {
    const backupStorage = storage(["unmanaged-backup.sql.gz", beforeScrub]);

    await expect(
      verifyAccountErasureBackupRetention(backupStorage, {
        maxSweepPasses: 3,
        now: new Date("2026-07-29T00:00:01.000Z"),
        piiScrubbedAt: scrubbedAt,
        requestedAt,
        retentionDays: 21,
      }),
    ).rejects.toThrow("Unknown database backup object key: unmanaged-backup.sql.gz");

    expect(backupStorage.deleteObjects).not.toHaveBeenCalled();
    expect(backupStorage.abortMultipartUpload).not.toHaveBeenCalled();
  });

  it("fails closed on unknown multipart keys before any cleanup mutation", async () => {
    const backupStorage = storage(
      [beforeScrub],
      [{ key: "unmanaged-upload.sql.gz", uploadId: "unknown-upload" }],
    );

    await expect(
      verifyAccountErasureBackupRetention(backupStorage, {
        maxSweepPasses: 3,
        now: new Date("2026-07-29T00:00:01.000Z"),
        piiScrubbedAt: scrubbedAt,
        requestedAt,
        retentionDays: 21,
      }),
    ).rejects.toThrow("Unknown database backup object key: unmanaged-upload.sql.gz");

    expect(backupStorage.deleteObjects).not.toHaveBeenCalled();
    expect(backupStorage.abortMultipartUpload).not.toHaveBeenCalled();
  });

  it("fails closed on malformed calendar timestamps", async () => {
    const malformed = "Health-20260231-120000-50000000-0000-4000-8000-000000001994";
    const backupStorage = storage([malformed]);

    await expect(
      verifyAccountErasureBackupRetention(backupStorage, {
        maxSweepPasses: 3,
        now: new Date("2026-07-29T00:00:01.000Z"),
        piiScrubbedAt: scrubbedAt,
        requestedAt,
        retentionDays: 21,
      }),
    ).rejects.toThrow(`Unknown database backup object key: ${malformed}`);
  });

  it("rejects a retention setting that cannot meet the 30-day request SLA", async () => {
    await expect(
      verifyAccountErasureBackupRetention(storage([]), {
        maxSweepPasses: 3,
        now: new Date("2026-07-31T00:00:00.000Z"),
        piiScrubbedAt: scrubbedAt,
        requestedAt,
        retentionDays: 22,
      }),
    ).rejects.toThrow("retentionDays");
  });

  it("accepts equal request, scrub, and verification timestamps", async () => {
    await expect(
      verifyAccountErasureBackupRetention(storage([]), {
        maxSweepPasses: 1,
        now: requestedAt,
        piiScrubbedAt: requestedAt,
        requestedAt,
        retentionDays: 21,
      }),
    ).resolves.toEqual({ deletedObjects: 0 });
  });

  it("sweeps backups using the general retention options", async () => {
    const backupStorage = storage([beforeScrub, afterScrub]);

    await expect(
      sweepExpiredDatabaseBackups(backupStorage, {
        maxSweepPasses: 3,
        now: new Date("2026-07-29T00:00:01.000Z"),
        retentionDays: 21,
      }),
    ).resolves.toEqual({ deletedObjects: 1 });

    expect(backupStorage.objects).toEqual(new Set([afterScrub]));
  });

  it("follows object-list continuation tokens", async () => {
    const secondPage = `${beforeScrub}.metadata`;
    const backupStorage = storage([beforeScrub, secondPage]);
    backupStorage.listPage
      .mockImplementationOnce(
        async (): Promise<BackupObjectPage> => ({
          nextContinuationToken: "page-2",
          objects: [{ key: beforeScrub }],
        }),
      )
      .mockImplementationOnce(
        async (): Promise<BackupObjectPage> => ({
          objects: [{ key: secondPage }],
        }),
      );

    await expect(
      verifyAccountErasureBackupRetention(backupStorage, {
        maxSweepPasses: 3,
        now: new Date("2026-07-29T00:00:01.000Z"),
        piiScrubbedAt: scrubbedAt,
        requestedAt,
        retentionDays: 21,
      }),
    ).resolves.toEqual({ deletedObjects: 2 });

    expect(backupStorage.listPage).toHaveBeenCalledWith(undefined);
    expect(backupStorage.listPage).toHaveBeenCalledWith("page-2");
  });

  it.each([
    ["empty continuation token", { nextContinuationToken: "" }],
    ["repeated continuation token", { nextContinuationToken: "same-token" }],
  ])("rejects an invalid object-list continuation (%s)", async (_name, page) => {
    const backupStorage = storage([]);
    if (page.nextContinuationToken === "same-token") {
      backupStorage.listPage
        .mockImplementationOnce(async () => ({ objects: [], ...page }))
        .mockImplementationOnce(async () => ({ objects: [], ...page }));
    } else {
      backupStorage.listPage.mockImplementationOnce(async () => ({ objects: [], ...page }));
    }

    await expect(
      verifyAccountErasureBackupRetention(backupStorage, {
        maxSweepPasses: 3,
        now: new Date("2026-07-29T00:00:01.000Z"),
        piiScrubbedAt: scrubbedAt,
        requestedAt,
        retentionDays: 21,
      }),
    ).rejects.toThrow(
      page.nextContinuationToken === ""
        ? "truncated without a continuation token"
        : "repeated a continuation token",
    );
  });

  it("follows multipart continuation markers", async () => {
    const upload = { key: beforeScrub, uploadId: "upload-1" };
    const backupStorage = storage([], [upload], {
      onAbortMultipartUpload: (key, _uploadId, objects) => {
        objects.add(key);
      },
    });
    backupStorage.listMultipartUploads
      .mockImplementationOnce(
        async (): Promise<BackupMultipartUploadPage> => ({
          nextKeyMarker: "key-2",
          nextUploadIdMarker: "upload-2",
          uploads: [upload],
        }),
      )
      .mockImplementationOnce(
        async (): Promise<BackupMultipartUploadPage> => ({
          uploads: [],
        }),
      );

    await expect(
      verifyAccountErasureBackupRetention(backupStorage, {
        maxSweepPasses: 3,
        now: new Date("2026-07-29T00:00:01.000Z"),
        piiScrubbedAt: scrubbedAt,
        requestedAt,
        retentionDays: 21,
      }),
    ).resolves.toEqual({ deletedObjects: 1 });

    expect(backupStorage.listMultipartUploads).toHaveBeenCalledWith(undefined, undefined);
    expect(backupStorage.listMultipartUploads).toHaveBeenCalledWith("key-2", "upload-2");
  });

  it.each([
    ["mismatched markers", { nextKeyMarker: "key-2" }],
    ["empty key marker", { nextKeyMarker: "", nextUploadIdMarker: "upload-2" }],
    ["empty upload marker", { nextKeyMarker: "key-2", nextUploadIdMarker: "" }],
  ])("rejects invalid multipart continuation markers (%s)", async (_name, page) => {
    const backupStorage = storage([]);
    backupStorage.listMultipartUploads.mockImplementationOnce(async () => ({
      uploads: [],
      ...page,
    }));

    await expect(
      verifyAccountErasureBackupRetention(backupStorage, {
        maxSweepPasses: 3,
        now: new Date("2026-07-29T00:00:01.000Z"),
        piiScrubbedAt: scrubbedAt,
        requestedAt,
        retentionDays: 21,
      }),
    ).rejects.toThrow("truncated without continuation markers");
  });

  it("rejects repeated multipart continuation markers", async () => {
    const backupStorage = storage([]);
    backupStorage.listMultipartUploads
      .mockImplementationOnce(async () => ({
        nextKeyMarker: "key-2",
        nextUploadIdMarker: "upload-2",
        uploads: [],
      }))
      .mockImplementationOnce(async () => ({
        nextKeyMarker: "key-2",
        nextUploadIdMarker: "upload-2",
        uploads: [],
      }));

    await expect(
      verifyAccountErasureBackupRetention(backupStorage, {
        maxSweepPasses: 3,
        now: new Date("2026-07-29T00:00:01.000Z"),
        piiScrubbedAt: scrubbedAt,
        requestedAt,
        retentionDays: 21,
      }),
    ).rejects.toThrow("repeated continuation markers");
  });

  it("deletes objects in bounded batches", async () => {
    const objects = Array.from(
      { length: 1_001 },
      (_, index) =>
        `Health-20260701-000000-10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    );
    const backupStorage = storage(objects);

    await expect(
      verifyAccountErasureBackupRetention(backupStorage, {
        maxSweepPasses: 3,
        now: new Date("2026-07-29T00:00:01.000Z"),
        piiScrubbedAt: scrubbedAt,
        requestedAt,
        retentionDays: 21,
      }),
    ).resolves.toEqual({ deletedObjects: 1_001 });

    expect(backupStorage.deleteObjects).toHaveBeenCalledTimes(2);
    expect(backupStorage.deleteObjects.mock.calls[0]?.[0]).toHaveLength(1_000);
    expect(backupStorage.deleteObjects.mock.calls[1]?.[0]).toHaveLength(1);
  });

  it("reports sorted object-deletion errors", async () => {
    const backupStorage = storage([beforeScrub, atScrub]);
    backupStorage.deleteObjects.mockResolvedValue({
      errors: [
        { code: "Z_ERROR", key: atScrub },
        { code: "A_ERROR", key: beforeScrub },
      ],
    });

    await expect(
      verifyAccountErasureBackupRetention(backupStorage, {
        maxSweepPasses: 3,
        now: new Date("2026-07-29T00:00:01.000Z"),
        piiScrubbedAt: scrubbedAt,
        requestedAt,
        retentionDays: 21,
      }),
    ).rejects.toThrow(
      `R2 database backup deletion returned 2 object error(s): A_ERROR (${beforeScrub}), Z_ERROR (${atScrub})`,
    );
  });

  it("fails when expired data remains after the configured sweep passes", async () => {
    const backupStorage = storage([beforeScrub], [], { preserveDeletedObjects: true });

    await expect(
      verifyAccountErasureBackupRetention(backupStorage, {
        maxSweepPasses: 2,
        now: new Date("2026-07-29T00:00:01.000Z"),
        piiScrubbedAt: scrubbedAt,
        requestedAt,
        retentionDays: 21,
      }),
    ).rejects.toThrow("after 2 pass(es)");
    expect(backupStorage.deleteObjects).toHaveBeenCalledTimes(2);
  });
});
