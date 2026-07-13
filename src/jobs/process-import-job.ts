import * as Sentry from "@sentry/node";
import type { SyncDatabase } from "../db/index.ts";
import { logSync } from "../db/sync-log.ts";
import { runWithTokenUser } from "../db/token-user-context.ts";
import { logger } from "../logger.ts";
import type { KayaImportDatabase } from "../providers/kaya/import.ts";
import type { ImportJobData } from "./queues.ts";

/** Minimal Job interface — only the subset processImportJob actually uses. */
interface ImportJob {
  data: ImportJobData;
  updateProgress: (data: object) => Promise<void>;
  extendLock: (durationMs: number) => Promise<void>;
}

function isKayaImportDatabase(db: SyncDatabase): db is KayaImportDatabase {
  return "transaction" in db && typeof db.transaction === "function";
}

function requireKayaImportDatabase(db: SyncDatabase): KayaImportDatabase {
  if (!isKayaImportDatabase(db)) {
    throw new Error("Kaya export import requires a transactional database");
  }
  return db;
}

interface ImportCompletionResult {
  recordsSynced: number;
  errors?: readonly { message: string }[];
}

interface ImportProgressInfo {
  percentage: number;
  message: string;
}

function updateImportJobProgress(job: ImportJob, info: ImportProgressInfo): void {
  job.updateProgress(info).catch((error: unknown) => {
    logger.warn("Failed to update import progress: %s", error);
  });
}

function reportImportProgress(job: ImportJob, percentage: number, message: string): void {
  updateImportJobProgress(job, { percentage, message });
}

async function logImportCompletion(
  db: SyncDatabase,
  providerId: string,
  logLabel: string,
  entityLabel: string,
  result: ImportCompletionResult,
  importStart: number,
  userId: string,
): Promise<void> {
  const errors = result.errors ?? [];
  const durationMs = Date.now() - importStart;
  const durationSec = (durationMs / 1000).toFixed(1);
  const message = `${result.recordsSynced} ${entityLabel} imported, ${errors.length} errors in ${durationSec}s`;
  logger.info(`[worker] ${logLabel} import complete: ${message}`);

  await logSync(db, {
    providerId,
    dataType: "import",
    status: errors.length ? "error" : "success",
    recordCount: result.recordsSynced,
    errorMessage: errors.length ? errors.map((error) => error.message).join("; ") : undefined,
    durationMs,
    userId,
  });
}

