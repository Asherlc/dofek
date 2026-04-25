import { mkdirSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Queue } from "bullmq";
import type { Database } from "dofek/db";
import type { ImportJobData } from "dofek/jobs/queues";
import { type Request, type Response, Router } from "express";
import { getSessionIdFromRequest } from "../auth/cookies.ts";
import { validateSession } from "../auth/session.ts";
import { assembleChunks, streamToFile } from "../lib/server-utils.ts";
import { startWorker } from "../lib/start-worker.ts";
import {
  getUploadStateStore,
  UPLOAD_SESSION_TTL_MS,
  UPLOAD_STATUS_TTL_MS,
  type UploadStatus,
} from "../lib/upload-state-store.ts";
import { logger } from "../logger.ts";

/**
 * Shared directory for uploaded files that the worker container can access.
 * In production, both web and worker containers mount the `job_files` volume
 * at /app/job-files. Falls back to OS temp dir for local development.
 */
const JOB_FILES_DIR = process.env.JOB_FILES_DIR || join(tmpdir(), "dofek-job-files");
mkdirSync(JOB_FILES_DIR, { recursive: true });
const IN_PROGRESS_UPLOAD_STATUS_TTL_MS = UPLOAD_SESSION_TTL_MS + UPLOAD_STATUS_TTL_MS;

const uploadStateStore = getUploadStateStore();

async function setUploadStatus(
  uploadId: string,
  status: UploadStatus,
  timeToLiveMs = UPLOAD_STATUS_TTL_MS,
): Promise<void> {
  await uploadStateStore.saveUploadStatus(uploadId, status, timeToLiveMs);
}

function stripExpiry(status: UploadStatus): Omit<UploadStatus, "expiresAt"> {
  return {
    status: status.status,
    progress: status.progress,
    message: status.message,
    userId: status.userId,
  };
}

function inProgressStatus(
  status: "uploading" | "assembling",
  progress: number,
  message: string,
  userId: string,
): UploadStatus {
  return {
    status,
    progress,
    message,
    userId,
    expiresAt: Date.now() + UPLOAD_SESSION_TTL_MS,
  };
}

async function expireStaleUpload(uploadId: string, userId: string): Promise<UploadStatus> {
  const staleUpload = await uploadStateStore.getUploadSession(uploadId);
  await uploadStateStore.deleteUploadSession(uploadId);
  if (staleUpload) {
    await rm(staleUpload.dir, { recursive: true, force: true }).catch((error: unknown) => {
      logger.warn("Failed to clean up stale upload dir %s: %s", staleUpload.dir, error);
    });
  }
  const timeoutStatus: UploadStatus = {
    status: "error",
    progress: 0,
    message: "Upload timed out",
    userId,
  };
  await setUploadStatus(uploadId, timeoutStatus);
  return timeoutStatus;
}

async function enqueueImport(
  importQueue: Queue<ImportJobData>,
  filePath: string,
  since: Date,
  importType: "apple-health" | "strong-csv" | "cronometer-csv",
  userId: string,
  opts?: { weightUnit?: "kg" | "lbs"; jobId?: string },
): Promise<string> {
  const job = await importQueue.add(
    importType,
    {
      filePath,
      since: since.toISOString(),
      userId,
      importType,
      weightUnit: opts?.weightUnit,
    },
    opts?.jobId ? { jobId: opts.jobId } : undefined,
  );
  startWorker();
  return job.id ?? `job-${Date.now()}`;
}

