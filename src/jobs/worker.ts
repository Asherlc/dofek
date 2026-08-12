import { randomUUID } from "node:crypto";
import { Job, UnrecoverableError, Worker } from "bullmq";
import { validateAccountErasureLedgerKeyring } from "../account-erasure/identity.ts";
import { createEncryptedAccountErasureSnapshot } from "../account-erasure/remote-snapshot.ts";
import { createAccountErasureRestoreLedgerFromEnv } from "../account-erasure/restore-ledger.ts";
import { reconcileAccountErasureRestoreIntents } from "../account-erasure/restore-reconciliation.ts";
import { createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import { refreshBodyMeasurementReadModel } from "../db/clickhouse-read-model-refresh.ts";
import { createDatabaseFromEnv } from "../db/index.ts";
import { markProviderDataDeletionFailed } from "../db/provider-data-deletion.ts";
import { createRefitSensorStore } from "../db/refit-sensor-store.ts";
import { createImportUploadStorageFromEnv } from "../file-upload-storage.ts";
import { captureException } from "../lib/error-reporting.ts";
import { initProductionSentry } from "../lib/sentry.ts";
import { jobContext, logger } from "../logger.ts";
import { getAllProviders } from "../providers/index.ts";
import { startAccountErasureOutboxDispatcher } from "./account-erasure-outbox.ts";
import { createAccountErasureRuntime } from "./account-erasure-runtime.ts";
import { runAccountErasureRestoreStartupGate } from "./account-erasure-startup.ts";
import {
  accountErasureAllowsQueuedUserWork,
  createAccountErasureWorkLockPoolFromEnv,
  runQueuedUserWorkUnlessAccountErasing,
} from "./account-erasure-work-guard.ts";
import { createAccountErasureWorkPurgerFromEnv } from "./account-erasure-work-purger.ts";
import { createAccountErasureWorker } from "./account-erasure-worker.ts";
import { startDataExportOutboxDispatcher } from "./data-export-outbox.ts";
import { startFileUploadOutboxDispatcher } from "./file-upload-outbox.ts";
import { startFileUploadReconciler } from "./file-upload-reconciliation.ts";
import { createGarminImportProgressCoordinator } from "./garmin-import-progress.ts";
import { isAppleHealthImportValidationError } from "./import-validation-error.ts";
import { processActivityDeleteAnalyticsJob } from "./process-activity-delete-analytics-job.ts";
import { processExportJob } from "./process-export-job.ts";
import { processFileUploadImportJob } from "./process-file-upload-import-job.ts";
import { processFitFileImportBatchJob } from "./process-fit-file-import-batch-job.ts";
import { processFitFileImportJob } from "./process-fit-file-import-job.ts";
import { processPostSyncJob } from "./process-post-sync-job.ts";
import { processProviderDataDeletionJob } from "./process-provider-data-deletion-job.ts";
import { processScheduledSyncJob } from "./process-scheduled-sync-job.ts";
import { processSyncJob } from "./process-sync-job.ts";
import { processZipEntryExtractJob } from "./process-zip-entry-extract-job.ts";
import { createProviderDataDeletionDependencies } from "./provider-data-deletion-dependencies.ts";
import { startProviderDataDeletionOutboxDispatcher } from "./provider-data-deletion-outbox.ts";
import { getConfiguredProviderIds, getProviderQueueConfig } from "./provider-queue-config.ts";
import { ensureProvidersRegistered } from "./provider-registration.ts";
import {
  ACCOUNT_ERASURE_QUEUE,
  ACTIVITY_DELETE_ANALYTICS_QUEUE,
  type ActivityAnalyticsJobData,
  closeAllQueueResources,
  EXPORT_QUEUE,
  type ExportJobData,
  FIT_FILE_IMPORT_BATCH_QUEUE,
  FIT_FILE_IMPORT_QUEUE,
  type FitFileImportBatchJobData,
  type FitFileImportJobData,
  getAccountErasureQueue,
  getDataExportQueue,
  getImportQueue,
  getProviderDataDeletionQueue,
  getRedisConnection,
  IMPORT_QUEUE,
  type ImportJobData,
  POST_SYNC_QUEUE,
  type PostSyncJobData,
  PROVIDER_DATA_DELETION_QUEUE,
  type ProviderDataDeletionJobData,
  providerDataDeletionJobDataSchema,
  providerSyncQueueName,
  SCHEDULED_SYNC_QUEUE,
  type ScheduledSyncJobData,
  SYNC_QUEUE,
  type SyncJobData,
  ZIP_ENTRY_EXTRACT_QUEUE,
  type ZipEntryExtractJobData,
} from "./queues.ts";
import {
  DEFAULT_SCHEDULED_SYNC_INTERVAL_MINUTES,
  setupScheduledSync,
} from "./scheduled-sync.ts";
import { createWorkerReadinessServer } from "./worker-readiness.ts";

const sentryDsn = process.env.SENTRY_DSN || process.env.SENTRY_DSN_unencrypted;
initProductionSentry(sentryDsn);

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const WORKER_READINESS_HOST = "127.0.0.1";
const WORKER_READINESS_PORT = 3001;

const db = createDatabaseFromEnv();
const accountErasureWorkLockPool = createAccountErasureWorkLockPoolFromEnv();
validateAccountErasureLedgerKeyring();
const accountErasureRestoreLedger = createAccountErasureRestoreLedgerFromEnv();
await ensureProvidersRegistered();
await runAccountErasureRestoreStartupGate(() =>
  reconcileAccountErasureRestoreIntents({
    createEncryptedRemoteSnapshot: (transaction, userId) =>
      createEncryptedAccountErasureSnapshot(transaction, userId, getAllProviders()),
    database: db,
    ledger: accountErasureRestoreLedger,
  }),
);
const connection = getRedisConnection();
let importUploadStorage: ReturnType<typeof createImportUploadStorageFromEnv> | null = null;

const rawSyncIntervalMinutes = process.env.SYNC_INTERVAL_MINUTES;
const syncIntervalMinutes =
  rawSyncIntervalMinutes === undefined
    ? DEFAULT_SCHEDULED_SYNC_INTERVAL_MINUTES
    : Number(rawSyncIntervalMinutes);
try {
  if (!Number.isFinite(syncIntervalMinutes) || syncIntervalMinutes <= 0) {
    throw new Error(
      `SYNC_INTERVAL_MINUTES must be a finite positive number, received ${JSON.stringify(rawSyncIntervalMinutes)}`,
    );
  }
  await setupScheduledSync(syncIntervalMinutes);
} catch (error: unknown) {
  captureException(error, {
    tags: { workerStartupStep: "scheduledSyncRegistration" },
  });
  logger.error("[worker] Failed to set up scheduled sync", {
    error,
    errorStack: error instanceof Error ? error.stack : undefined,
  });
  throw error;
}

function getImportUploadStorage() {
  importUploadStorage ??= createImportUploadStorageFromEnv();
  return importUploadStorage;
}

// Lazy-init the CH-backed refit sensor store. Created when the post-sync worker
// first needs it (avoids forcing every worker to depend on CLICKHOUSE_URL).
let refitSensorStore: ReturnType<typeof createRefitSensorStore> | null = null;
let clickHouseClient: ReturnType<typeof createClickHouseClientFromEnv> | null = null;
function getClickHouseClient() {
  if (clickHouseClient) return clickHouseClient;
  clickHouseClient = createClickHouseClientFromEnv();
  return clickHouseClient;
}

function getRefitSensorStore() {
  if (refitSensorStore) return refitSensorStore;
  refitSensorStore = createRefitSensorStore(getClickHouseClient());
  return refitSensorStore;
}

async function refreshPostSyncBodyMeasurements() {
  await refreshBodyMeasurementReadModel(getClickHouseClient());
}

const accountErasureRuntime = await createAccountErasureRuntime(
  db,
  getClickHouseClient(),
  createAccountErasureWorkPurgerFromEnv(),
);
const accountErasureLeaseOwner = `account-erasure-worker:${randomUUID()}`;

// ── Per-provider sync workers ──

const providerWorkers = new Map<string, Worker<SyncJobData>>();

for (const providerId of getConfiguredProviderIds()) {
  const config = getProviderQueueConfig(providerId);
  const worker = new Worker<SyncJobData>(
    providerSyncQueueName(providerId),
    (job) =>
      jobContext.run(job, () =>
        runQueuedUserWorkUnlessAccountErasing(
          accountErasureWorkLockPool,
          db,
          job.data.userId,
          "provider sync",
          () => processSyncJob(job, db),
        ),
      ),
    {
      autorun: false,
      connection,
      concurrency: config.concurrency,
      ...(config.limiter ? { limiter: config.limiter } : {}),
    },
  );
  providerWorkers.set(providerId, worker);
}

logger.info(`[worker] Created ${providerWorkers.size} per-provider sync workers`);

// ── Legacy sync worker (drains old "sync" queue) ──

const legacySyncWorker = new Worker<SyncJobData>(
  SYNC_QUEUE,
  (job) => {
    logger.warn(
      `[worker] Processing job from legacy "sync" queue (provider=${job.data.providerId}). ` +
        "New jobs should use per-provider queues.",
    );
    return jobContext.run(job, () =>
      runQueuedUserWorkUnlessAccountErasing(
        accountErasureWorkLockPool,
        db,
        job.data.userId,
        "legacy provider sync",
        () => processSyncJob(job, db),
      ),
    );
  },
  { autorun: false, connection },
);

// ── Other workers ──

const importWorker: Worker<ImportJobData> = new Worker<ImportJobData>(
  IMPORT_QUEUE,
  (job, token) =>
    jobContext.run(job, () =>
      runQueuedUserWorkUnlessAccountErasing(
        accountErasureWorkLockPool,
        db,
        job.data.userId,
        "file import",
        () =>
          processFileUploadImportJob(
            importJobWithLockExtender(job, token, importWorker),
            db,
            getImportUploadStorage(),
          ),
      ),
    ),
  { autorun: false, connection },
);
const exportWorker = new Worker<ExportJobData>(
  EXPORT_QUEUE,
  (job) =>
    jobContext.run(job, () =>
      runQueuedUserWorkUnlessAccountErasing(
        accountErasureWorkLockPool,
        db,
        job.data.userId,
        "data export",
        () => processExportJob(job, db),
      ),
    ),
  { autorun: false, connection },
);
const fitFileImportWorker = new Worker<FitFileImportJobData>(
  FIT_FILE_IMPORT_QUEUE,
  (job) =>
    jobContext.run(job, () =>
      runQueuedUserWorkUnlessAccountErasing(
        accountErasureWorkLockPool,
        db,
        job.data.userId,
        "FIT file import",
        () => processFitFileImportJob(job, db),
      ),
    ),
  { autorun: false, connection, concurrency: 2 },
);
const fitFileImportBatchWorker = new Worker<FitFileImportBatchJobData>(
  FIT_FILE_IMPORT_BATCH_QUEUE,
  (job) =>
    jobContext.run(job, () =>
      runQueuedUserWorkUnlessAccountErasing(
        accountErasureWorkLockPool,
        db,
        job.data.userId,
        "FIT file import batch",
        () => processFitFileImportBatchJob(job),
      ),
    ),
  { autorun: false, connection, concurrency: 1 },
);
const zipEntryExtractWorker = new Worker<ZipEntryExtractJobData>(
  ZIP_ENTRY_EXTRACT_QUEUE,
  (job) =>
    jobContext.run(job, () =>
      runQueuedUserWorkUnlessAccountErasing(
        accountErasureWorkLockPool,
        db,
        job.data.userId,
        "ZIP entry extraction",
        () => processZipEntryExtractJob(job),
      ),
    ),
  { autorun: false, connection, concurrency: 2 },
);
const scheduledSyncWorker = new Worker<ScheduledSyncJobData>(
  SCHEDULED_SYNC_QUEUE,
  (job) => jobContext.run(job, () => processScheduledSyncJob(job, db)),
  { autorun: false, connection },
);
const postSyncWorker = new Worker<PostSyncJobData>(
  POST_SYNC_QUEUE,
  (job) =>
    jobContext.run(job, () =>
      job.data.type === "global-maintenance"
        ? processPostSyncJob(job, db, getRefitSensorStore, refreshPostSyncBodyMeasurements)
        : runQueuedUserWorkUnlessAccountErasing(
            accountErasureWorkLockPool,
            db,
            job.data.userId,
            "post-sync refit",
            () => processPostSyncJob(job, db, getRefitSensorStore, refreshPostSyncBodyMeasurements),
          ),
    ),
  { autorun: false, connection, concurrency: 1 },
);
const activityDeleteAnalyticsWorker = new Worker<ActivityAnalyticsJobData>(
  ACTIVITY_DELETE_ANALYTICS_QUEUE,
  (job) =>
    jobContext.run(job, () =>
      runQueuedUserWorkUnlessAccountErasing(
        accountErasureWorkLockPool,
        db,
        job.data.userId,
        "activity analytics refresh",
        () => processActivityDeleteAnalyticsJob(job, db),
      ),
    ),
  { autorun: false, connection, concurrency: 1 },
);
const providerDataDeletionWorker = new Worker<ProviderDataDeletionJobData>(
  PROVIDER_DATA_DELETION_QUEUE,
  (job) => {
    try {
      job.data = providerDataDeletionJobDataSchema.parse(job.data);
    } catch (error) {
      throw new UnrecoverableError(error instanceof Error ? error.message : String(error));
    }
    return jobContext.run(job, () =>
      runQueuedUserWorkUnlessAccountErasing(
        accountErasureWorkLockPool,
        db,
        job.data.userId,
        "provider data deletion",
        () =>
          processProviderDataDeletionJob(
            job,
            createProviderDataDeletionDependencies(db, getClickHouseClient(), (workKind) =>
              accountErasureAllowsQueuedUserWork(db, job.data.userId, workKind),
            ),
          ),
      ),
    );
  },
  { autorun: false, connection, concurrency: 1 },
);
const accountErasureWorker = createAccountErasureWorker(
  db,
  accountErasureLeaseOwner,
  accountErasureRuntime.phaseRunner,
  { connection },
);

async function persistProviderDataDeletionFailure(
  job: Job<ProviderDataDeletionJobData>,
  failure: Error,
): Promise<void> {
  try {
    await markProviderDataDeletionFailed(
      db,
      job.data.eventId,
      failure.message || "Provider data deletion failed",
    );
  } catch (error: unknown) {
    captureException(error, {
      tags: { providerDataDeletionStep: "persistFailure" },
      extra: { eventId: job.data.eventId },
    });
    logger.error(
      `[provider-data-deletion] Failed to persist terminal failure for ${job.data.eventId}: ${String(error)}`,
    );
  }
}

providerDataDeletionWorker.on("failed", (job, error) => {
  if (!job) return;
  if (error instanceof UnrecoverableError) {
    void persistProviderDataDeletionFailure(job, error);
    return;
  }
  const configuredAttempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < configuredAttempts) return;

  void job
    .retry("failed", { resetAttemptsMade: true, resetAttemptsStarted: true })
    .catch(async (redriveError: unknown) => {
      captureException(redriveError, {
        tags: { providerDataDeletionStep: "redrive" },
        extra: { eventId: job.data.eventId },
      });
      logger.error(
        `[provider-data-deletion] Failed to redrive terminal job ${job.data.eventId}: ${String(redriveError)}`,
      );
      await persistProviderDataDeletionFailure(job, error);
    });
});
// Training export jobs are processed by the standalone Python BullMQ worker
// (packages/ml) — not by this Node.js worker.

