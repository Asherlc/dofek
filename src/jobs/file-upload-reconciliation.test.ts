import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileUpload } from "../db/file-upload.ts";
import type { ImportUploadStorage } from "../file-upload-storage.ts";

const repository = vi.hoisted(() => ({
  expire: vi.fn(),
  objectKeyExists: vi.fn(async () => false),
  list: vi.fn(async (): Promise<FileUpload[]> => []),
  queue: vi.fn(),
  requeue: vi.fn(),
}));

vi.mock("../db/file-upload.ts", () => ({
  expireFileUpload: repository.expire,
  fileUploadObjectKeyExists: repository.objectKeyExists,
  listFileUploadsForReconciliation: repository.list,
  queueCompletedFileUpload: repository.queue,
  requeueStuckFileUpload: repository.requeue,
}));

const { reconcileFileUploads } = await import("./file-upload-reconciliation.ts");

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

const database = { execute: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  repository.list.mockResolvedValue([]);
  repository.objectKeyExists.mockResolvedValue(false);
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
  });

  it("deletes aged R2 objects without a database upload", async () => {
    const objectStorage = storage();
    vi.mocked(objectStorage.listObjects).mockResolvedValue([
      { objectKey: "imports/orphan/source", lastModified: new Date(0) },
    ]);

    await reconcileFileUploads(database, objectStorage);

    expect(objectStorage.deleteObject).toHaveBeenCalledWith("imports/orphan/source");
  });
});
