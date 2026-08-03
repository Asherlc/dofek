import { mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { SyncDatabase } from "../db/index.ts";
import { executeWithSchema, timestampStringSchema } from "../db/typed-sql.ts";
import { sendExportReadyEmail } from "../export-email.ts";
import { createSignedExportDownloadUrl, uploadExportFileToR2 } from "../export-storage.ts";
import { logger } from "../logger.ts";
import { accountErasureAllowsQueuedUserWork } from "./account-erasure-work-guard.ts";
import type { ExportJobData } from "./queues.ts";

/** Minimal Job interface: only the subset processExportJob actually uses. */
interface ExportJob {
  data: ExportJobData;
  updateProgress: (data: object) => Promise<void>;
}

const JOB_FILES_DIR = process.env.JOB_FILES_DIR || join(tmpdir(), "dofek-job-files");

const exportUserRowSchema = z.object({
  email: z.string().nullable(),
  expires_at: timestampStringSchema,
});

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export async function processExportJob(job: ExportJob, db: SyncDatabase): Promise<void> {
  const { exportId, userId } = job.data;
  const outputPath = join(JOB_FILES_DIR, `dofek-export-${exportId}.zip`);

  logger.info("[worker] Starting data export...");

  try {
    if (!(await accountErasureAllowsQueuedUserWork(db, userId, "data export generation"))) {
      return;
    }
    await mkdir(JOB_FILES_DIR, { recursive: true });
    await db.execute(sql`
      UPDATE fitness.data_export
      SET status = 'processing', started_at = NOW(), error_message = NULL
      WHERE id = ${exportId} AND user_id = ${userId}
    `);

    const exportUsers = await executeWithSchema(
      db,
      exportUserRowSchema,
      sql`
        SELECT user_profile.email, data_export.expires_at
        FROM fitness.data_export
        JOIN fitness.user_profile ON fitness.user_profile.id = fitness.data_export.user_id
        WHERE fitness.data_export.id = ${exportId}
          AND fitness.data_export.user_id = ${userId}
        LIMIT 1
      `,
    );
    const exportUser = exportUsers[0];
    if (!exportUser?.email) {
      throw new Error("User email is required to deliver data export");
    }

    if (!(await accountErasureAllowsQueuedUserWork(db, userId, "data export file generation"))) {
      return;
    }
    const { generateExport } = await import("../export.ts");
    const result = await generateExport(
      db,
      userId,
      outputPath,
      (info: { percentage: number; message: string }) => {
        job
          .updateProgress({ percentage: info.percentage, message: info.message })
          .catch((error: unknown) => {
            logger.warn("Failed to update export progress: %s", error);
          });
      },
    );

    if (!(await accountErasureAllowsQueuedUserWork(db, userId, "data export object upload"))) {
      return;
    }
    const uploadedExport = await uploadExportFileToR2(outputPath, { exportId, userId });
    if (!(await accountErasureAllowsQueuedUserWork(db, userId, "data export delivery"))) {
      return;
    }
    const downloadUrl = await createSignedExportDownloadUrl(uploadedExport.objectKey);
    if (!(await accountErasureAllowsQueuedUserWork(db, userId, "data export notification"))) {
      return;
    }
    await sendExportReadyEmail({
      downloadUrl,
      expiresAt: new Date(exportUser.expires_at),
      toEmail: exportUser.email,
    });

    if (!(await accountErasureAllowsQueuedUserWork(db, userId, "data export completion"))) {
      return;
    }
    await db.execute(sql`
      UPDATE fitness.data_export
      SET status = 'completed',
        object_key = ${uploadedExport.objectKey},
        size_bytes = ${uploadedExport.sizeBytes},
        completed_at = NOW(),
        error_message = NULL
      WHERE id = ${exportId} AND user_id = ${userId}
    `);

    await unlink(outputPath).catch((error: unknown) => {
      logger.warn("Failed to delete local export file %s: %s", outputPath, error);
    });

    logger.info(
      `[worker] Export complete: ${result.totalRecords} records across ${result.tableCount} tables`,
    );
  } catch (error) {
    await db
      .execute(sql`
        UPDATE fitness.data_export
        SET status = 'failed',
          completed_at = NOW(),
          error_message = ${formatErrorMessage(error)}
        WHERE id = ${exportId} AND user_id = ${userId}
      `)
      .catch((updateError: unknown) => {
        logger.error("Failed to mark export %s as failed: %s", exportId, updateError);
      });
    throw error;
  }
}