// ── Idle spin-down ──

let idleTimer: NodeJS.Timeout | null = null;
const activeJobKeys = new Set<string>();
let untrackedActiveJobs = 0;

function resetIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function startIdleTimer() {
  resetIdleTimer();
  idleTimer = setTimeout(async () => {
    logger.info("[worker] Idle timeout reached, shutting down...");
    await shutdown();
  }, IDLE_TIMEOUT_MS);
}

function activeJobCount(): number {
  return activeJobKeys.size + untrackedActiveJobs;
}

function jobKey(worker: Worker, job: { id?: string | number } | undefined): string | null {
  if (job?.id == null) return null;
  return `${worker.name}:${job.id}`;
}

function trackActiveJob(worker: Worker, job: { id?: string | number } | undefined): void {
  const key = jobKey(worker, job);
  if (key) {
    activeJobKeys.add(key);
    return;
  }
  untrackedActiveJobs++;
}

function finishActiveJob(worker: Worker, job: { id?: string | number } | undefined): void {
  const key = jobKey(worker, job);
  if (key) {
    activeJobKeys.delete(key);
    return;
  }
  if (untrackedActiveJobs > 0) {
    untrackedActiveJobs--;
  }
}

const allWorkers: Worker[] = [
  ...providerWorkers.values(),
  legacySyncWorker,
  importWorker,
  exportWorker,
  fitFileImportWorker,
  fitFileImportBatchWorker,
  zipEntryExtractWorker,
  scheduledSyncWorker,
  postSyncWorker,
  activityDeleteAnalyticsWorker,
  providerDataDeletionWorker,
  accountErasureWorker,
];
const garminImportProgressCoordinator = createGarminImportProgressCoordinator(connection);
const accountErasureOutboxDispatcher = startAccountErasureOutboxDispatcher(
  db,
  getAccountErasureQueue(),
);
const providerDataDeletionOutboxDispatcher = startProviderDataDeletionOutboxDispatcher(
  db,
  getProviderDataDeletionQueue(),
);
const dataExportOutboxDispatcher = startDataExportOutboxDispatcher(db, getDataExportQueue());
const fileUploadOutboxDispatcher = startFileUploadOutboxDispatcher(db, getImportQueue());
const fileUploadReconciler = startFileUploadReconciler(db, getImportUploadStorage());

