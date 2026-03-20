import { Worker } from "bullmq";
import { createDatabaseFromEnv } from "../db/index.ts";
import { jobContext, logger } from "../logger.ts";
import { processExportJob } from "./process-export-job.ts";
import { processImportJob } from "./process-import-job.ts";
import { processSyncJob } from "./process-sync-job.ts";
import {
  EXPORT_QUEUE,
  type ExportJobData,
  getRedisConnection,
  IMPORT_QUEUE,
  type ImportJobData,
  SYNC_QUEUE,
  type SyncJobData,
} from "./queues.ts";

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const db = createDatabaseFromEnv();
const connection = getRedisConnection();

// ── Workers ──

const syncWorker = new Worker<SyncJobData>(
  SYNC_QUEUE,
  (job) => jobContext.run(job, () => processSyncJob(job, db)),
  { connection },
);
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

for (const worker of [syncWorker, importWorker, exportWorker]) {
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
    logger.error(`[worker] Job failed: ${err.message}`);
    if (activeJobs <= 0) startIdleTimer();
  });

  worker.on("error", (err) => {
    logger.error(`[worker] Worker error: ${err.message}`);
  });
}

// Start idle timer immediately (exit if no jobs arrive within timeout)
startIdleTimer();

// ── Graceful shutdown ──

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("[worker] Shutting down gracefully...");
  await Promise.all([syncWorker.close(), importWorker.close(), exportWorker.close()]);
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
  logger.error(`[worker] Unhandled rejection (worker still running): ${err}`);
});

logger.info("[worker] Started, waiting for jobs...");
