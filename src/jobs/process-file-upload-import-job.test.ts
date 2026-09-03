import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { UnrecoverableError, WaitingChildrenError } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileUpload } from "../db/file-upload.ts";
import type { SyncDatabase } from "../db/index.ts";
import type { ImportUploadStorage } from "../file-upload-storage.ts";
import type { ImportJobData } from "./queues.ts";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  progress: vi.fn(),
  processImport: vi.fn(),
  validateArchive: vi.fn(),
  checksumMismatch: vi.fn(),
  lifecycle: vi.fn(),
  accountErasureAllowsQueuedUserWork: vi.fn(),
}));

vi.mock("../db/file-upload.ts", () => ({
  claimFileUploadForProcessing: mocks.claim,
  completeFileUploadProcessing: mocks.complete,
  failFileUploadProcessing: mocks.fail,
  updateFileUploadProgress: mocks.progress,
}));

vi.mock("./process-import-job.ts", () => ({ processImportJob: mocks.processImport }));
vi.mock("./validate-import-archive.ts", () => ({ validateImportArchive: mocks.validateArchive }));
vi.mock("../file-upload-metrics.ts", () => ({
  fileUploadChecksumMismatchesTotal: { add: mocks.checksumMismatch },
  fileUploadLifecycleTotal: { add: mocks.lifecycle },
}));
vi.mock("./account-erasure-work-guard.ts", () => ({
  accountErasureAllowsQueuedUserWork: mocks.accountErasureAllowsQueuedUserWork,
}));

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
    timezone: "America/Los_Angeles",
    progressPercent: 0,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    completedAt: null,
    objectDeletedAt: null,
    ...overrides,
  };
}