function importJobWithLockExtender(
  job: Job<ImportJobData>,
  token: string | undefined,
  worker: Worker<ImportJobData>,
) {
  const jobId = job.id;
  if (!jobId) {
    throw new Error("BullMQ import job ID missing");
  }

  const requireToken = (): string => {
    if (!token) {
      throw new Error("BullMQ import job lock token missing");
    }
    return token;
  };

  return {
    id: jobId,
    queueQualifiedName: job.queueQualifiedName,
    data: job.data,
    updateProgress: (data: object) => job.updateProgress(data),
    updateData: (data: ImportJobData) => job.updateData(data),
    moveToWaitingChildren: () => job.moveToWaitingChildren(requireToken()),
    getChildrenValues: () => job.getChildrenValues<unknown>(),
    getIgnoredChildrenFailures: () => job.getIgnoredChildrenFailures(),
    log: async (message: string) => {
      await Job.addJobLog(worker, jobId, message, 500);
    },
    extendLock: async (durationMs: number) => {
      const extendedLockCount = await job.extendLock(requireToken(), durationMs);
      if (extendedLockCount !== 1) {
        throw new Error(`BullMQ import job lock is no longer owned: ${jobId}`);
      }
    },
  };
}

function reportAccountErasureWorkerEvent(
  event: "error" | "failed" | "lockRenewalFailed" | "stalled",
  message: string,
): void {
  captureException(new Error(message), {
    tags: {
      bullmqEvent: event,
      queue: ACCOUNT_ERASURE_QUEUE,
    },
  });
  logger.error(`[worker] ${message}`);
}

