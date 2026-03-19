import { stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "express";
import { getSessionIdFromRequest } from "../auth/cookies.ts";
import { validateSession } from "../auth/session.ts";
import { errorMessage } from "../lib/server-utils.ts";
import { logger } from "../logger.ts";

interface ExportJobStatus {
  status: string;
  progress: number;
  message: string;
  userId: string;
}

const exportJobs = new Map<string, ExportJobStatus>();

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

    const jobId = `export-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const tmpFile = join(tmpdir(), `dofek-export-${jobId}.zip`);

    exportJobs.set(jobId, {
      status: "processing",
      progress: 0,
      message: "Starting export...",
      userId: session.userId,
    });

    // Fire-and-forget background export
    (async () => {
      const exportStart = Date.now();
      try {
        const { generateExport } = await import("../export.ts");
        const result = await generateExport(db, session.userId, tmpFile, (info) => {
          exportJobs.set(jobId, {
            status: "processing",
            progress: info.pct,
            message: info.message,
            userId: session.userId,
          });
        });

        const durationSec = ((Date.now() - exportStart) / 1000).toFixed(1);
        const msg = `Exported ${result.totalRecords} records across ${result.tableCount} tables in ${durationSec}s`;
        logger.info(`[export] ${msg}`);
        exportJobs.set(jobId, {
          status: "done",
          progress: 100,
          message: msg,
          userId: session.userId,
        });
      } catch (err: unknown) {
        const message = errorMessage(err);
        logger.error(`[export] Export failed: ${message}`);
        exportJobs.set(jobId, {
          status: "error",
          progress: 0,
          message,
          userId: session.userId,
        });
        await unlink(tmpFile).catch(() => {});
      }
    })();

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

    const job = exportJobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Unknown job" });
      return;
    }

    if (job.userId !== session.userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const response: Record<string, unknown> = {
      status: job.status,
      progress: job.progress,
      message: job.message,
    };
    if (job.status === "done") {
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

    const { jobId } = req.params;
    const job = exportJobs.get(jobId);
    if (!job) {
      res.status(404).json({ error: "Unknown job" });
      return;
    }

    // Verify the export belongs to this user
    if (job.userId !== session.userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    if (job.status !== "done") {
      res.status(400).json({ error: "Export not ready" });
      return;
    }

    const filePath = join(tmpdir(), `dofek-export-${jobId}.zip`);
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
      exportJobs.delete(jobId);
    });
  });

  return router;
}
