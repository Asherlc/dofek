import { withAccountErasureUserWriteFence } from "dofek/db/account-erasure";
import { type DataExportQueue, enqueueDataExport } from "dofek/jobs/queues";
import { captureException } from "dofek/lib/error-reporting";
import { sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { getSessionIdFromRequest } from "../auth/cookies.ts";
import { validateSession } from "../auth/session.ts";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import { logger } from "../logger.ts";

const EXPORT_FILENAME = "dofek-export.zip";
const EXPORT_TTL_DAYS = 7;

const insertExportRowSchema = z.object({ id: z.guid() });
const exportListRowSchema = z.object({
  id: z.guid(),
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
  user_id: z.guid(),
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
  exportQueue: DataExportQueue;
  createSignedDownloadUrl?: SignedDownloadUrlFactory;
}

type ExportCreationResult = { status: "created"; exportId: string } | { status: "insert-failed" };

export function createExportRouter({
  createSignedDownloadUrl = defaultCreateSignedDownloadUrl,
  db,
  exportQueue,
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

    const result = await withAccountErasureUserWriteFence(
      db,
      session.userId,
      async (transaction): Promise<ExportCreationResult> => {
        const expiresAt = new Date(Date.now() + EXPORT_TTL_DAYS * 24 * 60 * 60 * 1000);
        const rows = await executeWithSchema(
          transaction,
          insertExportRowSchema,
          sql`INSERT INTO fitness.data_export (user_id, status, filename, expires_at)
              VALUES (${session.userId}, 'queued', ${EXPORT_FILENAME}, ${expiresAt.toISOString()})
              RETURNING id`,
        );
        const exportId = rows[0]?.id;
        if (!exportId) {
          return { status: "insert-failed" };
        }

        return { status: "created", exportId };
      },
    );

    if (result.status === "insert-failed") {
      res.status(500).json({ error: "Failed to create export" });
      return;
    }

    try {
      await enqueueDataExport({ exportId: result.exportId, userId: session.userId }, exportQueue);
    } catch (error: unknown) {
      captureException(error, {
        tags: { source: "data-export-enqueue" },
        extra: { exportId: result.exportId, userId: session.userId },
      });
      logger.error(
        `[export] Failed to enqueue durable export ${result.exportId}: ${String(error)}`,
      );
      res.status(503).json({
        error:
          "Export request was saved, but the queue is temporarily unavailable. It will retry automatically.",
        exportId: result.exportId,
        retryable: true,
      });
      return;
    }

    res.json({ status: "queued", exportId: result.exportId });
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