for (const worker of allWorkers) {
  worker.on("active", (job) => {
    trackActiveJob(worker, job);
    resetIdleTimer();
  });

  worker.on("completed", (job) => {
    finishActiveJob(worker, job);
    if (activeJobCount() === 0) startIdleTimer();
  });

  worker.on("failed", (job, err) => {
    finishActiveJob(worker, job);
    if (worker.name === ACCOUNT_ERASURE_QUEUE) {
      reportAccountErasureWorkerEvent("failed", "Account erasure job failed");
      if (activeJobCount() === 0) startIdleTimer();
      return;
    }
    // FIT file import batch children fail as UnrecoverableError — that's expected
    // for invalid files. Suppress per-file capture to avoid flooding Sentry and
    // rely on the batch/parent job to report grouped error causes once.
    const isFitBatchChildFailure =
      worker.name === FIT_FILE_IMPORT_QUEUE && job?.parentKey && err instanceof UnrecoverableError;
    const isAppleHealthImportValidationFailure =
      worker.name === IMPORT_QUEUE && isAppleHealthImportValidationError(err);
    if (!isFitBatchChildFailure && !isAppleHealthImportValidationFailure) {
      captureException(err);
    }
    logger.error(`[worker] Job failed: ${err.message}`);
    if (job?.id) {
      const message = `BullMQ job failed: queue=${worker.name} jobId=${job.id} cause=${err.message}`;
      void Job.addJobLog(worker, job.id, `[error] ${message}`, 100).catch((logError: unknown) => {
        captureException(logError, {
          tags: { bullmqEvent: "failed", queue: worker.name },
          extra: { jobId: job.id, operation: "addJobLog" },
        });
        logger.error(
          `[worker] Failed to append failed job log: queue=${worker.name} jobId=${job.id}: ${String(logError)}`,
        );
      });
    }
    if (activeJobCount() === 0) startIdleTimer();
  });

  worker.on("stalled", (jobId, previousState) => {
    if (worker.name === ACCOUNT_ERASURE_QUEUE) {
      reportAccountErasureWorkerEvent("stalled", "Account erasure BullMQ job stalled");
      return;
    }
    const message = `BullMQ job stalled: queue=${worker.name} jobId=${jobId} previousState=${previousState}`;
    const error = new Error(message);
    captureException(error, {
      tags: { bullmqEvent: "stalled", queue: worker.name },
    });
    logger.error(`[worker] ${message}`);
    void Job.addJobLog(worker, jobId, `[error] ${message}`, 100).catch((logError: unknown) => {
      captureException(logError);
      logger.error(`[worker] Failed to append stalled job log: ${String(logError)}`);
    });
  });

  worker.on("lockRenewalFailed", (jobIds) => {
    if (worker.name === ACCOUNT_ERASURE_QUEUE) {
      reportAccountErasureWorkerEvent(
        "lockRenewalFailed",
        "Account erasure BullMQ lock renewal failed",
      );
      return;
    }
    const message = `BullMQ lock renewal failed: queue=${worker.name} jobIds=${jobIds.join(",")}`;
    const error = new Error(message);
    captureException(error, {
      tags: { bullmqEvent: "lockRenewalFailed", queue: worker.name },
      extra: { jobIds },
    });
    logger.error(`[worker] ${message}`);
    for (const jobId of jobIds) {
      void Job.addJobLog(worker, jobId, `[error] ${message}`, 100).catch((logError: unknown) => {
        captureException(logError, {
          tags: { bullmqEvent: "lockRenewalFailed", queue: worker.name },
          extra: { jobId, operation: "addJobLog" },
        });
        logger.error(
          `[worker] Failed to append lock renewal failure job log: queue=${worker.name} jobId=${jobId}: ${String(logError)}`,
        );
      });
    }
  });

  worker.on("error", (err) => {
    if (worker.name === ACCOUNT_ERASURE_QUEUE) {
      reportAccountErasureWorkerEvent("error", "Account erasure worker error");
      return;
    }
    captureException(err);
    logger.error(`[worker] Worker error: ${err.message}`);
  });
}

