import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileUpload } from "../db/file-upload.ts";
import type { ImportUploadStorage } from "../file-upload-storage.ts";

const repository = vi.hoisted(() => ({
  expire: vi.fn(async () => true),
  objectKeyExists: vi.fn(async () => false),
  list: vi.fn(async (): Promise<FileUpload[]> => []),
  markObjectDeleted: vi.fn(),
  queue: vi.fn(),
  requeue: vi.fn(async () => true),
  withLocked: vi.fn(async (database, uploadId, operation) => {
    const listed = await repository.list.mock.results.at(-1)?.value;
    const locked = listed?.find((candidate: FileUpload) => candidate.id === uploadId);
    if (!locked) throw new Error(`Upload ${uploadId} was not found`);
    return operation(database, locked);
  }),
  lifecycle: vi.fn(),
  reconciliation: vi.fn(),
  captureException: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../db/file-upload.ts", () => ({
  expireFileUpload: repository.expire,
  fileUploadObjectKeyExists: repository.objectKeyExists,
  listFileUploadsForReconciliation: repository.list,
  markFileUploadObjectDeleted: repository.markObjectDeleted,
  queueCompletedFileUpload: repository.queue,
  requeueStuckFileUpload: repository.requeue,
  withLockedFileUpload: repository.withLocked,
}));
vi.mock("../file-upload-metrics.ts", () => ({
  fileUploadLifecycleTotal: { add: repository.lifecycle },
  fileUploadReconciliationTotal: { add: repository.reconciliation },
}));
vi.mock("../lib/error-reporting.ts", () => ({
  captureException: repository.captureException,
}));
vi.mock("../logger.ts", () => ({ logger: { error: repository.logError } }));

const { reconcileFileUploads, startFileUploadReconciler } = await import(
  "./file-upload-reconciliation.ts"
);

function upload(overrides: Partial<FileUpload>): FileUpload {
  return {
    id: "00000000-0000-4000-8000-0000000000f1",
    userId: "00000000-0000-4000-8000-0000000000f2",
    importType: "garmin-dump",
    objectKey: "imports/user/upload/source",
    originalFilename: "garmin.zip",
    contentType: "application/zip",
    expectedSizeBytes: 10,
    expectedSha256: "a".repeat(64),
    verifiedSha256: null,
    r2MultipartUploadId: null,
    state: "uploaded",
    version: 1,
    partSizeBytes: 5 * 1024 * 1024,
    completionParts: null,
    importJobId: null,
    since: new Date(0),
    weightUnit: null,
    progressPercent: 0,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    expiresAt: new Date(Date.now() + 60_000),
    completedAt: null,
    objectDeletedAt: null,
    ...overrides,
  };
}

function storage(): ImportUploadStorage {
  return {
    abortMultipartUpload: vi.fn(),
    authorizeUploadPart: vi.fn(),
    completeMultipartUpload: vi.fn(),
    createMultipartUpload: vi.fn(),
    deleteObject: vi.fn(),
    getObjectStream: vi.fn(),
    headObject: vi.fn(async () => ({ sizeBytes: 10 })),
    listObjects: vi.fn(async () => []),
    listParts: vi.fn(),
  };
}

const database = {
  execute: vi.fn(),
  transaction: vi.fn(async (operation) => operation(database)),
};