function job() {
  const data: ImportJobData = { uploadId, userId: upload().userId, importType: "strong-csv" };
  return {
    id: `file-import-${uploadId}`,
    queueQualifiedName: "bull:import",
    data,
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
    mocks.accountErasureAllowsQueuedUserWork.mockResolvedValue(true);
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

  it("does not download when erasure activates after the upload is claimed", async () => {
    mocks.accountErasureAllowsQueuedUserWork.mockResolvedValueOnce(false);
    const storage = storageWithBody();

    await processFileUploadImportJob(job(), database, storage);

    expect(storage.getObjectStream).not.toHaveBeenCalled();
    expect(mocks.processImport).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("does not import a verified object when erasure activates before import", async () => {
    mocks.accountErasureAllowsQueuedUserWork
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await processFileUploadImportJob(job(), database, storageWithBody());

    expect(mocks.processImport).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("does not complete an import when erasure activates before completion", async () => {
    mocks.accountErasureAllowsQueuedUserWork
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await processFileUploadImportJob(job(), database, storageWithBody());

    expect(mocks.processImport).toHaveBeenCalledOnce();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.lifecycle).not.toHaveBeenCalled();
  });

  it("does not delete the object when erasure activates after completion", async () => {
    mocks.accountErasureAllowsQueuedUserWork
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const storage = storageWithBody();

    await processFileUploadImportJob(job(), database, storage);

    expect(mocks.complete).toHaveBeenCalledWith(database, uploadId, digest);
    expect(mocks.lifecycle).toHaveBeenCalledWith(1, {
      state: "completed",
      import_type: "strong-csv",
    });
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it("publishes the retained upload file only after download verification", async () => {
    const filePath = join(jobFilesDirectory, `file-upload-${uploadId}`, "source.csv");
    let finalFileExistedDuringDownload: boolean | undefined;
    const objectStorage = storageWithBody();
    vi.mocked(objectStorage.getObjectStream).mockResolvedValue(
      Readable.from(
        (async function* () {
          yield body.subarray(0, 5);
          await new Promise<void>((resolve) => setImmediate(resolve));
          finalFileExistedDuringDownload = existsSync(filePath);
          yield body.subarray(5);
        })(),
      ),
    );

    await processFileUploadImportJob(job(), database, objectStorage);

    expect(finalFileExistedDuringDownload).toBe(false);
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
    expect(mocks.checksumMismatch).toHaveBeenCalledWith(1, { import_type: "strong-csv" });
  });

  it("rejects a size mismatch before the importer runs", async () => {
    mocks.claim.mockResolvedValue(upload({ expectedSizeBytes: body.length + 1 }));

    await expect(processFileUploadImportJob(job(), database, storageWithBody())).rejects.toThrow(
      `Upload size mismatch: expected ${body.length + 1}, received ${body.length}`,
    );

    expect(mocks.processImport).not.toHaveBeenCalled();
    expect(mocks.fail).toHaveBeenCalledWith(
      database,
      uploadId,
      "IMPORT_REJECTED",
      `Upload size mismatch: expected ${body.length + 1}, received ${body.length}`,
    );
  });

  it("maps durable job data and forwards bounded progress and checkpoints", async () => {
    const durableJob = job();
    mocks.processImport.mockImplementation(async (localImportJob) => {
      expect(localImportJob.data).toEqual({
        filePath: join(jobFilesDirectory, `file-upload-${uploadId}`, "source.csv"),
        since: new Date(0).toISOString(),
        userId: upload().userId,
        importType: "strong-csv",
        weightUnit: "kg",
        timezone: "America/Los_Angeles",
        checkpoint: undefined,
      });
      await localImportJob.updateData({ ...localImportJob.data, checkpoint: { phase: "ready" } });
      await localImportJob.updateProgress({ percentage: 120.8 });
      await localImportJob.updateProgress({ message: "working" });
    });

    await processFileUploadImportJob(durableJob, database, storageWithBody());

    expect(durableJob.updateData).toHaveBeenCalledWith({
      ...durableJob.data,
      checkpoint: { phase: "ready" },
    });
    expect(mocks.progress).toHaveBeenCalledWith(database, uploadId, 99);
    expect(durableJob.updateProgress).toHaveBeenNthCalledWith(1, { percentage: 120.8 });
    expect(durableJob.updateProgress).toHaveBeenNthCalledWith(2, { message: "working" });
    expect(mocks.lifecycle).toHaveBeenCalledWith(1, {
      state: "completed",
      import_type: "strong-csv",
    });
  });

  it("validates zip archives before importing", async () => {
    mocks.claim.mockResolvedValue(
      upload({ originalFilename: "GARMIN.ZIP", importType: "garmin-dump" }),
    );

    await processFileUploadImportJob(job(), database, storageWithBody());

    expect(mocks.validateArchive).toHaveBeenCalledWith(
      join(jobFilesDirectory, `file-upload-${uploadId}`, "source.zip"),
    );
    expect(mocks.validateArchive.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.processImport.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("uses a safe fallback extension for invalid filenames", async () => {
    mocks.claim.mockResolvedValue(upload({ originalFilename: "archive.bad-name" }));

    await processFileUploadImportJob(job(), database, storageWithBody());

    expect(mocks.processImport.mock.calls[0]?.[0].data.filePath).toBe(
      join(jobFilesDirectory, `file-upload-${uploadId}`, "source.bin"),
    );
  });

  it("preserves and verifies the local file while a Garmin flow waits for children", async () => {
    const durableJob = job();
    durableJob.data = {
      ...durableJob.data,
      checkpoint: { phase: "ready" },
    };
    mocks.claim.mockResolvedValue(upload({ importType: "garmin-dump" }));
    mocks.processImport.mockRejectedValueOnce(new WaitingChildrenError());
    const objectStorage = storageWithBody();

    await expect(processFileUploadImportJob(durableJob, database, objectStorage)).rejects.toThrow(
      WaitingChildrenError,
    );
    expect(existsSync(join(jobFilesDirectory, `file-upload-${uploadId}`, "source.csv"))).toBe(true);

    mocks.processImport.mockResolvedValueOnce(undefined);
    await processFileUploadImportJob(durableJob, database, objectStorage);

    expect(objectStorage.getObjectStream).toHaveBeenCalledOnce();
    expect(existsSync(join(jobFilesDirectory, `file-upload-${uploadId}`))).toBe(false);
  });

  it("rejects a corrupt retained work file", async () => {
    const workDirectory = join(jobFilesDirectory, `file-upload-${uploadId}`);
    await writeFile(join(jobFilesDirectory, "placeholder"), "ready");
    const objectStorage = storageWithBody();
    mocks.processImport.mockRejectedValueOnce(new WaitingChildrenError());
    await expect(processFileUploadImportJob(job(), database, objectStorage)).rejects.toThrow(
      WaitingChildrenError,
    );
    await writeFile(join(workDirectory, "source.csv"), "corrupt");

    await expect(processFileUploadImportJob(job(), database, objectStorage)).rejects.toThrow(
      "Retained upload work file failed integrity verification",
    );
  });

  it("records unrecoverable importer failures and cleans the work directory", async () => {
    mocks.processImport.mockRejectedValue(new UnrecoverableError("Invalid import contents"));

    await expect(processFileUploadImportJob(job(), database, storageWithBody())).rejects.toThrow(
      "Invalid import contents",
    );

    expect(mocks.fail).toHaveBeenCalledWith(
      database,
      uploadId,
      "IMPORT_REJECTED",
      "Invalid import contents",
    );
    expect(mocks.lifecycle).toHaveBeenCalledWith(1, {
      state: "failed",
      import_type: "strong-csv",
    });
    expect(existsSync(join(jobFilesDirectory, `file-upload-${uploadId}`))).toBe(false);
  });

  it("returns without reading R2 for an already completed upload", async () => {
    mocks.claim.mockResolvedValue(upload({ state: "completed", completedAt: new Date() }));
    const storage = storageWithBody();

    await processFileUploadImportJob(job(), database, storage);

    expect(storage.getObjectStream).not.toHaveBeenCalled();
    expect(mocks.processImport).not.toHaveBeenCalled();
  });
});
