import * as Sentry from "@sentry/node";
import { UnrecoverableError } from "bullmq";
import type { SyncDatabase } from "../db/index.ts";
import { logSync } from "../db/sync-log.ts";
import { runWithTokenUser } from "../db/token-user-context.ts";
import { ensureProvider } from "../db/tokens.ts";
import { logger } from "../logger.ts";
import type { KayaImportDatabase } from "../providers/kaya/import.ts";
import type { GarminDumpImportJob } from "./process-garmin-dump-import-job.ts";

type ImportJob = GarminDumpImportJob;

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

async function updateImportJobProgress(job: ImportJob, info: ImportProgressInfo): Promise<void> {
  await job.updateProgress(info).catch((error: unknown) => {
    logger.warn("Failed to update import progress: %s", error);
    Sentry.captureException(error, { tags: { phase: "import-progress-update" } });
  });
}

async function reportImportProgress(
  job: ImportJob,
  percentage: number,
  message: string,
): Promise<void> {
  await updateImportJobProgress(job, { percentage, message });
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
  let terminalImportError: UnrecoverableError | null = null;

  let shouldCleanUpUploadedFile = importType !== "garmin-dump";
  let importFailed = false;
  let importError: unknown;
  try {
    await runWithTokenUser(userId, async () => {
      if (importType === "apple-health") {
        await reportImportProgress(job, 0, "Starting Apple Health import...");
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
            Sentry.captureException(error, { tags: { phase: "import-progress-update" } });
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
        await reportImportProgress(job, 0, "Starting Strong CSV import...");
        const { readFile } = await import("node:fs/promises");
        await reportImportProgress(job, 10, "Reading Strong CSV file...");
        const csvText = await readFile(filePath, "utf-8");
        const { importStrongCsv } = await import("../providers/strong-csv.ts");
        await reportImportProgress(job, 25, "Importing Strong CSV workouts...");
        const result = await importStrongCsv(db, csvText, userId, weightUnit ?? "kg");
        await reportImportProgress(job, 90, "Strong CSV import complete.");

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
        await reportImportProgress(job, 0, "Starting Cronometer CSV import...");
        const { readFile } = await import("node:fs/promises");
        await reportImportProgress(job, 10, "Reading Cronometer CSV file...");
        const csvText = await readFile(filePath, "utf-8");
        const { importCronometerCsv } = await import("../providers/cronometer-csv.ts");
        await reportImportProgress(job, 25, "Importing Cronometer food entries...");
        const result = await importCronometerCsv(db, csvText, userId);
        await reportImportProgress(job, 90, "Cronometer CSV import complete.");

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
        await reportImportProgress(job, 0, "Starting Kaya export import...");
        const { readFile } = await import("node:fs/promises");
        await reportImportProgress(job, 10, "Reading Kaya export file...");
        const csvText = await readFile(filePath, "utf-8");
        const { importKayaExportFile } = await import("../providers/kaya/import.ts");
        await reportImportProgress(job, 25, "Importing Kaya climbing entries...");
        const result = await importKayaExportFile(requireKayaImportDatabase(db), csvText, userId);
        await reportImportProgress(job, 90, "Kaya export import complete.");

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
        await reportImportProgress(job, 0, "Starting ZOS App import...");
        const { readFile } = await import("node:fs/promises");
        await reportImportProgress(job, 10, "Reading ZOS App file...");
        const binData = await readFile(filePath);
        const { importZosAppBin } = await import("../providers/zos-app/provider.ts");
        await reportImportProgress(job, 25, "Importing ZOS App sessions...");
        const result = await importZosAppBin(db, binData, userId);

        if (result.recordsSynced === 0 && result.errors.length > 0) {
          await logImportCompletion(
            db,
            "zos-app",
            "ZOS App",
            "sessions",
            result,
            importStart,
            userId,
          );
          throw new Error(
            `ZOS App import failed: ${result.errors.map((error: { message: string }) => error.message).join("; ")}`,
          );
        }

        await reportImportProgress(job, 90, "ZOS App import complete.");
        await logImportCompletion(
          db,
          "zos-app",
          "ZOS App",
          "sessions",
          result,
          importStart,
          userId,
        );
      } else if (importType === "garmin-dump") {
        const { processGarminDumpImportJob } = await import("./process-garmin-dump-import-job.ts");
        const result = await processGarminDumpImportJob(job, db);
        shouldCleanUpUploadedFile = true;

        await logImportCompletion(
          db,
          "garmin-dump",
          "Garmin dump",
          "activities",
          result,
          importStart,
          userId,
        );
        if (result.errors.length > 0) {
          terminalImportError = new UnrecoverableError(
            `Garmin dump import batch ${result.batchId} completed with errors after importing ${result.recordsSynced} activities across ${result.totalFitFiles} FIT files: ${result.errors.map((error) => error.message).join("; ")}`,
          );
        }
      } else if (importType === "fit-file") {
        await reportImportProgress(job, 0, "Starting FIT file import...");
        await ensureProvider(db, "fit-file", "FIT File", undefined, userId);
        const { importFitFile } = await import("./process-fit-file-import-job.ts");
        const result = await importFitFile(
          db,
          {
            filePath,
            originalPath: "uploaded.fit",
            userId,
            providerId: "fit-file",
            sourceName: "FIT File",
          },
          (info) => updateImportJobProgress(job, info),
        );

        await logImportCompletion(
          db,
          "fit-file",
          "FIT file",
          "records",
          result,
          importStart,
          userId,
        );
      }
    });
  } catch (error) {
    importFailed = true;
    importError = error;
  }

  if (shouldCleanUpUploadedFile) {
    const { unlink } = await import("node:fs/promises");
    try {
      await unlink(filePath);
    } catch (cleanupError) {
      Sentry.captureException(cleanupError, { tags: { phase: "uploaded-file-cleanup" } });
      if (importFailed) {
        throw new AggregateError(
          [importError, cleanupError],
          "Import and uploaded-file cleanup both failed",
        );
      }
      throw cleanupError;
    }
  }
  if (importFailed) throw importError;

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

  if (terminalImportError) {
    throw terminalImportError;
  }
}
