import { UnrecoverableError } from "bullmq";
import { withAccountErasureUserWriteFence } from "../db/account-erasure.ts";
import type { Database, SyncDatabase } from "../db/index.ts";
import { logSync } from "../db/sync-log.ts";
import { runWithTokenUser } from "../db/token-user-context.ts";
import { ensureProvider } from "../db/tokens.ts";
import { invalidateAllUserQueries } from "../lib/cache.ts";
import { captureException } from "../lib/error-reporting.ts";
import { logger } from "../logger.ts";
import { currentMetricStreamWriteDatabase } from "../metric-stream/write-fence-context.ts";
import {
  processingDatasetKeysForImport,
  processingDatasetKeysForOutputPath,
} from "../processing/dataset-contracts.ts";
import {
  createLazyDefaultMetricStreamEventPublisher,
  MetricStreamProcessingPublisher,
} from "../processing/metric-stream-processing-publisher.ts";
import {
  appendProcessingStageEvent,
  createProcessingOperation,
  recordMetricStreamBatchPublished,
  recordMetricStreamBatchPublishedInTransaction,
  recordRelationalCanonicalCommits,
} from "../processing/processing-event-store.ts";
import type { KayaImportDatabase } from "../providers/kaya/import.ts";
import { accountErasureAllowsQueuedUserWork } from "./account-erasure-work-guard.ts";
import { createAppleHealthImportValidationError } from "./import-validation-error.ts";
import type { LocalImportJobData } from "./local-import-job-data.ts";
import type { GarminDumpImportJob } from "./process-garmin-dump-import-job.ts";

type ImportJob = Omit<GarminDumpImportJob, "data" | "updateData"> & {
  data: LocalImportJobData;
  updateData(data: LocalImportJobData): Promise<void>;
};

function isKayaImportDatabase(db: SyncDatabase): db is KayaImportDatabase {
  return "transaction" in db && typeof db.transaction === "function";
}

function requireKayaImportDatabase(db: SyncDatabase): KayaImportDatabase {
  if (!isKayaImportDatabase(db)) {
    throw new Error("Kaya export import requires a transactional database");
  }
  return db;
}

function hasTransaction(
  database: SyncDatabase,
): database is SyncDatabase & Pick<Database, "transaction"> {
  return "transaction" in database && typeof database.transaction === "function";
}

function requireTransactionalDatabase(
  database: SyncDatabase,
): SyncDatabase & Pick<Database, "transaction"> {
  if (!hasTransaction(database)) {
    throw new Error("Processing metric-stream publication requires a transactional database");
  }
  return database;
}

function processingProviderId(importType: LocalImportJobData["importType"]): string {
  if (importType === "apple-health") return "apple_health";
  if (importType === "kaya-export") return "kaya";
  return importType;
}

interface ImportCompletionResult {
  recordsSynced: number;
  errors?: readonly { message: string }[];
}

interface ImportProgressInfo {
  percentage: number;
  message: string;
}

const PROCESSING_EVENT_ERROR_MESSAGE_MAX_LENGTH = 500;
const GENERIC_IMPORT_FAILURE_MESSAGE =
  "The file could not be imported. Check the file and try again.";

function importFailureErrorMessage(error: unknown): string {
  const message = error instanceof UnrecoverableError ? error.message.trim() : undefined;
  if (message === undefined || message.length === 0) return GENERIC_IMPORT_FAILURE_MESSAGE;
  if (message.length <= PROCESSING_EVENT_ERROR_MESSAGE_MAX_LENGTH) return message;
  return `${message.slice(0, PROCESSING_EVENT_ERROR_MESSAGE_MAX_LENGTH - 1)}…`;
}

