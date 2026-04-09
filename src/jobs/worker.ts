import * as Sentry from "@sentry/node";
import { Worker } from "bullmq";
import { createDatabaseFromEnv } from "../db/index.ts";
import { jobContext, logger } from "../logger.ts";
import { processExportJob } from "./process-export-job.ts";
import { processImportJob } from "./process-import-job.ts";
import { processPostSyncJob } from "./process-post-sync-job.ts";
import { processScheduledSyncJob } from "./process-scheduled-sync-job.ts";
import { processSyncJob } from "./process-sync-job.ts";
import {
  processTrainingExportJob,
  TRAINING_EXPORT_LOCK_MS,
} from "./process-training-export-job.ts";
import { getConfiguredProviderIds, getProviderQueueConfig } from "./provider-queue-config.ts";
import {
  EXPORT_QUEUE,
  type ExportJobData,
  getRedisConnection,
  IMPORT_QUEUE,
  type ImportJobData,
  POST_SYNC_QUEUE,
  type PostSyncJobData,
  providerSyncQueueName,
  SCHEDULED_SYNC_QUEUE,
  type ScheduledSyncJobData,
  SYNC_QUEUE,
  type SyncJobData,
  TRAINING_EXPORT_QUEUE,
  type TrainingExportJobData,
} from "./queues.ts";
import { setupScheduledSync } from "./scheduled-sync.ts";

const sentryDsn = process.env.SENTRY_DSN || process.env.SENTRY_DSN_unencrypted;
if (sentryDsn) {
  Sentry.init({ dsn: sentryDsn, skipOpenTelemetrySetup: true });
}

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const db = createDatabaseFromEnv();
const connection = getRedisConnection();

// ── Per-provider sync workers ──

const providerWorkers = new Map<string, Worker<SyncJobData>>();

for (const providerId of getConfiguredProviderIds()) {
  const config = getProviderQueueConfig(providerId);
  const worker = new Worker<SyncJobData>(
    providerSyncQueueName(providerId),
    (job) => jobContext.run(job, () => processSyncJob(job, db)),
    {
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
    return jobContext.run(job, () => processSyncJob(job, db));
  },
  { connection },
);

// ── Other workers ──

const importWorker = new Worker<ImportJobData>(
  IMPORT_QUEUE,
  (job) => jobContext.run(job, () => processImportJob(job, db)),
  { connection },
);
const exportWorker = new Worker<ExportJobData>(
  EXPORT_QUEUE,
  (job) => jobContext.run(job, () => processExportJob(job, db)),
  { connection },
);
const scheduledSyncWorker = new Worker<ScheduledSyncJobData>(
  SCHEDULED_SYNC_QUEUE,
  (job) => jobContext.run(job, () => processScheduledSyncJob(job, db)),
  { connection },
);
const postSyncWorker = new Worker<PostSyncJobData>(
  POST_SYNC_QUEUE,
  (job) => jobContext.run(job, () => processPostSyncJob(job, db)),
  { connection, concurrency: 1 },
);
const trainingExportWorker = new Worker<TrainingExportJobData>(
  TRAINING_EXPORT_QUEUE,
  (job, token) =>
    jobContext.run(job, () =>
      processTrainingExportJob(
        {
          data: job.data,
          updateProgress: (data) => job.updateProgress(data),
          extendLock: (duration) =>
            token ? job.extendLock(token, duration).then(() => {}) : Promise.resolve(),
        },
        db,
      ),
    ),
  {
    connection,
    lockDuration: TRAINING_EXPORT_LOCK_MS,
    maxStalledCount: 3,
  },
);

// ── Idle spin-down ──

let idleTimer: NodeJS.Timeout | null = null;
let activeJobs = 0;

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

const allWorkers: Worker[] = [
  ...providerWorkers.values(),
  legacySyncWorker,
  importWorker,
  exportWorker,
  scheduledSyncWorker,
  postSyncWorker,
  trainingExportWorker,
];

for (const worker of allWorkers) {
  worker.on("active", () => {
    activeJobs++;
    resetIdleTimer();
  });

  worker.on("completed", () => {
    activeJobs--;
    if (activeJobs <= 0) startIdleTimer();
  });

  worker.on("failed", (_job, err) => {
    activeJobs--;
    Sentry.captureException(err);
    logger.error(`[worker] Job failed: ${err.message}`);
    if (activeJobs <= 0) startIdleTimer();
  });

  worker.on("error", (err) => {
    Sentry.captureException(err);
    logger.error(`[worker] Worker error: ${err.message}`);
  });
}

// Start idle timer immediately (exit if no jobs arrive within timeout)
startIdleTimer();

// Set up periodic sync for API providers
const syncIntervalMinutes = process.env.SYNC_INTERVAL_MINUTES
  ? Number(process.env.SYNC_INTERVAL_MINUTES)
  : 30;
setupScheduledSync(syncIntervalMinutes).catch((err) => {
  logger.error(`[worker] Failed to set up scheduled sync: ${err}`);
});

// ── Graceful shutdown ──

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("[worker] Shutting down gracefully...");
  await Promise.all(allWorkers.map((w) => w.close()));
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
  Sentry.captureException(err);
  logger.error(`[worker] Unhandled rejection (worker still running): ${err}`);
});

logger.info("[worker] Started, waiting for jobs...");
