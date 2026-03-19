import { mkdirSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "dofek/db";
import type { createImportQueue } from "dofek/jobs/queues";
import { type Request, type Response, Router } from "express";
import { getSessionIdFromRequest } from "../auth/cookies.ts";
import { validateSession } from "../auth/session.ts";
import { assembleChunks, streamToFile } from "../lib/server-utils.ts";
import { startWorker } from "../lib/start-worker.ts";
import { logger } from "../logger.ts";

/**
 * Shared directory for uploaded files that the worker container can access.
 * In production, both web and worker containers mount the `job_files` volume
 * at /app/job-files. Falls back to OS temp dir for local development.
 */
const JOB_FILES_DIR = process.env.JOB_FILES_DIR || join(tmpdir(), "dofek-job-files");
mkdirSync(JOB_FILES_DIR, { recursive: true });

interface UploadChunks {
  received: Set<number>;
  total: number;
  dir: string;
}

const activeUploads = new Map<string, UploadChunks>();
interface UploadStatus {
  status: string;
  progress: number;
  message: string;
  userId: string;
}

const uploadStatuses = new Map<string, UploadStatus>();

function setUploadStatus(id: string, status: UploadStatus) {
  uploadStatuses.set(id, status);
}

function cleanupUploadStatus(id: string) {
  setTimeout(() => uploadStatuses.delete(id), 10 * 60 * 1000);
}

async function enqueueImport(
  getImportQueue: () => ReturnType<typeof createImportQueue>,
  filePath: string,
  since: Date,
  importType: "apple-health" | "strong-csv" | "cronometer-csv",
  userId: string,
  opts?: { weightUnit?: "kg" | "lbs"; jobId?: string },
): Promise<string> {
  const job = await getImportQueue().add(
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

async function getImportJobStatus(
  getImportQueue: () => ReturnType<typeof createImportQueue>,
  jobId: string,
) {
  let job: Awaited<ReturnType<ReturnType<typeof createImportQueue>["getJob"]>> | undefined;
  try {
    job = await getImportQueue().getJob(jobId);
  } catch {
    return null; // Redis unavailable
  }
  if (!job) return null;

  const state = await job.getState();
  const progress: unknown = job.progress;
  const pct =
    typeof progress === "number"
      ? progress
      : typeof progress === "object" &&
          progress !== null &&
          "pct" in progress &&
          typeof progress.pct === "number"
        ? progress.pct
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
    progress: status === "done" ? 100 : (pct ?? 0),
    message: state === "failed" ? job.failedReason : msg,
    result: job.returnvalue,
    userId: jobUserId,
  };
}

interface UploadRouteDeps {
  getImportQueue: () => ReturnType<typeof createImportQueue>;
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
  const { getImportQueue, db } = deps;

  // Poll job status — checks BullMQ first, falls back to upload-phase status
  router.get("/apple-health/status/:jobId", async (req, res) => {
    const userId = await authenticate(req, res, db);
    if (!userId) return;

    const uploadStatus = uploadStatuses.get(req.params.jobId);
    if (uploadStatus) {
      if (uploadStatus.userId !== userId) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      res.json(uploadStatus);
      return;
    }

    const status = await getImportJobStatus(getImportQueue, req.params.jobId);
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
        const jobId = await enqueueImport(getImportQueue, tmpFile, since, "apple-health", userId);
        res.json({ status: "processing", jobId });
      } catch (err: unknown) {
        logger.error(`[upload] Apple Health upload failed: ${err}`);
        res.status(500).json({ error: "Upload failed" });
      }
      return;
    }

    // Chunked upload
    try {
      let upload = activeUploads.get(uploadId);
      if (!upload) {
        const dir = join(JOB_FILES_DIR, `apple-health-chunked-${uploadId}`);
        await mkdir(dir, { recursive: true });
        upload = { received: new Set(), total: chunkTotal, dir };
        activeUploads.set(uploadId, upload);
        // Clean up abandoned uploads after 30 minutes
        setTimeout(
          async () => {
            const stale = activeUploads.get(uploadId);
            if (stale) {
              activeUploads.delete(uploadId);
              await rm(stale.dir, { recursive: true, force: true }).catch(() => {});
              setUploadStatus(uploadId, {
                status: "error",
                progress: 0,
                message: "Upload timed out",
                userId,
              });
              cleanupUploadStatus(uploadId);
            }
          },
          30 * 60 * 1000,
        );
        setUploadStatus(uploadId, {
          status: "uploading",
          progress: 0,
          message: "Receiving chunks...",
          userId,
        });
      }

      const chunkPath = join(upload.dir, `chunk-${String(chunkIndex).padStart(6, "0")}`);
      await streamToFile(req, chunkPath);
      upload.received.add(chunkIndex);

      const uploadPct = Math.round((upload.received.size / upload.total) * 100);
      logger.info(`[upload] Chunk ${chunkIndex + 1}/${chunkTotal} for ${uploadId}`);

      if (upload.received.size < upload.total) {
        setUploadStatus(uploadId, {
          status: "uploading",
          progress: uploadPct,
          message: `Received ${upload.received.size}/${upload.total} chunks`,
          userId,
        });
        res.json({
          status: "uploading",
          jobId: uploadId,
          received: upload.received.size,
          total: upload.total,
        });
        return;
      }

      // All chunks received — respond immediately, assemble in background.
      // This prevents gateway timeouts when assembly takes a long time for large files.
      const chunkDir = upload.dir;
      activeUploads.delete(uploadId);
      setUploadStatus(uploadId, {
        status: "assembling",
        progress: 0,
        message: "Assembling file...",
        userId,
      });
      res.json({ status: "assembling", jobId: uploadId });

      // Fire-and-forget: assemble chunks → enqueue import
      (async () => {
        try {
          const assembledFile = join(JOB_FILES_DIR, `apple-health-${uploadId}${fileExt}`);
          await assembleChunks(chunkDir, assembledFile);
          await rm(chunkDir, { recursive: true, force: true });
          // Use uploadId as the BullMQ job ID so the client can poll the same ID
          await enqueueImport(getImportQueue, assembledFile, since, "apple-health", userId, {
            jobId: uploadId,
          });
          // Clear upload status — BullMQ job status takes over
          uploadStatuses.delete(uploadId);
        } catch (err: unknown) {
          logger.error(`[upload] Assembly/enqueue failed for ${uploadId}: ${err}`);
          await rm(chunkDir, { recursive: true, force: true }).catch(() => {});
          setUploadStatus(uploadId, {
            status: "error",
            progress: 0,
            message: "Failed to assemble uploaded file",
            userId,
          });
          cleanupUploadStatus(uploadId);
        }
      })();
    } catch (err: unknown) {
      logger.error(`[upload] Chunked upload failed: ${err}`);
      const upload = activeUploads.get(uploadId);
      if (upload) {
        activeUploads.delete(uploadId);
        await rm(upload.dir, { recursive: true, force: true }).catch(() => {});
      }
      setUploadStatus(uploadId, { status: "error", progress: 0, message: "Upload failed", userId });
      cleanupUploadStatus(uploadId);
      res.status(500).json({ error: "Upload failed" });
    }
  });

  // ── Strong CSV upload ──
  router.get("/strong-csv/status/:jobId", async (req, res) => {
    const userId = await authenticate(req, res, db);
    if (!userId) return;

    const status = await getImportJobStatus(getImportQueue, req.params.jobId);
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
      const jobId = await enqueueImport(
        getImportQueue,
        tmpFile,
        new Date(0),
        "strong-csv",
        userId,
        { weightUnit },
      );
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

    const status = await getImportJobStatus(getImportQueue, req.params.jobId);
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
        getImportQueue,
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