async function updateImportJobProgress(job: ImportJob, info: ImportProgressInfo): Promise<void> {
  await job.updateProgress(info).catch((error: unknown) => {
    logger.warn("Failed to update import progress: %s", error);
    captureException(error, { tags: { phase: "import-progress-update" } });
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
  const { filePath, since, userId, importType, weightUnit, timezone } = job.data;
  const datasetKeys = processingDatasetKeysForImport(importType);
  const processingOperation = await createProcessingOperation(db, {
    userId,
    providerId: processingProviderId(importType),
    kind: "file_import",
    externalCorrelationKey: job.id,
    datasetKeys: [...datasetKeys],
  });
  await appendProcessingStageEvent(db, {
    operationId: processingOperation.id,
    stage: "ingest",
    status: "queued",
    progressPercentage: 0,
    idempotencyKey: "worker-queued",
  });
  await appendProcessingStageEvent(db, {
    operationId: processingOperation.id,
    stage: "ingest",
    status: "running",
    progressPercentage: 0,
    idempotencyKey: "worker-running",
  });
  const metricDatasetKeys = processingDatasetKeysForOutputPath(datasetKeys, "metric_stream");
  const metricStreamPublisher =
    metricDatasetKeys.length > 0
      ? new MetricStreamProcessingPublisher(createLazyDefaultMetricStreamEventPublisher(), {
          operationId: processingOperation.id,
          datasetKeys: metricDatasetKeys,
          recordPublishedBatch: (batch) => {
            const transaction = currentMetricStreamWriteDatabase();
            return transaction
              ? recordMetricStreamBatchPublishedInTransaction(transaction, batch)
              : recordMetricStreamBatchPublished(requireTransactionalDatabase(db), batch);
          },
        })
      : undefined;
  const sinceDate = new Date(since);
  const importStart = Date.now();
  let terminalImportError: UnrecoverableError | null = null;
  let importedRecordCount = 0;

  let shouldCleanUpUploadedFile = importType !== "garmin-dump";
  let importFailed = false;
  let importSkipped = false;
  let importError: unknown;
  try {
    if (!(await accountErasureAllowsQueuedUserWork(db, userId, `${importType} import`))) {
      importSkipped = true;
      await appendProcessingStageEvent(db, {
        operationId: processingOperation.id,
        stage: "ingest",
        status: "skipped",
        errorMessage: "Import skipped because account deletion is active.",
        idempotencyKey: "worker-skipped-account-erasure",
      });
    } else {
      await runWithTokenUser(userId, async () => {
        if (importType === "apple-health") {
          await reportImportProgress(job, 0, "Starting Apple Health import...");
          const { AppleHealthImportValidationError, importAppleHealthFile } = await import(
            "../providers/apple-health/import.ts"
          );
          let lastLoggedPercentage = 0;
          // Scale streaming progress to 0-90% — remaining 10% is for post-import steps
          let result: Awaited<ReturnType<typeof importAppleHealthFile>>;
          try {
            result = await importAppleHealthFile(
              db,
              filePath,
              sinceDate,
              (info) => {
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
                job
                  .updateProgress({ percentage: scaledPercentage, message })
                  .catch((error: unknown) => {
                    logger.warn("Failed to update import progress: %s", error);
                    captureException(error, { tags: { phase: "import-progress-update" } });
                  });
                if (info.percentage >= lastLoggedPercentage + 10) {
                  logger.info(`[worker] Apple Health import progress: ${info.percentage}%`);
                  lastLoggedPercentage = info.percentage;
                }
              },
              metricStreamPublisher,
            );
          } catch (error: unknown) {
            if (error instanceof AppleHealthImportValidationError) {
              throw createAppleHealthImportValidationError(error.message);
            }
            throw error;
          }
          importedRecordCount = result.recordsSynced;

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
          const result = await importStrongCsv(db, csvText, userId, weightUnit, timezone);
          importedRecordCount = result.recordsSynced;
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
          importedRecordCount = result.recordsSynced;
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
          importedRecordCount = result.recordsSynced;
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
          importedRecordCount = result.recordsSynced;

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
          const { processGarminDumpImportJob } = await import(
            "./process-garmin-dump-import-job.ts"
          );
          const result = await processGarminDumpImportJob(job, db);
          importedRecordCount = result.recordsSynced;
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
            metricStreamPublisher,
          );
          importedRecordCount = result.recordsSynced;

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
    }
  } catch (error) {
    importFailed = true;
    importError = error;
  }

  if (shouldCleanUpUploadedFile && !metricStreamPublisher?.hasUnpublishedBatchIntents) {
    const { unlink } = await import("node:fs/promises");
    try {
      await unlink(filePath);
    } catch (cleanupError) {
      captureException(cleanupError, { tags: { phase: "uploaded-file-cleanup" } });
      await appendProcessingStageEvent(db, {
        operationId: processingOperation.id,
        stage: "ingest",
        status: "failed",
        errorCode: "file_cleanup_failed",
        errorMessage: "The import finished, but its uploaded file could not be cleaned up.",
        idempotencyKey: "worker-failed",
      });
      if (importFailed) {
        throw new AggregateError(
          [importError, cleanupError],
          "Import and uploaded-file cleanup both failed",
        );
      }
      throw cleanupError;
    }
  }
  if (importFailed) {
    await appendProcessingStageEvent(db, {
      operationId: processingOperation.id,
      stage: "ingest",
      status: "failed",
      errorCode: "file_import_failed",
      errorMessage:
        importError instanceof UnrecoverableError
          ? importFailureErrorMessage(importError)
          : GENERIC_IMPORT_FAILURE_MESSAGE,
      idempotencyKey: "worker-failed",
    });
    await invalidateAllUserQueries(userId);
    throw importError;
  }
  if (importSkipped) return;

  const emittedRelationalDatasetKeys = processingDatasetKeysForOutputPath(
    datasetKeys,
    "relational",
  );
  if (importedRecordCount > 0 && emittedRelationalDatasetKeys.length > 0) {
    await recordRelationalCanonicalCommits(requireTransactionalDatabase(db), {
      operationId: processingOperation.id,
      datasetKeys: emittedRelationalDatasetKeys,
      idempotencyKey: `worker-relational-commit:${job.id}`,
    });
  }
  if (importedRecordCount === 0 && !metricStreamPublisher?.hasPublishedBatches) {
    for (const datasetKey of datasetKeys) {
      for (const stage of ["analytics", "cache_refresh"] as const) {
        await appendProcessingStageEvent(db, {
          operationId: processingOperation.id,
          stage,
          status: "skipped",
          datasetKey,
          message: "No new data was emitted for this dataset",
          idempotencyKey: `no-output:${datasetKey}:${stage}`,
        });
      }
    }
  }

  await appendProcessingStageEvent(db, {
    operationId: processingOperation.id,
    stage: "ingest",
    status: terminalImportError ? "failed" : "succeeded",
    progressPercentage: 100,
    errorCode: terminalImportError ? "file_import_failed" : undefined,
    errorMessage: terminalImportError
      ? "Some files could not be imported. Review the import result and try again."
      : undefined,
    idempotencyKey: terminalImportError ? "worker-failed" : "worker-succeeded",
  });
  if (!(await accountErasureAllowsQueuedUserWork(db, userId, "post-import cache invalidation"))) {
    if (terminalImportError) throw terminalImportError;
    return;
  }
  await invalidateAllUserQueries(userId);

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
    captureException(err, { tags: { phase: "post-import-global-maintenance-enqueue" } });
  }

  try {
    const { enqueueDebouncedUserRefit } = await import("./queues.ts");
    await withAccountErasureUserWriteFence(requireTransactionalDatabase(db), userId, async () => {
      await enqueueDebouncedUserRefit(userId);
    });
  } catch (err) {
    logger.error(`[worker] Failed to enqueue post-import user refit: ${err}`);
    captureException(err, { tags: { phase: "post-import-user-refit-enqueue" } });
  }

  if (terminalImportError) {
    throw terminalImportError;
  }
}
