import { randomUUID } from "node:crypto";
import { validateAccountErasureLedgerKeyring } from "../account-erasure/identity.ts";
import { createEncryptedAccountErasureSnapshot } from "../account-erasure/remote-snapshot.ts";
import { createAccountErasureRestoreLedgerFromEnv } from "../account-erasure/restore-ledger.ts";
import { reconcileAccountErasureRestoreIntents } from "../account-erasure/restore-reconciliation.ts";
import { createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import { refreshBodyMeasurementReadModel } from "../db/clickhouse-read-model-refresh.ts";
import { createDatabaseFromEnv } from "../db/index.ts";
import { createRefitSensorStore } from "../db/refit-sensor-store.ts";
import { createImportUploadStorageFromEnv } from "../file-upload-storage.ts";
import { captureException } from "../lib/error-reporting.ts";
import { initProductionSentry } from "../lib/sentry.ts";
import { logger } from "../logger.ts";
import { validateMetricStreamTopicConfiguration } from "../metric-stream/routes.ts";
import { getAllProviders } from "../providers/index.ts";
import { startAccountErasureOutboxDispatcher } from "./account-erasure-outbox.ts";
import { createAccountErasureRuntime } from "./account-erasure-runtime.ts";
import { runAccountErasureRestoreStartupGate } from "./account-erasure-startup.ts";
import { createAccountErasureWorkLockPoolFromEnv } from "./account-erasure-work-guard.ts";
import { createAccountErasureWorkPurgerFromEnv } from "./account-erasure-work-purger.ts";
import { startDataExportOutboxDispatcher } from "./data-export-outbox.ts";
import { startFileUploadOutboxDispatcher } from "./file-upload-outbox.ts";
import { startFileUploadReconciler } from "./file-upload-reconciliation.ts";
import { createGarminImportProgressCoordinator } from "./garmin-import-progress.ts";
import { startProviderDataDeletionOutboxDispatcher } from "./provider-data-deletion-outbox.ts";
import { ensureProvidersRegistered } from "./provider-registration.ts";
import {
  getAccountErasureQueue,
  getDataExportQueue,
  getImportQueue,
  getProviderDataDeletionQueue,
  getRedisConnection,
} from "./queues.ts";
import { DEFAULT_SCHEDULED_SYNC_INTERVAL_MINUTES, setupScheduledSync } from "./scheduled-sync.ts";
import { attachWorkerEvents } from "./worker-events.ts";
import { createWorkerLifecycle } from "./worker-lifecycle.ts";
import { createWorkerQueues } from "./worker-queues.ts";
import { createWorkerReadinessServer } from "./worker-readiness.ts";

const sentryDsn = process.env.SENTRY_DSN || process.env.SENTRY_DSN_unencrypted;
initProductionSentry(sentryDsn);
validateMetricStreamTopicConfiguration();

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

// Reuse one ClickHouse client, and create the refit sensor store when post-sync
// first needs it.
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

const { allWorkers, fitFileImportWorker, providerDataDeletionWorker } = createWorkerQueues({
  onSyncWaitingChildren: (worker, job) => {
    lifecycle.finishActiveJob(worker, job);
    if (lifecycle.activeJobCount() === 0) lifecycle.startIdleTimer();
  },
  db,
  connection,
  accountErasureWorkLockPool,
  getImportUploadStorage,
  getClickHouseClient,
  getRefitSensorStore,
  refreshPostSyncBodyMeasurements,
  accountErasureLeaseOwner,
  accountErasureRuntime,
});
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

const lifecycle = createWorkerLifecycle({
  allWorkers,
  db,
  getReadinessServer: () => readinessServer,
  accountErasureOutboxDispatcher,
  providerDataDeletionOutboxDispatcher,
  dataExportOutboxDispatcher,
  fileUploadOutboxDispatcher,
  fileUploadReconciler,
  garminImportProgressCoordinator,
  accountErasureRuntime,
  accountErasureWorkLockPool,
});
attachWorkerEvents(allWorkers, lifecycle, db, providerDataDeletionWorker);
fitFileImportWorker.on("completed", (job) => {
  garminImportProgressCoordinator.observeFitJob(job);
});
fitFileImportWorker.on("failed", (job) => {
  if (job) {
    garminImportProgressCoordinator.observeFitJob(job);
  }
});

// Start idle timer immediately (exit if no jobs arrive within timeout)
lifecycle.startIdleTimer();

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

lifecycle.registerProcessHandlers();

logger.info("[worker] Started, waiting for jobs...");
