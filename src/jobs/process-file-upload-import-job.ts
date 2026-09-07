import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { UnrecoverableError, WaitingChildrenError } from "bullmq";
import {
  claimFileUploadForProcessing,
  completeFileUploadProcessing,
  type FileUpload,
  failFileUploadProcessing,
  updateFileUploadProgress,
} from "../db/file-upload.ts";
import type { SyncDatabase } from "../db/index.ts";
import {
  fileUploadChecksumMismatchesTotal,
  fileUploadLifecycleTotal,
} from "../file-upload-metrics.ts";
import type { ImportUploadStorage } from "../file-upload-storage.ts";
import { accountErasureAllowsQueuedUserWork } from "./account-erasure-work-guard.ts";
import type { LocalImportJobData } from "./local-import-job-data.ts";
import { processImportJob } from "./process-import-job.ts";
import type { ImportJobData } from "./queues.ts";
import { validateImportArchive } from "./validate-import-archive.ts";

interface DurableImportJob {
  id: string;
  queueQualifiedName: string;
  data: ImportJobData;
  updateData(data: ImportJobData): Promise<void>;
  moveToWaitingChildren(): Promise<boolean>;
  getChildrenValues(): Promise<Record<string, unknown>>;
  getIgnoredChildrenFailures(): Promise<Record<string, string>>;
  extendLock(durationMs: number): Promise<void>;
  updateProgress(data: object): Promise<void>;
  log(message: string): Promise<void>;
}

function safeFileExtension(filename: string): string {
  const extension = extname(filename).toLowerCase();
  return /^\.[a-z0-9]+$/.test(extension) ? extension : ".bin";
}

async function downloadAndVerify(
  storage: ImportUploadStorage,
  upload: FileUpload,
  filePath: string,
): Promise<string> {
  const digest = createHash("sha256");
  let sizeBytes = 0;
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.length;
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    await storage.getObjectStream(upload.objectKey),
    verifier,
    createWriteStream(filePath, { flags: "wx" }),
  );
  const sha256 = digest.digest("hex");
  if (sizeBytes !== upload.expectedSizeBytes) {
    throw new UnrecoverableError(
      `Upload size mismatch: expected ${upload.expectedSizeBytes}, received ${sizeBytes}`,
    );
  }
  if (sha256 !== upload.expectedSha256) {
    fileUploadChecksumMismatchesTotal.add(1, { import_type: upload.importType });
    throw new UnrecoverableError("Upload SHA-256 mismatch");
  }
  return sha256;
}

async function verifyLocalFile(upload: FileUpload, filePath: string): Promise<string> {
  const digest = createHash("sha256");
  let sizeBytes = 0;
  const verifier = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.length;
      digest.update(chunk);
      callback();
    },
  });
  await pipeline(createReadStream(filePath), verifier);
  const sha256 = digest.digest("hex");
  if (sizeBytes !== upload.expectedSizeBytes || sha256 !== upload.expectedSha256) {
    throw new UnrecoverableError("Retained upload work file failed integrity verification");
  }
  return sha256;
}

function localJob(
  job: DurableImportJob,
  upload: FileUpload,
  filePath: string,
  database: SyncDatabase,
) {
  const data: LocalImportJobData = {
    filePath,
    since: upload.since.toISOString(),
    userId: upload.userId,
    importType: upload.importType,
    weightUnit: upload.weightUnit ?? undefined,
    timezone: upload.timezone ?? undefined,
    checkpoint: job.data.checkpoint,
  };
  return {
    ...job,
    data,
    updateData: async (nextData: LocalImportJobData) => {
      await job.updateData({ ...job.data, checkpoint: nextData.checkpoint });
    },
    updateProgress: async (progress: object) => {
      if ("percentage" in progress && typeof progress.percentage === "number") {
        await updateFileUploadProgress(
          database,
          upload.id,
          Math.max(0, Math.min(99, Math.floor(progress.percentage))),
        );
      }
      await job.updateProgress(progress);
    },
  };
}

export async function processFileUploadImportJob(
  job: DurableImportJob,
  database: SyncDatabase,
  storage: ImportUploadStorage,
): Promise<void> {
  const upload = await claimFileUploadForProcessing(database, job.data.uploadId, job.id);
  if (upload.state === "completed") return;
  if (
    !(await accountErasureAllowsQueuedUserWork(
      database,
      upload.userId,
      "file upload object download",
    ))
  ) {
    return;
  }

  const baseDirectory = process.env.JOB_FILES_DIR ?? tmpdir();
  await mkdir(baseDirectory, { recursive: true });
  const workDirectory = join(baseDirectory, `file-upload-${upload.id}`);
  await mkdir(workDirectory, { recursive: true });
  const filePath = join(workDirectory, `source${safeFileExtension(upload.originalFilename)}`);
  const partialFilePath = `${filePath}.partial`;
  let preserveWorkDirectory = false;
  try {
    let verifiedSha256: string;
    if (existsSync(filePath)) {
      verifiedSha256 = await verifyLocalFile(upload, filePath);
    } else {
      await rm(partialFilePath, { force: true });
      verifiedSha256 = await downloadAndVerify(storage, upload, partialFilePath);
      await rename(partialFilePath, filePath);
    }
    if (upload.originalFilename.toLowerCase().endsWith(".zip")) {
      await validateImportArchive(filePath);
    }
    if (
      !(await accountErasureAllowsQueuedUserWork(database, upload.userId, "file upload import"))
    ) {
      return;
    }
    await processImportJob(localJob(job, upload, filePath, database), database);
    if (
      !(await accountErasureAllowsQueuedUserWork(database, upload.userId, "file upload completion"))
    ) {
      return;
    }
    await completeFileUploadProcessing(database, upload.id, verifiedSha256);
    fileUploadLifecycleTotal.add(1, { state: "completed", import_type: upload.importType });
    if (
      !(await accountErasureAllowsQueuedUserWork(
        database,
        upload.userId,
        "file upload object deletion",
      ))
    ) {
      return;
    }
    await storage.deleteObject(upload.objectKey);
  } catch (error) {
    if (error instanceof WaitingChildrenError) {
      preserveWorkDirectory = true;
      throw error;
    }
    if (error instanceof UnrecoverableError) {
      await failFileUploadProcessing(database, upload.id, "IMPORT_REJECTED", error.message);
      fileUploadLifecycleTotal.add(1, { state: "failed", import_type: upload.importType });
    }
    throw error;
  } finally {
    if (!preserveWorkDirectory) await rm(workDirectory, { recursive: true, force: true });
  }
}
