import { mkdirSync } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExportQueue } from "dofek/jobs/queues";
import { Router } from "express";
import { z } from "zod";
import { getSessionIdFromRequest } from "../auth/cookies.ts";
import { validateSession } from "../auth/session.ts";
import { startWorker } from "../lib/start-worker.ts";
import { logger } from "../logger.ts";

/**
 * Shared directory for export files that the worker container can access.
 * In production, both web and worker containers mount the `job_files` volume
 * at /app/job-files. Falls back to OS temp dir for local development.
 */
const JOB_FILES_DIR = process.env.JOB_FILES_DIR || join(tmpdir(), "dofek-job-files");
mkdirSync(JOB_FILES_DIR, { recursive: true });

const exportProgressSchema = z.object({
  percentage: z.number(),
  message: z.string(),
});

let _exportQueue: ReturnType<typeof createExportQueue> | null = null;

function getExportQueue() {
  if (!_exportQueue) _exportQueue = createExportQueue();
  return _exportQueue;
}

export function createExportRouter(db: import("dofek/db").Database): Router {
  const router = Router();

  router.post("/", async (req, res) => {
    const sessionId = getSessionIdFromRequest(req);
    if (!sessionId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const session = await validateSession(db, sessionId);
    if (!session) {
      res.status(401).json({ error: "Session expired" });
      return;
    }

    const queue = getExportQueue();
    const job = await queue.add("export", {
      userId: session.userId,
      outputPath: join(
        JOB_FILES_DIR,
        `dofek-export-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.zip`,
      ),
    });

    startWorker();

    const jobId = String(job.id);
    res.json({ status: "processing", jobId });
  });

  router.get("/status/:jobId", async (req, res) => {
    const sessionId = getSessionIdFromRequest(req);
    if (!sessionId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const session = await validateSession(db, sessionId);
    if (!session) {
      res.status(401).json({ error: "Session expired" });
      return;
    }

    const queue = getExportQueue();
    let job: Awaited<ReturnType<typeof queue.getJob>>;
    try {
      job = await queue.getJob(req.params.jobId);
    } catch {
      res.status(404).json({ error: "Unknown job" });
      return;
    }

    if (!job) {
      res.status(404).json({ error: "Unknown job" });
      return;
    }

    const jobData = z.object({ userId: z.string() }).safeParse(job.data);
    if (!jobData.success || jobData.data.userId !== session.userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const state = await job.getState();
    const parsed = exportProgressSchema.safeParse(job.progress);
    const progress = parsed.success
      ? parsed.data
      : { percentage: 0, message: "Starting export..." };

    const response: Record<string, unknown> = {
      status: state === "completed" ? "done" : state === "failed" ? "error" : "processing",
      progress: progress.percentage,
      message: state === "failed" ? (job.failedReason ?? "Export failed") : progress.message,
    };

    if (state === "completed") {
      response.downloadUrl = `/api/export/download/${req.params.jobId}`;
    }

    res.json(response);
  });

  router.get("/download/:jobId", async (req, res) => {
    const sessionId = getSessionIdFromRequest(req);
    if (!sessionId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const session = await validateSession(db, sessionId);
    if (!session) {
      res.status(401).json({ error: "Session expired" });
      return;
    }

    const queue = getExportQueue();
    let job: Awaited<ReturnType<typeof queue.getJob>>;
    try {
      job = await queue.getJob(req.params.jobId);
    } catch {
      res.status(404).json({ error: "Unknown job" });
      return;
    }

    if (!job) {
      res.status(404).json({ error: "Unknown job" });
      return;
    }

    const exportDataSchema = z.object({ userId: z.string(), outputPath: z.string() });
    const jobData = exportDataSchema.safeParse(job.data);
    if (!jobData.success || jobData.data.userId !== session.userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const state = await job.getState();
    if (state !== "completed") {
      res.status(400).json({ error: "Export not ready" });
      return;
    }

    const filePath = jobData.data.outputPath;
    try {
      await stat(filePath);
    } catch {
      res.status(404).json({ error: "Export file not found" });
      return;
    }

    res.download(filePath, "dofek-export.zip", (err) => {
      if (err) {
        logger.error(`[export] Download failed: ${err}`);
      }
      // Clean up the temp file after download
      unlink(filePath).catch(() => {});
      job.remove().catch(() => {});
    });
  });

  return router;
}
