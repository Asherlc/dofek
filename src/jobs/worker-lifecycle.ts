import type { Worker } from "bullmq";
import type { createDatabaseFromEnv } from "../db/index.ts";
import { captureException } from "../lib/error-reporting.ts";
import { logger } from "../logger.ts";
import type { startAccountErasureOutboxDispatcher } from "./account-erasure-outbox.ts";
import type { createAccountErasureRuntime } from "./account-erasure-runtime.ts";
import type { createAccountErasureWorkLockPoolFromEnv } from "./account-erasure-work-guard.ts";
import type { startDataExportOutboxDispatcher } from "./data-export-outbox.ts";
import type { startFileUploadOutboxDispatcher } from "./file-upload-outbox.ts";
import type { startFileUploadReconciler } from "./file-upload-reconciliation.ts";
import type { createGarminImportProgressCoordinator } from "./garmin-import-progress.ts";
import type { startProviderDataDeletionOutboxDispatcher } from "./provider-data-deletion-outbox.ts";
import { closeAllQueueResources } from "./queues.ts";
import type { createWorkerReadinessServer } from "./worker-readiness.ts";

export function createWorkerLifecycle({
  allWorkers,
  db,
  getReadinessServer,
  accountErasureOutboxDispatcher,
  providerDataDeletionOutboxDispatcher,
  dataExportOutboxDispatcher,
  fileUploadOutboxDispatcher,
  fileUploadReconciler,
  activityImageOutboxDispatcher,
  garminImportProgressCoordinator,
  accountErasureRuntime,
  accountErasureWorkLockPool,
}: {
  allWorkers: Worker[];
  db: ReturnType<typeof createDatabaseFromEnv>;
  getReadinessServer: () => ReturnType<typeof createWorkerReadinessServer>;
  accountErasureOutboxDispatcher: ReturnType<typeof startAccountErasureOutboxDispatcher>;
  providerDataDeletionOutboxDispatcher: ReturnType<
    typeof startProviderDataDeletionOutboxDispatcher
  >;
  dataExportOutboxDispatcher: ReturnType<typeof startDataExportOutboxDispatcher>;
  fileUploadOutboxDispatcher: ReturnType<typeof startFileUploadOutboxDispatcher>;
  fileUploadReconciler: ReturnType<typeof startFileUploadReconciler>;
  activityImageOutboxDispatcher: { close(): Promise<void> };
  garminImportProgressCoordinator: ReturnType<typeof createGarminImportProgressCoordinator>;
  accountErasureRuntime: Awaited<ReturnType<typeof createAccountErasureRuntime>>;
  accountErasureWorkLockPool: ReturnType<typeof createAccountErasureWorkLockPoolFromEnv>;
}) {
  let shuttingDown = false;

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("[worker] Shutting down gracefully...");
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        getReadinessServer().close((error) => (error ? reject(error) : resolve()));
      }),
      accountErasureOutboxDispatcher.close(),
      providerDataDeletionOutboxDispatcher.close(),
      dataExportOutboxDispatcher.close(),
      fileUploadOutboxDispatcher.close(),
      fileUploadReconciler.close(),
      activityImageOutboxDispatcher.close(),
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

  function registerProcessHandlers() {
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
  }

  return {
    shutdown,
    registerProcessHandlers,
  };
}