beforeEach(() => {
  vi.clearAllMocks();
  repository.list.mockResolvedValue([]);
  repository.objectKeyExists.mockResolvedValue(false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reconcileFileUploads", () => {
  it("aborts and expires stale multipart uploads", async () => {
    const stale = upload({
      state: "uploading",
      r2MultipartUploadId: "multipart-id",
      expiresAt: new Date(0),
    });
    repository.list.mockResolvedValue([stale]);
    const objectStorage = storage();

    await reconcileFileUploads(database, objectStorage);

    expect(objectStorage.abortMultipartUpload).toHaveBeenCalledWith(
      stale.objectKey,
      "multipart-id",
    );
    expect(repository.expire).toHaveBeenCalledWith(database, stale.id);
    expect(repository.lifecycle).toHaveBeenCalledWith(1, {
      state: "expired",
      import_type: "garmin-dump",
    });
    expect(repository.reconciliation).toHaveBeenCalledWith(1, {
      repair: "expired_multipart",
    });
  });

  it("expires initiated uploads without trying to abort a multipart upload", async () => {
    const stale = upload({ state: "initiated", expiresAt: new Date(0) });
    repository.list.mockResolvedValue([stale]);
    const objectStorage = storage();

    await reconcileFileUploads(database, objectStorage);

    expect(objectStorage.abortMultipartUpload).not.toHaveBeenCalled();
    expect(repository.expire).toHaveBeenCalledWith(database, stale.id);
    expect(objectStorage.deleteObject).not.toHaveBeenCalledWith(stale.objectKey);
  });

  it("deletes a completed object when an expired multipart upload can no longer be aborted", async () => {
    const stale = upload({
      state: "uploading",
      r2MultipartUploadId: "completed-multipart-id",
      expiresAt: new Date(0),
    });
    repository.list.mockResolvedValue([stale]);
    const objectStorage = storage();
    const abortError = new Error("NoSuchUpload");
    vi.mocked(objectStorage.abortMultipartUpload).mockRejectedValueOnce(abortError);

    await reconcileFileUploads(database, objectStorage);

    expect(objectStorage.headObject).toHaveBeenCalledWith(stale.objectKey);
    expect(objectStorage.deleteObject).toHaveBeenCalledWith(stale.objectKey);
    expect(repository.expire).toHaveBeenCalledWith(database, stale.id);
    expect(repository.captureException).toHaveBeenCalledWith(abortError, {
      tags: {
        source: "file-upload-reconciliation",
        repairKind: "completed_multipart",
      },
      extra: { uploadId: stale.id },
    });
  });

  it("queues uploaded objects and requeues stuck processing", async () => {
    const uploaded = upload({});
    const stuck = upload({ id: "00000000-0000-4000-8000-0000000000f3", state: "processing" });
    repository.list.mockResolvedValue([uploaded, stuck]);

    await reconcileFileUploads(database, storage());

    expect(repository.queue).toHaveBeenCalledWith(database, uploaded.id, uploaded.userId, {
      importJobId: `file-import-${uploaded.id}`,
      objectSizeBytes: 10,
    });
    expect(repository.requeue).toHaveBeenCalledWith(database, stuck.id);
    expect(repository.reconciliation).toHaveBeenCalledWith(1, {
      repair: "uploaded_without_outbox",
    });
    expect(repository.reconciliation).toHaveBeenCalledWith(1, { repair: "stuck_processing" });
  });

  it("deletes terminal upload objects from storage", async () => {
    const completed = upload({ state: "completed" });
    repository.list.mockResolvedValue([completed]);
    const objectStorage = storage();

    await reconcileFileUploads(database, objectStorage);

    expect(objectStorage.deleteObject).toHaveBeenCalledWith(completed.objectKey);
    expect(repository.markObjectDeleted).toHaveBeenCalledWith(database, completed.id);
  });

  it("does not delete a terminal upload whose object was deleted before the row lock", async () => {
    const completed = upload({ state: "completed" });
    repository.list.mockResolvedValue([completed]);
    repository.withLocked.mockImplementationOnce(async (transaction, _uploadId, operation) =>
      operation(transaction, upload({ state: "completed", objectDeletedAt: new Date() })),
    );
    const objectStorage = storage();

    await reconcileFileUploads(database, objectStorage);

    expect(objectStorage.deleteObject).not.toHaveBeenCalled();
    expect(repository.markObjectDeleted).not.toHaveBeenCalled();
  });

  it("skips expired repair metrics when the upload already transitioned", async () => {
    const stale = upload({
      state: "uploading",
      r2MultipartUploadId: "multipart-id",
      expiresAt: new Date(0),
    });
    repository.list.mockResolvedValue([stale]);
    repository.expire.mockResolvedValueOnce(false);
    const objectStorage = storage();

    await reconcileFileUploads(database, objectStorage);

    expect(objectStorage.abortMultipartUpload).toHaveBeenCalledWith(
      stale.objectKey,
      "multipart-id",
    );
    expect(repository.expire).toHaveBeenCalledWith(database, stale.id);
    expect(repository.lifecycle).not.toHaveBeenCalled();
    expect(repository.reconciliation).not.toHaveBeenCalled();
  });

  it("skips stuck-processing repair metrics when the upload already transitioned", async () => {
    const stuck = upload({ id: "00000000-0000-4000-8000-0000000000f3", state: "processing" });
    repository.list.mockResolvedValue([stuck]);
    repository.requeue.mockResolvedValueOnce(false);

    await reconcileFileUploads(database, storage());

    expect(repository.requeue).toHaveBeenCalledWith(database, stuck.id);
    expect(repository.reconciliation).not.toHaveBeenCalledWith(1, {
      repair: "stuck_processing",
    });
  });

  it("continues reconciling uploads after one upload fails", async () => {
    const failedUpload = upload({ state: "uploaded" });
    const stuckUpload = upload({
      id: "00000000-0000-4000-8000-0000000000f3",
      state: "processing",
    });
    repository.list.mockResolvedValue([failedUpload, stuckUpload]);
    const objectStorage = storage();
    vi.mocked(objectStorage.headObject).mockRejectedValue(new Error("R2 is unavailable"));

    await reconcileFileUploads(database, objectStorage);

    expect(repository.requeue).toHaveBeenCalledWith(database, stuckUpload.id);
    expect(repository.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: {
        source: "file-upload-reconciliation",
        repairKind: "upload",
      },
      extra: { uploadId: failedUpload.id },
    });
  });

  it("deletes aged R2 objects without a database upload", async () => {
    const objectStorage = storage();
    vi.mocked(objectStorage.listObjects).mockResolvedValue([
      { objectKey: "imports/orphan/source", lastModified: new Date(0) },
    ]);

    await reconcileFileUploads(database, objectStorage);

    expect(objectStorage.deleteObject).toHaveBeenCalledWith("imports/orphan/source");
    expect(repository.reconciliation).toHaveBeenCalledWith(1, { repair: "orphaned_object" });
  });

  it("keeps recent objects and aged objects that still exist in the database", async () => {
    const objectStorage = storage();
    vi.mocked(objectStorage.listObjects).mockResolvedValue([
      { objectKey: "imports/recent/source", lastModified: new Date() },
      { objectKey: "imports/known/source", lastModified: new Date(0) },
    ]);
    repository.objectKeyExists.mockResolvedValue(true);

    await reconcileFileUploads(database, objectStorage);

    expect(repository.objectKeyExists).toHaveBeenCalledOnce();
    expect(repository.objectKeyExists).toHaveBeenCalledWith(database, "imports/known/source");
    expect(objectStorage.deleteObject).not.toHaveBeenCalled();
  });

  it("continues reconciling orphan objects after one object fails", async () => {
    const objectStorage = storage();
    vi.mocked(objectStorage.listObjects).mockResolvedValue([
      { objectKey: "imports/failing/source", lastModified: new Date(0) },
      { objectKey: "imports/orphan/source", lastModified: new Date(0) },
    ]);
    repository.objectKeyExists
      .mockRejectedValueOnce(new Error("database lookup failed"))
      .mockResolvedValueOnce(false);

    await reconcileFileUploads(database, objectStorage);

    expect(objectStorage.deleteObject).toHaveBeenCalledWith("imports/orphan/source");
    expect(repository.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: {
        source: "file-upload-reconciliation",
        repairKind: "orphan",
      },
      extra: { objectKey: "imports/failing/source" },
    });
  });

  it("runs immediately and on its interval until closed", async () => {
    vi.useFakeTimers();
    const objectStorage = storage();

    const reconciler = startFileUploadReconciler(database, objectStorage);
    await vi.waitFor(() => expect(repository.list).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(15 * 60 * 1_000);
    expect(repository.list).toHaveBeenCalledTimes(2);

    await reconciler.close();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1_000);
    expect(repository.list).toHaveBeenCalledTimes(2);
  });

  it("reports reconciliation failures", async () => {
    repository.list.mockRejectedValue(new Error("database unavailable"));

    const reconciler = startFileUploadReconciler(database, storage());
    await vi.waitFor(() => expect(repository.captureException).toHaveBeenCalledOnce());
    await reconciler.close();

    expect(repository.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { source: "file-upload-reconciliation" },
    });
    expect(repository.logError).toHaveBeenCalledWith(
      "[file-upload-reconciliation] Failed: Error: database unavailable",
    );
  });
});
