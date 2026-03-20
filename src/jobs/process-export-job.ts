import type { SyncDatabase } from "../db/index.ts";
import { logger } from "../logger.ts";
import type { ExportJobData } from "./queues.ts";

/** Minimal Job interface — only the subset processExportJob actually uses. */
interface ExportJob {
  data: ExportJobData;
  updateProgress: (data: object) => Promise<void>;
}

export async function processExportJob(job: ExportJob, db: SyncDatabase): Promise<void> {
  const { userId, outputPath } = job.data;

  logger.info(`[worker] Starting data export for user ${userId}...`);

  const { generateExport } = await import("../export.ts");
  const result = await generateExport(
    db,
    userId,
    outputPath,
    (info: { pct: number; message: string }) => {
      job.updateProgress({ pct: info.pct, message: info.message }).catch(() => {});
    },
  );

  logger.info(
    `[worker] Export complete: ${result.totalRecords} records across ${result.tableCount} tables`,
  );
}
