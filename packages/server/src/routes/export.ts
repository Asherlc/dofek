import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Queue } from "bullmq";
import type { ExportJobData } from "dofek/jobs/queues";
import { sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { getSessionIdFromRequest } from "../auth/cookies.ts";
import { validateSession } from "../auth/session.ts";
import { startWorker } from "../lib/start-worker.ts";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";

/**
 * Shared directory for export files that the worker container can access.
 * In production, both web and worker containers mount the `job_files` volume
 * at /app/job-files. Falls back to OS temp dir for local development.
 */
const JOB_FILES_DIR = process.env.JOB_FILES_DIR || join(tmpdir(), "dofek-job-files");
mkdirSync(JOB_FILES_DIR, { recursive: true });

const EXPORT_FILENAME = "dofek-export.zip";
const EXPORT_TTL_DAYS = 7;

const insertExportRowSchema = z.object({ id: z.string().uuid() });
const exportListRowSchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  filename: z.string(),
  size_bytes: z
    .union([z.string(), z.number(), z.bigint()])
    .nullable()
    .transform((value) => (value == null ? null : Number(value))),
  created_at: timestampStringSchema,
  started_at: timestampStringSchema.nullable(),
  completed_at: timestampStringSchema.nullable(),
  expires_at: timestampStringSchema,
  error_message: z.string().nullable(),
});
const exportDownloadRowSchema = z.object({
  user_id: z.string().uuid(),
  status: z.string(),
  object_key: z.string().nullable(),
  expires_at: timestampStringSchema,
});

type SignedDownloadUrlFactory = (objectKey: string) => Promise<string>;

async function defaultCreateSignedDownloadUrl(objectKey: string): Promise<string> {
  const { createSignedExportDownloadUrl } = await import("dofek/export-storage");
  return createSignedExportDownloadUrl(objectKey);
}

function toExportResponse(row: z.infer<typeof exportListRowSchema>) {
  return {
    id: row.id,
    status: row.status,
    filename: row.filename,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
    errorMessage: row.error_message,
  };
}

interface ExportRouterDeps {
  db: import("dofek/db").Database;
  exportQueue: Pick<Queue<ExportJobData>, "add">;
  createSignedDownloadUrl?: SignedDownloadUrlFactory;
  startExportWorker?: () => void;
}

export function createExportRouter({
  createSignedDownloadUrl = defaultCreateSignedDownloadUrl,
  db,
  exportQueue,
  startExportWorker = startWorker,
}: ExportRouterDeps): Router {
  const router = Router();

  router.get("/", async (req, res) => {
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

    const rows = await executeWithSchema(
      db,
      exportListRowSchema,
      sql`SELECT id, status, filename, size_bytes, created_at, started_at, completed_at, expires_at, error_message
          FROM fitness.data_export
          WHERE user_id = ${session.userId}
            AND (
              status IN ('queued', 'processing')
              OR (status = 'completed' AND expires_at > NOW())
            )
          ORDER BY created_at DESC`,
    );

    res.json({ exports: rows.map(toExportResponse) });
  });

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

    const queue = exportQueue;
    const expiresAt = new Date(Date.now() + EXPORT_TTL_DAYS * 24 * 60 * 60 * 1000);
    const outputPath = join(
      JOB_FILES_DIR,
      `dofek-export-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.zip`,
    );
    const rows = await executeWithSchema(
      db,
      insertExportRowSchema,
      sql`INSERT INTO fitness.data_export (user_id, status, filename, expires_at)
          VALUES (${session.userId}, 'queued', ${EXPORT_FILENAME}, ${expiresAt.toISOString()})
          RETURNING id`,
    );
    const exportId = rows[0]?.id;
    if (!exportId) {
      res.status(500).json({ error: "Failed to create export" });
      return;
    }

    await queue.add("export", {
      exportId,
      userId: session.userId,
      outputPath,
    });

    startExportWorker();

    res.json({ status: "queued", exportId });
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

    const rows = await executeWithSchema(
      db,
      exportDownloadRowSchema,
      sql`SELECT user_id, status, object_key, expires_at
          FROM fitness.data_export
          WHERE id = ${req.params.jobId}
          LIMIT 1`,
    );
    const exportRow = rows[0];
    if (!exportRow) {
      res.status(404).json({ error: "Unknown job" });
      return;
    }
    if (exportRow.user_id !== session.userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    res.json({
      status:
        exportRow.status === "completed"
          ? "done"
          : exportRow.status === "failed"
            ? "error"
            : "processing",
      message:
        exportRow.status === "completed"
          ? "Export complete"
          : exportRow.status === "failed"
            ? "Export failed"
            : "Export is still running",
    });
  });

  router.get("/download/:exportId", async (req, res) => {
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

    const rows = await executeWithSchema(
      db,
      exportDownloadRowSchema,
      sql`SELECT user_id, status, object_key, expires_at
          FROM fitness.data_export
          WHERE id = ${req.params.exportId}
          LIMIT 1`,
    );
    const exportRow = rows[0];
    if (!exportRow) {
      res.status(404).json({ error: "Unknown job" });
      return;
    }
    if (exportRow.user_id !== session.userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    if (new Date(exportRow.expires_at).getTime() <= Date.now()) {
      res.status(400).json({ error: "Export has expired" });
      return;
    }
    if (exportRow.status !== "completed") {
      res.status(400).json({ error: "Export is not ready yet" });
      return;
    }
    if (!exportRow.object_key) {
      res.status(404).json({ error: "Export file not found" });
      return;
    }

    const signedUrl = await createSignedDownloadUrl(exportRow.object_key);
    res.redirect(signedUrl);
  });

  return router;
}