fitFileImportWorker.on("completed", (job) => {
  garminImportProgressCoordinator.observeFitJob(job);
});
fitFileImportWorker.on("failed", (job) => {
  if (job) {
    garminImportProgressCoordinator.observeFitJob(job);
  }
});

// Start idle timer immediately (exit if no jobs arrive within timeout)
startIdleTimer();

for (const worker of allWorkers) {
  void worker.run();
}
void garminImportProgressCoordinator.reconcile().catch((error: unknown) => {
  captureException(error, { tags: { garminDumpStep: "progress-reconcile" } });
  logger.error(`[worker] Failed to reconcile Garmin import progress: ${String(error)}`);
});

const readinessServer = createWorkerReadinessServer(allWorkers);
readinessServer.listen(WORKER_READINESS_PORT, WORKER_READINESS_HOST);
logger.info(
  `[worker] Readiness endpoint listening on http://${WORKER_READINESS_HOST}:${WORKER_READINESS_PORT}/readyz`,
);

// ── Graceful shutdown ──

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("[worker] Shutting down gracefully...");
  await Promise.all([
    new Promise<void>((resolve, reject) => {
      readinessServer.close((error) => (error ? reject(error) : resolve()));
    }),
    accountErasureOutboxDispatcher.close(),
    providerDataDeletionOutboxDispatcher.close(),
    dataExportOutboxDispatcher.close(),
    fileUploadOutboxDispatcher.close(),
    fileUploadReconciler.close(),
    ...allWorkers.map((worker) => worker.close()),
  ]);
  await Promise.all([
    garminImportProgressCoordinator.close(),
    accountErasureRuntime.close(),
    accountErasureWorkLockPool.close(),
  ]);
  await closeAllQueueResources();
  await db.$client.end();
  logger.info("[worker] Shutdown complete.");
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Prevent unhandled promise rejections from crashing the worker process.
// BullMQ and DB operations can produce rejections that escape the job
// processor's try/catch (e.g., from concurrent batch inserts via postgres.js).
// Log the error but keep the worker alive so it can process the next job.
process.on("unhandledRejection", (err) => {
  captureException(err);
  logger.error(`[worker] Unhandled rejection (worker still running): ${err}`);
});

logger.info("[worker] Started, waiting for jobs...");
