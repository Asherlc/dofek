import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileUpload } from "../db/file-upload.ts";
import type { SyncDatabase } from "../db/index.ts";
import type { ImportUploadStorage } from "../file-upload-storage.ts";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  progress: vi.fn(),
  processImport: vi.fn(),
}));

vi.mock("../db/file-upload.ts", () => ({
  claimFileUploadForProcessing: mocks.claim,
  completeFileUploadProcessing: mocks.complete,
  failFileUploadProcessing: mocks.fail,
  updateFileUploadProgress: mocks.progress,
}));

vi.mock("./process-import-job.ts", () => ({ processImportJob: mocks.processImport }));

const { processFileUploadImportJob } = await import("./process-file-upload-import-job.ts");

const body = Buffer.from("verified upload body");
const digest = createHash("sha256").update(body).digest("hex");
const uploadId = "00000000-0000-4000-8000-0000000000f4";
const database: SyncDatabase = {
  delete: vi.fn(),
  execute: vi.fn(),
  insert: vi.fn(),
  select: vi.fn(),
};

function upload(overrides: Partial<FileUpload> = {}): FileUpload {
  return {
    id: uploadId,
    userId: "00000000-0000-4000-8000-0000000000f5",
    importType: "strong-csv",
    objectKey: `imports/user/${uploadId}/source`,
    originalFilename: "strong.csv",
    contentType: "text/csv",
    expectedSizeBytes: body.length,
    expectedSha256: digest,
    verifiedSha256: null,
    r2MultipartUploadId: "multipart-1",
    state: "processing",
    version: 3,
    partSizeBytes: 16 * 1024 * 1024,
    completionParts: [{ partNumber: 1, etag: '"etag"' }],
    importJobId: `file-import-${uploadId}`,
    since: new Date(0),
    weightUnit: "kg",
    progressPercent: 0,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    completedAt: null,
    ...overrides,
  };
}

function job() {
  return {
    id: `file-import-${uploadId}`,
    queueQualifiedName: "bull:import",
    data: { uploadId, userId: upload().userId, importType: "strong-csv" as const },
    updateData: vi.fn(async () => undefined),
    moveToWaitingChildren: vi.fn(async () => false),
    getChildrenValues: vi.fn(async () => ({})),
    getIgnoredChildrenFailures: vi.fn(async () => ({})),
    extendLock: vi.fn(async () => undefined),
    updateProgress: vi.fn(async () => undefined),
    log: vi.fn(async () => undefined),
  };
}

function storageWithBody(uploadBody = body): ImportUploadStorage {
  return {
    abortMultipartUpload: vi.fn(async () => undefined),
    authorizeUploadPart: vi.fn(),
    completeMultipartUpload: vi.fn(async () => undefined),
    createMultipartUpload: vi.fn(),
    deleteObject: vi.fn(async () => undefined),
    getObjectStream: vi.fn(async () => Readable.from([uploadBody])),
    headObject: vi.fn(),
    listParts: vi.fn(),
    listObjects: vi.fn(async () => []),
  };
}

describe("processFileUploadImportJob", () => {
  let jobFilesDirectory: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    jobFilesDirectory = await mkdtemp(join(tmpdir(), "file-upload-worker-test-"));
    process.env.JOB_FILES_DIR = jobFilesDirectory;
    mocks.claim.mockResolvedValue(upload());
    mocks.processImport.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    delete process.env.JOB_FILES_DIR;
    await rm(jobFilesDirectory, { recursive: true, force: true });
  });

  it("verifies the full object before importing and records the digest", async () => {
    const storage = storageWithBody();

    await processFileUploadImportJob(job(), database, storage);

    expect(mocks.processImport).toHaveBeenCalledOnce();
    expect(mocks.complete).toHaveBeenCalledWith(database, uploadId, digest);
    expect(storage.deleteObject).toHaveBeenCalledWith(upload().objectKey);
    expect(existsSync(join(jobFilesDirectory, `file-upload-${uploadId}`))).toBe(false);
  });

  it("rejects a digest mismatch before the importer runs", async () => {
    mocks.claim.mockResolvedValue(upload({ expectedSha256: "b".repeat(64) }));
    const storage = storageWithBody();

    await expect(processFileUploadImportJob(job(), database, storage)).rejects.toThrow(
      "SHA-256 mismatch",
    );

    expect(mocks.processImport).not.toHaveBeenCalled();
    expect(mocks.fail).toHaveBeenCalledWith(
      database,
      uploadId,
      "IMPORT_REJECTED",
      "Upload SHA-256 mismatch",
    );
  });

  it("returns without reading R2 for an already completed upload", async () => {
    mocks.claim.mockResolvedValue(upload({ state: "completed", completedAt: new Date() }));
    const storage = storageWithBody();

    await processFileUploadImportJob(job(), database, storage);

    expect(storage.getObjectStream).not.toHaveBeenCalled();
    expect(mocks.processImport).not.toHaveBeenCalled();
  });
});