async function getImportJobStatus(importQueue: Queue<ImportJobData>, jobId: string) {
  let job: Awaited<ReturnType<Queue<ImportJobData>["getJob"]>> | undefined;
  try {
    job = await importQueue.getJob(jobId);
  } catch {
    return null; // Redis unavailable
  }
  if (!job) return null;

  const state = await job.getState();
  const progress: unknown = job.progress;
  const percentage =
    typeof progress === "number"
      ? progress
      : typeof progress === "object" &&
          progress !== null &&
          "percentage" in progress &&
          typeof progress.percentage === "number"
        ? progress.percentage
        : undefined;
  const msg =
    typeof progress === "object" && progress !== null && "message" in progress
      ? String(progress.message)
      : undefined;

  let status: "uploading" | "assembling" | "processing" | "done" | "error";
  if (state === "completed") status = "done";
  else if (state === "failed") status = "error";
  else status = "processing";

  const jobUserId =
    typeof job.data === "object" && job.data !== null && "userId" in job.data
      ? String(job.data.userId)
      : undefined;

  return {
    status,
    progress: status === "done" ? 100 : (percentage ?? 0),
    message: state === "failed" ? job.failedReason : msg,
    result: job.returnvalue,
    userId: jobUserId,
  };
}

interface UploadRouteDeps {
  importQueue: Queue<ImportJobData>;
  db: Database;
}

/** Validate session from cookie or Bearer header. Returns userId or null (sends 401). */
async function authenticate(req: Request, res: Response, db: Database): Promise<string | null> {
  const sessionId = getSessionIdFromRequest(req);
  if (!sessionId) {
    res.status(401).json({ error: "Not authenticated" });
    return null;
  }
  const session = await validateSession(db, sessionId);
  if (!session) {
    res.status(401).json({ error: "Session expired" });
    return null;
  }
  return session.userId;
}