export async function processImportJob(job: ImportJob, db: SyncDatabase): Promise<void> {
  const { filePath, since, userId, importType, weightUnit } = job.data;
  const sinceDate = new Date(since);
  const importStart = Date.now();

  try {
    await runWithTokenUser(userId, async () => {
      if (importType === "apple-health") {
        reportImportProgress(job, 0, "Starting Apple Health import...");
        const { importAppleHealthFile } = await import("../providers/apple-health/import.ts");
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

        await logImportCompletion(
          db,
          "apple_health",
          "Apple Health",
          "records",
          result,
          importStart,
          userId,
        );
      } else if (importType === "strong-csv") {
        reportImportProgress(job, 0, "Starting Strong CSV import...");
        const { readFile } = await import("node:fs/promises");
        reportImportProgress(job, 10, "Reading Strong CSV file...");
        const csvText = await readFile(filePath, "utf-8");
        const { importStrongCsv } = await import("../providers/strong-csv.ts");
        reportImportProgress(job, 25, "Importing Strong CSV workouts...");
        const result = await importStrongCsv(db, csvText, userId, weightUnit ?? "kg");
        reportImportProgress(job, 90, "Strong CSV import complete.");

        await logImportCompletion(
          db,
          "strong-csv",
          "Strong CSV",
          "workouts",
          result,
          importStart,
          userId,
        );
      } else if (importType === "cronometer-csv") {
        reportImportProgress(job, 0, "Starting Cronometer CSV import...");
        const { readFile } = await import("node:fs/promises");
        reportImportProgress(job, 10, "Reading Cronometer CSV file...");
        const csvText = await readFile(filePath, "utf-8");
        const { importCronometerCsv } = await import("../providers/cronometer-csv.ts");
        reportImportProgress(job, 25, "Importing Cronometer food entries...");
        const result = await importCronometerCsv(db, csvText, userId);
        reportImportProgress(job, 90, "Cronometer CSV import complete.");

        await logImportCompletion(
          db,
          "cronometer-csv",
          "Cronometer CSV",
          "food entries",
          result,
          importStart,
          userId,
        );
      } else if (importType === "kaya-export") {
        reportImportProgress(job, 0, "Starting Kaya export import...");
        const { readFile } = await import("node:fs/promises");
        reportImportProgress(job, 10, "Reading Kaya export file...");
        const csvText = await readFile(filePath, "utf-8");
        const { importKayaExportFile } = await import("../providers/kaya/import.ts");
        reportImportProgress(job, 25, "Importing Kaya climbing entries...");
        const result = await importKayaExportFile(requireKayaImportDatabase(db), csvText, userId);
        reportImportProgress(job, 90, "Kaya export import complete.");

        await logImportCompletion(
          db,
          "kaya-export",
          "Kaya export",
          "climbing entries",
          result,
          importStart,
          userId,
        );
      } else if (importType === "zos-app") {
        reportImportProgress(job, 0, "Starting ZOS App import...");
        const { readFile } = await import("node:fs/promises");
        reportImportProgress(job, 10, "Reading ZOS App file...");
        const binData = await readFile(filePath);
        const { importZosAppBin } = await import("../providers/zos-app/provider.ts");
        reportImportProgress(job, 25, "Importing ZOS App sessions...");
        const result = await importZosAppBin(db, binData, userId);
        reportImportProgress(job, 90, "ZOS App import complete.");

        await logImportCompletion(
          db,
          "zos-app",
          "ZOS App",
          "sessions",
          result,
          importStart,
          userId,
        );

        if (result.recordsSynced === 0 && result.errors.length > 0) {
          throw new Error(
            `ZOS App import failed: ${result.errors.map((error: { message: string }) => error.message).join("; ")}`,
          );
        }
      } else if (importType === "garmin-dump") {
        reportImportProgress(job, 0, "Starting Garmin dump import...");
        const { importGarminDumpFile } = await import("../providers/garmin-dump.ts");
        const result = await importGarminDumpFile(db, filePath, userId, {
          extendLock: job.extendLock,
          onProgress: (info) => updateImportJobProgress(job, info),
        });

        await logImportCompletion(
          db,
          "garmin-dump",
          "Garmin dump",
          "activities",
          result,
          importStart,
          userId,
        );
      }
    });
  } finally {
    // Clean up uploaded file
    const { unlink } = await import("node:fs/promises");
    await unlink(filePath).catch((error: unknown) => {
      logger.warn("Failed to clean up uploaded file %s: %s", filePath, error);
    });
  }

  try {
    job
      .updateProgress({ percentage: 95, message: "Scheduling post-import processing..." })
      .catch((error: unknown) => {
        logger.warn("Failed to update progress: %s", error);
      });
    const { enqueueDebouncedPostSyncMaintenance } = await import("./queues.ts");
    await enqueueDebouncedPostSyncMaintenance();
  } catch (err) {
    logger.error(`[worker] Failed to enqueue global post-import maintenance: ${err}`);
    Sentry.captureException(err, { tags: { phase: "post-import-global-maintenance-enqueue" } });
  }

  try {
    const { enqueueDebouncedUserRefit } = await import("./queues.ts");
    await enqueueDebouncedUserRefit(userId);
  } catch (err) {
    logger.error(`[worker] Failed to enqueue post-import user refit: ${err}`);
    Sentry.captureException(err, { tags: { phase: "post-import-user-refit-enqueue" } });
  }
}
