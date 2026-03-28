import type { SyncDatabase } from "../db/index.ts";
import { logSync } from "../db/sync-log.ts";
import { logger } from "../logger.ts";
import type { ImportJobData } from "./queues.ts";

/** Minimal Job interface — only the subset processImportJob actually uses. */
interface ImportJob {
  data: ImportJobData;
  updateProgress: (data: object) => Promise<void>;
}

export async function processImportJob(job: ImportJob, db: SyncDatabase): Promise<void> {
  const { filePath, since, userId, importType, weightUnit } = job.data;
  const sinceDate = new Date(since);
  const importStart = Date.now();

  try {
    if (importType === "apple-health") {
      const { importAppleHealthFile } = await import("../providers/apple-health/index.ts");
      let lastLoggedPercentage = 0;
      // Scale streaming progress to 0-90% — remaining 10% is for post-import steps
      const result = await importAppleHealthFile(db, filePath, sinceDate, (info) => {
        const scaledPercentage = Math.floor(info.percentage * 0.9);
        const counts = [
          info.recordCount > 0 ? `${info.recordCount.toLocaleString()} records` : "",
          info.workoutCount > 0 ? `${info.workoutCount} workouts` : "",
          info.sleepCount > 0 ? `${info.sleepCount} sleep sessions` : "",
        ]
          .filter(Boolean)
          .join(", ");
        const message = counts
          ? `Importing health data (${counts})...`
          : "Importing health data...";
        job.updateProgress({ percentage: scaledPercentage, message }).catch((error: unknown) => {
          logger.warn("Failed to update import progress: %s", error);
        });
        if (info.percentage >= lastLoggedPercentage + 10) {
          logger.info(`[worker] Apple Health import progress: ${info.percentage}%`);
          lastLoggedPercentage = info.percentage;
        }
      });

      const durationSec = ((Date.now() - importStart) / 1000).toFixed(1);
      const msg = `${result.recordsSynced} records imported, ${result.errors?.length ?? 0} errors in ${durationSec}s`;
      logger.info(`[worker] Apple Health import complete: ${msg}`);

      await logSync(db, {
        providerId: "apple_health",
        dataType: "import",
        status: result.errors?.length ? "error" : "success",
        recordCount: result.recordsSynced,
        errorMessage: result.errors?.length
          ? result.errors.map((e) => e.message).join("; ")
          : undefined,
        durationMs: Date.now() - importStart,
        userId,
      });
    } else if (importType === "strong-csv") {
      const { readFile } = await import("node:fs/promises");
      const csvText = await readFile(filePath, "utf-8");
      const { importStrongCsv } = await import("../providers/strong-csv.ts");
      const result = await importStrongCsv(db, csvText, userId, weightUnit ?? "kg");

      const durationSec = ((Date.now() - importStart) / 1000).toFixed(1);
      const msg = `${result.recordsSynced} workouts imported, ${result.errors.length} errors in ${durationSec}s`;
      logger.info(`[worker] Strong CSV import complete: ${msg}`);

      await logSync(db, {
        providerId: "strong-csv",
        dataType: "import",
        status: result.errors.length ? "error" : "success",
        recordCount: result.recordsSynced,
        errorMessage: result.errors.length
          ? result.errors.map((e) => e.message).join("; ")
          : undefined,
        durationMs: Date.now() - importStart,
        userId,
      });
    } else if (importType === "cronometer-csv") {
      const { readFile } = await import("node:fs/promises");
      const csvText = await readFile(filePath, "utf-8");
      const { importCronometerCsv } = await import("../providers/cronometer-csv.ts");
      const result = await importCronometerCsv(db, csvText, userId);

      const durationSec = ((Date.now() - importStart) / 1000).toFixed(1);
      const msg = `${result.recordsSynced} food entries imported, ${result.errors.length} errors in ${durationSec}s`;
      logger.info(`[worker] Cronometer CSV import complete: ${msg}`);

      await logSync(db, {
        providerId: "cronometer-csv",
        dataType: "import",
        status: result.errors.length ? "error" : "success",
        recordCount: result.recordsSynced,
        errorMessage: result.errors.length
          ? result.errors.map((e: { message: string }) => e.message).join("; ")
          : undefined,
        durationMs: Date.now() - importStart,
        userId,
      });
    }
  } finally {
    // Clean up uploaded file
    const { unlink } = await import("node:fs/promises");
    await unlink(filePath).catch((error: unknown) => {
      logger.warn("Failed to clean up uploaded file %s: %s", filePath, error);
    });
  }

  // Post-import: refresh views
  try {
    job
      .updateProgress({ percentage: 92, message: "Updating max heart rate..." })
      .catch((error: unknown) => {
        logger.warn("Failed to update progress: %s", error);
      });
    const { updateUserMaxHr } = await import("../db/dedup.ts");
    await updateUserMaxHr(db);
  } catch (err) {
    logger.error(`[worker] Failed to update max HR: ${err}`);
  }

  try {
    job
      .updateProgress({ percentage: 95, message: "Syncing provider priorities..." })
      .catch((error: unknown) => {
        logger.warn("Failed to update progress: %s", error);
      });
    const { loadProviderPriorityConfig, syncProviderPriorities } = await import(
      "../db/provider-priority.ts"
    );
    const config = loadProviderPriorityConfig();
    if (config) {
      await syncProviderPriorities(db, config);
    }
  } catch (err) {
    logger.error(`[worker] Failed to sync provider priorities: ${err}`);
  }

  try {
    job
      .updateProgress({ percentage: 97, message: "Refreshing views..." })
      .catch((error: unknown) => {
        logger.warn("Failed to update progress: %s", error);
      });
    const { refreshDedupViews } = await import("../db/dedup.ts");
    await refreshDedupViews(db);
  } catch (err) {
    logger.error(`[worker] Failed to refresh views: ${err}`);
  }
}