export function createUploadRouter(deps: UploadRouteDeps): Router {
  const router = Router();
  const { importQueue, db } = deps;

  // Poll job status — checks BullMQ first, falls back to upload-phase status
  router.get("/apple-health/status/:jobId", async (req, res) => {
    const userId = await authenticate(req, res, db);
    if (!userId) return;

    const uploadStatus = await uploadStateStore.getUploadStatus(req.params.jobId);
    if (uploadStatus) {
      if (uploadStatus.userId !== userId) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      if (uploadStatus.expiresAt && uploadStatus.expiresAt <= Date.now()) {
        res.json(stripExpiry(await expireStaleUpload(req.params.jobId, userId)));
        return;
      }
      res.json(stripExpiry(uploadStatus));
      return;
    }

    const status = await getImportJobStatus(importQueue, req.params.jobId);
    if (!status) {
      res.status(404).json({ error: "Unknown job" });
      return;
    }
    if (status.userId && status.userId !== userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    res.json(status);
  });

  // Chunked upload endpoint
  router.post("/apple-health", async (req, res) => {
    const userId = await authenticate(req, res, db);
    if (!userId) return;

    const contentType = req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
    if (
      contentType &&
      !["application/octet-stream", "application/zip", "application/xml", "text/xml"].includes(
        contentType,
      )
    ) {
      res.status(415).json({
        error:
          "Unsupported Content-Type. Expected application/octet-stream, application/zip, application/xml, or text/xml",
      });
      return;
    }

    const uploadId =
      typeof req.headers["x-upload-id"] === "string" ? req.headers["x-upload-id"] : undefined;
    const chunkIndex = parseInt(
      typeof req.headers["x-chunk-index"] === "string" ? req.headers["x-chunk-index"] : "",
      10,
    );
    const chunkTotal = parseInt(
      typeof req.headers["x-chunk-total"] === "string" ? req.headers["x-chunk-total"] : "",
      10,
    );
    const fileExt =
      (typeof req.headers["x-file-ext"] === "string" ? req.headers["x-file-ext"] : "") || ".zip";
    const fullSync = req.query.fullSync === "true";

    // Validate uploadId and fileExt to prevent path traversal
    if (uploadId && !/^[a-zA-Z0-9_-]+$/.test(uploadId)) {
      res.status(400).json({ error: "Invalid upload ID" });
      return;
    }
    if (![".zip", ".xml"].includes(fileExt)) {
      res.status(400).json({ error: "Invalid file extension" });
      return;
    }
    const since = fullSync ? new Date(0) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Non-chunked upload (single small file)
    if (!uploadId || Number.isNaN(chunkTotal) || chunkTotal <= 1) {
      const ext = fileExt === ".xml" || (contentType ?? "").includes("xml") ? ".xml" : ".zip";
      const tmpId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const tmpFile = join(JOB_FILES_DIR, `apple-health-${tmpId}${ext}`);
      try {
        await streamToFile(req, tmpFile);
        const jobId = await enqueueImport(importQueue, tmpFile, since, "apple-health", userId);
        res.json({ status: "processing", jobId });
      } catch (err: unknown) {
        logger.error(`[upload] Apple Health upload failed: ${err}`);
        res.status(500).json({ error: "Upload failed" });
      }
      return;
    }

    // Chunked upload
    try {
      let upload = await uploadStateStore.getUploadSession(uploadId);
      if (!upload) {
        const dir = join(JOB_FILES_DIR, `apple-health-chunked-${uploadId}`);
        await mkdir(dir, { recursive: true });
        upload = { total: chunkTotal, dir, userId };
        await uploadStateStore.saveUploadSession(
          uploadId,
          upload,
          IN_PROGRESS_UPLOAD_STATUS_TTL_MS,
        );
        await setUploadStatus(
          uploadId,
          inProgressStatus("uploading", 0, "Receiving chunks...", userId),
          IN_PROGRESS_UPLOAD_STATUS_TTL_MS,
        );
      } else if (upload.userId !== userId) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const chunkPath = join(upload.dir, `chunk-${String(chunkIndex).padStart(6, "0")}`);
      await streamToFile(req, chunkPath);
      const receivedCount = await uploadStateStore.addReceivedChunk(
        uploadId,
        chunkIndex,
        IN_PROGRESS_UPLOAD_STATUS_TTL_MS,
      );
      await uploadStateStore.saveUploadSession(uploadId, upload, IN_PROGRESS_UPLOAD_STATUS_TTL_MS);

      const uploadPercentage = Math.round((receivedCount / upload.total) * 100);
      logger.info(`[upload] Chunk ${chunkIndex + 1}/${chunkTotal} for ${uploadId}`);

      if (receivedCount < upload.total) {
        await setUploadStatus(
          uploadId,
          inProgressStatus(
            "uploading",
            uploadPercentage,
            `Received ${receivedCount}/${upload.total} chunks`,
            userId,
          ),
          IN_PROGRESS_UPLOAD_STATUS_TTL_MS,
        );
        res.json({
          status: "uploading",
          jobId: uploadId,
          received: receivedCount,
          total: upload.total,
        });
        return;
      }

      // All chunks received — respond immediately, assemble in background.
      // This prevents gateway timeouts when assembly takes a long time for large files.
      const chunkDir = upload.dir;
      await uploadStateStore.deleteUploadSession(uploadId);
      await setUploadStatus(
        uploadId,
        inProgressStatus("assembling", 0, "Assembling file...", userId),
        IN_PROGRESS_UPLOAD_STATUS_TTL_MS,
      );
      res.json({ status: "assembling", jobId: uploadId });

      // Fire-and-forget: assemble chunks → enqueue import
      (async () => {
        try {
          const assembledFile = join(JOB_FILES_DIR, `apple-health-${uploadId}${fileExt}`);
          await assembleChunks(chunkDir, assembledFile);
          await rm(chunkDir, { recursive: true, force: true });
          // Use uploadId as the BullMQ job ID so the client can poll the same ID
          await enqueueImport(importQueue, assembledFile, since, "apple-health", userId, {
            jobId: uploadId,
          });
          // Clear upload status — BullMQ job status takes over
          await uploadStateStore.deleteUploadStatus(uploadId);
        } catch (err: unknown) {
          logger.error(`[upload] Assembly/enqueue failed for ${uploadId}: ${err}`);
          await rm(chunkDir, { recursive: true, force: true }).catch((error: unknown) => {
            logger.warn("Failed to clean up chunk dir %s: %s", chunkDir, error);
          });
          await setUploadStatus(uploadId, {
            status: "error",
            progress: 0,
            message: "Failed to assemble uploaded file",
            userId,
          });
        }
      })();
    } catch (err: unknown) {
      logger.error(`[upload] Chunked upload failed: ${err}`);
      const upload = await uploadStateStore.getUploadSession(uploadId);
      if (upload) {
        await uploadStateStore.deleteUploadSession(uploadId);
        await rm(upload.dir, { recursive: true, force: true }).catch((error: unknown) => {
          logger.warn("Failed to clean up upload dir %s: %s", upload.dir, error);
        });
      }
      await setUploadStatus(uploadId, {
        status: "error",
        progress: 0,
        message: "Upload failed",
        userId,
      });
      res.status(500).json({ error: "Upload failed" });
    }
  });

  // ── Strong CSV upload ──
  router.get("/strong-csv/status/:jobId", async (req, res) => {
    const userId = await authenticate(req, res, db);
    if (!userId) return;

    const status = await getImportJobStatus(importQueue, req.params.jobId);
    if (!status) {
      res.status(404).json({ error: "Unknown job" });
      return;
    }
    if (status.userId && status.userId !== userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    res.json(status);
  });

  router.post("/strong-csv", async (req, res) => {
    const userId = await authenticate(req, res, db);
    if (!userId) return;

    const contentType = req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
    if (
      contentType &&
      !["text/csv", "application/octet-stream", "text/plain"].includes(contentType)
    ) {
      res.status(415).json({
        error:
          "Unsupported Content-Type. Expected text/csv, application/octet-stream, or text/plain",
      });
      return;
    }

    const weightUnit = req.query.units === "lbs" ? "lbs" : "kg";
    const tmpId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const tmpFile = join(JOB_FILES_DIR, `strong-csv-${tmpId}.csv`);

    try {
      await streamToFile(req, tmpFile);
      const jobId = await enqueueImport(importQueue, tmpFile, new Date(0), "strong-csv", userId, {
        weightUnit,
      });
      res.json({ status: "processing", jobId });
    } catch (err: unknown) {
      logger.error(`[strong-csv] Upload failed: ${err}`);
      res.status(500).json({ error: "Upload failed" });
    }
  });

  // ── Cronometer CSV upload ──
  router.get("/cronometer-csv/status/:jobId", async (req, res) => {
    const userId = await authenticate(req, res, db);
    if (!userId) return;

    const status = await getImportJobStatus(importQueue, req.params.jobId);
    if (!status) {
      res.status(404).json({ error: "Unknown job" });
      return;
    }
    if (status.userId && status.userId !== userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    res.json(status);
  });

  router.post("/cronometer-csv", async (req, res) => {
    const userId = await authenticate(req, res, db);
    if (!userId) return;

    const contentType = req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
    if (
      contentType &&
      !["text/csv", "application/octet-stream", "text/plain"].includes(contentType)
    ) {
      res.status(415).json({
        error:
          "Unsupported Content-Type. Expected text/csv, application/octet-stream, or text/plain",
      });
      return;
    }

    const tmpId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const tmpFile = join(JOB_FILES_DIR, `cronometer-csv-${tmpId}.csv`);

    try {
      await streamToFile(req, tmpFile);
      const jobId = await enqueueImport(
        importQueue,
        tmpFile,
        new Date(0),
        "cronometer-csv",
        userId,
      );
      res.json({ status: "processing", jobId });
    } catch (err: unknown) {
      logger.error(`[cronometer-csv] Upload failed: ${err}`);
      res.status(500).json({ error: "Upload failed" });
    }
  });

  return router;
}
