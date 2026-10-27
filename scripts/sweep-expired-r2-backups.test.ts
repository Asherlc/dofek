import { describe, expect, it, vi } from "vitest";
import {
  type DatabaseBackupStorage,
  sweepExpiredDatabaseBackups,
} from "../src/account-erasure/backup-retention.ts";

const now = new Date("2026-07-26T12:00:00.000Z");
const expiredBackup = "Health-20260601-000000-60000000-0000-4000-8000-000000001994";
const retainedBackup = "Health-20260720-000000-70000000-0000-4000-8000-000000001994";

function emptyStorage(overrides: Partial<DatabaseBackupStorage> = {}): DatabaseBackupStorage {
  return {
    abortMultipartUpload: vi.fn(async () => undefined),
    deleteObjects: vi.fn(async () => ({ errors: [] })),
    listMultipartUploads: vi.fn(async () => ({ uploads: [] })),
    listPage: vi.fn(async () => ({ objects: [] })),
    ...overrides,
  };
}

describe("sweepExpiredDatabaseBackups", () => {
  it("deletes only snapshots beyond retention, including companion objects", async () => {
    const objects = new Set([
      expiredBackup,
      `${expiredBackup}.metadata`,
      `${expiredBackup}.part000001`,
      `${expiredBackup}.parts`,
      retainedBackup,
    ]);
    const deleteObjects = vi.fn<DatabaseBackupStorage["deleteObjects"]>(async (keys) => {
      for (const key of keys) objects.delete(key);
      return { errors: [] };
    });
    const backupStorage = emptyStorage({
      deleteObjects,
      listPage: vi.fn(async () => ({
        objects: [...objects].map((key) => ({ key })),
      })),
    });

    await expect(
      sweepExpiredDatabaseBackups(backupStorage, {
        maxSweepPasses: 3,
        now,
        retentionDays: 21,
      }),
    ).resolves.toEqual({ deletedObjects: 4 });

    expect(deleteObjects).toHaveBeenCalledWith([
      expiredBackup,
      `${expiredBackup}.metadata`,
      `${expiredBackup}.part000001`,
      `${expiredBackup}.parts`,
    ]);
    expect(objects).toEqual(new Set([retainedBackup]));
  });

  it("checks every object page before declaring verification complete", async () => {
    const listPage = vi
      .fn<DatabaseBackupStorage["listPage"]>()
      .mockResolvedValueOnce({
        nextContinuationToken: "page-2",
        objects: [{ key: retainedBackup }],
      })
      .mockResolvedValueOnce({
        objects: [{ key: expiredBackup }],
      })
      .mockResolvedValueOnce({
        nextContinuationToken: "verify-page-2",
        objects: [{ key: retainedBackup }],
      })
      .mockResolvedValueOnce({ objects: [] });
    const deleteObjects = vi
      .fn<DatabaseBackupStorage["deleteObjects"]>()
      .mockResolvedValue({ errors: [] });

    await expect(
      sweepExpiredDatabaseBackups(emptyStorage({ deleteObjects, listPage }), {
        maxSweepPasses: 3,
        now,
        retentionDays: 21,
      }),
    ).resolves.toEqual({ deletedObjects: 1 });

    expect(listPage.mock.calls.map(([token]) => token)).toEqual([
      undefined,
      "page-2",
      undefined,
      "verify-page-2",
    ]);
  });

  it("paginates multipart uploads and aborts only exact expired upload IDs", async () => {
    const firstUploadId = "first-upload";
    const secondUploadId = "second-upload";
    const listMultipartUploads = vi
      .fn<DatabaseBackupStorage["listMultipartUploads"]>()
      .mockResolvedValueOnce({
        nextKeyMarker: expiredBackup,
        nextUploadIdMarker: firstUploadId,
        uploads: [{ key: expiredBackup, uploadId: firstUploadId }],
      })
      .mockResolvedValueOnce({
        uploads: [
          { key: expiredBackup, uploadId: secondUploadId },
          { key: retainedBackup, uploadId: "retained-upload" },
        ],
      })
      .mockResolvedValueOnce({ uploads: [] });
    const abortMultipartUpload = vi.fn<DatabaseBackupStorage["abortMultipartUpload"]>(
      async () => undefined,
    );

    await expect(
      sweepExpiredDatabaseBackups(emptyStorage({ abortMultipartUpload, listMultipartUploads }), {
        maxSweepPasses: 3,
        now,
        retentionDays: 21,
      }),
    ).resolves.toEqual({ deletedObjects: 0 });

    expect(listMultipartUploads.mock.calls).toEqual([
      [undefined, undefined],
      [expiredBackup, firstUploadId],
      [undefined, undefined],
    ]);
    expect(abortMultipartUpload.mock.calls).toEqual([
      [expiredBackup, firstUploadId],
      [expiredBackup, secondUploadId],
    ]);
  });

  it("catches an expired upload that appears after an object deletion", async () => {
    const objects = new Set([expiredBackup]);
    const uploads = new Map<string, { key: string; uploadId: string }>();
    const uploadId = "racing-upload";
    const backupStorage = emptyStorage({
      abortMultipartUpload: vi.fn(async (key, currentUploadId) => {
        uploads.delete(`${key}\0${currentUploadId}`);
      }),
      deleteObjects: vi.fn(async (keys) => {
        for (const key of keys) objects.delete(key);
        uploads.set(`${expiredBackup}\0${uploadId}`, {
          key: expiredBackup,
          uploadId,
        });
        return { errors: [] };
      }),
      listMultipartUploads: vi.fn(async () => ({
        uploads: [...uploads.values()],
      })),
      listPage: vi.fn(async () => ({
        objects: [...objects].map((key) => ({ key })),
      })),
    });

    await expect(
      sweepExpiredDatabaseBackups(backupStorage, {
        maxSweepPasses: 3,
        now,
        retentionDays: 21,
      }),
    ).resolves.toEqual({ deletedObjects: 1 });

    expect(backupStorage.abortMultipartUpload).toHaveBeenCalledWith(expiredBackup, uploadId);
  });

  it("fails closed when an object continuation token repeats", async () => {
    const listPage = vi
      .fn<DatabaseBackupStorage["listPage"]>()
      .mockResolvedValueOnce({
        nextContinuationToken: "repeated-page",
        objects: [],
      })
      .mockResolvedValueOnce({
        nextContinuationToken: "repeated-page",
        objects: [],
      });

    await expect(
      sweepExpiredDatabaseBackups(emptyStorage({ listPage }), {
        maxSweepPasses: 3,
        now,
        retentionDays: 21,
      }),
    ).rejects.toThrow("R2 database backup listing repeated a continuation token");
  });

  it("fails closed when multipart continuation markers do not advance", async () => {
    const listMultipartUploads = vi
      .fn<DatabaseBackupStorage["listMultipartUploads"]>()
      .mockResolvedValue({
        nextKeyMarker: expiredBackup,
        nextUploadIdMarker: "repeated-upload",
        uploads: [],
      });

    await expect(
      sweepExpiredDatabaseBackups(emptyStorage({ listMultipartUploads }), {
        maxSweepPasses: 3,
        now,
        retentionDays: 21,
      }),
    ).rejects.toThrow("R2 database backup multipart listing repeated continuation markers");
  });

  it("fails on truncated multipart listings without both continuation markers", async () => {
    const listMultipartUploads = vi.fn<DatabaseBackupStorage["listMultipartUploads"]>(async () => ({
      nextKeyMarker: expiredBackup,
      uploads: [],
    }));

    await expect(
      sweepExpiredDatabaseBackups(emptyStorage({ listMultipartUploads }), {
        maxSweepPasses: 3,
        now,
        retentionDays: 21,
      }),
    ).rejects.toThrow(
      "R2 database backup multipart listing was truncated without continuation markers",
    );
  });

  it("fails on any per-object DeleteObjects error", async () => {
    const backupStorage = emptyStorage({
      deleteObjects: vi.fn(async () => ({
        errors: [{ code: "AccessDenied", key: expiredBackup }],
      })),
      listPage: vi.fn(async () => ({ objects: [{ key: expiredBackup }] })),
    });

    await expect(
      sweepExpiredDatabaseBackups(backupStorage, {
        maxSweepPasses: 3,
        now,
        retentionDays: 21,
      }),
    ).rejects.toThrow(
      `R2 database backup deletion returned 1 object error(s): AccessDenied (${expiredBackup})`,
    );
  });

  it("stops after bounded passes when expired objects remain", async () => {
    const backupStorage = emptyStorage({
      listPage: vi.fn(async () => ({ objects: [{ key: expiredBackup }] })),
    });

    await expect(
      sweepExpiredDatabaseBackups(backupStorage, {
        maxSweepPasses: 2,
        now,
        retentionDays: 21,
      }),
    ).rejects.toThrow(
      "R2 database backup sweep left 1 expired object(s) and 0 expired multipart upload(s) after 2 pass(es)",
    );

    expect(backupStorage.deleteObjects).toHaveBeenCalledTimes(2);
  });
});
