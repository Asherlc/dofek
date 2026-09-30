import { afterAll, expect, vi } from "vitest";

// All mock dependencies live inside vi.hoisted() so they are guaranteed to exist
// before vi.mock() factories resolve and before the static import of worker.ts.
// This satisfies vitest's "related" mode used by Stryker in CI, which requires a
// static import dependency between the test and the source module.
const hoisted = vi.hoisted(() => {
  // Classify this fork as a production deployment so worker.ts initializes the
  // production Sentry client on import. Use vi.stubEnv (not a raw process.env
  // assignment) so the change is tracked and torn down after this file runs —
  // otherwise the "prod" classification leaks into every other test module in
  // the same vitest fork and defeats the production-only guard in
  // initProductionSentry(), which is how local test-fixture errors previously
  // reached production error tracking.
  vi.stubEnv("DEPLOY_ENVIRONMENT", "prod");
  vi.stubEnv("SENTRY_DSN", "https://test@sentry.io/123");
  vi.stubEnv("METRIC_STREAM_LIVE_TOPIC", "metric-stream-live-test");
  vi.stubEnv("METRIC_STREAM_HISTORY_TOPIC", "metric-stream-history-test");

  function noOpExit(): never {
    throw new Error("process.exit called unexpectedly in test");
  }

  const mockOn = vi.fn<(...args: unknown[]) => unknown>();
  const mockClose = vi.fn(() => Promise.resolve());
  const mockRun = vi.fn(() => Promise.resolve());
  const mockAddJobLog = vi.fn(() => Promise.resolve(1));
  const mockDatabase = {
    $client: { end: vi.fn(() => Promise.resolve()) },
  };
  const mockClickHouseClient = {};
  const mockValidateAccountErasureLedgerKeyring = vi.fn<(...args: unknown[]) => unknown>();
  const mockReconcileAccountErasureRestoreIntents = vi.fn(() =>
    Promise.resolve({ recoveredRequestIds: [] }),
  );
  const mockAccountErasureRestoreLedger = {
    findIntent: vi.fn(() => Promise.resolve(null)),
    listIntentReferences: vi.fn(() => Promise.resolve([])),
    listIntentsForIdentities: vi.fn(() => Promise.resolve([])),
    recordIntent: vi.fn(() => Promise.resolve()),
  };
  const mockCreateAccountErasureRestoreLedgerFromEnv = vi.fn(() => mockAccountErasureRestoreLedger);

  // Per-worker `on` mocks, keyed by queue name, so tests can find handlers
  // registered by a specific worker rather than relying on call order.
  const workerOnMocks: Record<string, CallableVitestMock> = {};
  const workerProcessors: Record<string, (job: unknown) => unknown> = {};

  const mockReadinessListen = vi.fn<(...args: unknown[]) => unknown>();
  const mockReadinessClose = vi.fn((callback: (error?: Error) => void) => callback());
  const mockReadinessServer = {
    listen: mockReadinessListen,
    close: mockReadinessClose,
  };
  const scheduledSyncState: { error: Error | null } = {
    error: null,
  };

  class MockUnrecoverableError extends Error {}

  const mockObserveFitJob = vi.fn<(...args: unknown[]) => unknown>();
  const reconcileGarminProgressError = new Error("progress Redis unavailable");
  const mockReconcileGarminProgress = vi
    .fn<(...args: unknown[]) => unknown>()
    .mockRejectedValueOnce(reconcileGarminProgressError);
  const mockCloseGarminProgress = vi
    .fn<(...args: unknown[]) => unknown>()
    .mockResolvedValue(undefined);
  const mockCloseAccountErasureOutbox = vi
    .fn<(...args: unknown[]) => unknown>()
    .mockResolvedValue(undefined);
  const mockCloseAccountErasureRuntime = vi
    .fn<(...args: unknown[]) => unknown>()
    .mockResolvedValue(undefined);
  const mockCloseAccountErasureWorkLockPool = vi
    .fn<(...args: unknown[]) => unknown>()
    .mockResolvedValue(undefined);
  const mockCloseProviderDataDeletionOutbox = vi
    .fn<(...args: unknown[]) => unknown>()
    .mockResolvedValue(undefined);
  const mockCloseDataExportOutbox = vi
    .fn<(...args: unknown[]) => unknown>()
    .mockResolvedValue(undefined);
  const mockCloseFileUploadOutbox = vi
    .fn<(...args: unknown[]) => unknown>()
    .mockResolvedValue(undefined);
  const mockCloseFileUploadReconciler = vi
    .fn<(...args: unknown[]) => unknown>()
    .mockResolvedValue(undefined);
  const mockImportUploadStorage = { name: "import-upload-storage" };
  const mockCreateImportUploadStorage = vi.fn(() => mockImportUploadStorage);
  const mockGarminProgressCoordinator = {
    observeFitJob: mockObserveFitJob,
    reconcile: mockReconcileGarminProgress,
    close: mockCloseGarminProgress,
  };
  const mockAccountErasurePhaseRunner = {
    runPhase: vi.fn(async () => undefined),
  };
  const mockAccountErasureRuntime = {
    close: mockCloseAccountErasureRuntime,
    phaseRunner: mockAccountErasurePhaseRunner,
  };
  const mockAccountErasureWorkPurger = {
    close: vi.fn(async () => undefined),
    purge: vi.fn(async () => undefined),
  };
  const mockCreateAccountErasureRuntime = vi.fn(async () => mockAccountErasureRuntime);
  const mockCreateAccountErasureWorkPurgerFromEnv = vi.fn(() => mockAccountErasureWorkPurger);
  const mockProcessAccountErasureRequest = vi.fn(async () => undefined);

  return {
    exitSpy: vi.spyOn(process, "exit").mockImplementation(noOpExit),
    setTimeoutSpy: vi.spyOn(globalThis, "setTimeout"),
    clearTimeoutSpy: vi.spyOn(globalThis, "clearTimeout"),
    mockOn,
    mockClose,
    mockRun,
    mockAddJobLog,
    mockDatabase,
    mockClickHouseClient,
    mockValidateAccountErasureLedgerKeyring,
    mockReconcileAccountErasureRestoreIntents,
    mockAccountErasureRestoreLedger,
    mockCreateAccountErasureRestoreLedgerFromEnv,
    mockReadinessListen,
    mockReadinessClose,
    mockReadinessServer,
    scheduledSyncState,
    mockObserveFitJob,
    reconcileGarminProgressError,
    mockReconcileGarminProgress,
    mockCloseGarminProgress,
    mockCloseAccountErasureOutbox,
    mockCloseAccountErasureRuntime,
    mockCloseAccountErasureWorkLockPool,
    mockAccountErasurePhaseRunner,
    mockAccountErasureRuntime,
    mockAccountErasureWorkPurger,
    mockCreateAccountErasureRuntime,
    mockCreateAccountErasureWorkPurgerFromEnv,
    mockProcessAccountErasureRequest,
    mockCloseProviderDataDeletionOutbox,
    mockCloseDataExportOutbox,
    mockCloseFileUploadOutbox,
    mockCloseFileUploadReconciler,
    mockImportUploadStorage,
    mockCreateImportUploadStorage,
    mockGarminProgressCoordinator,
    MockUnrecoverableError,
    workerOnMocks,
    workerProcessors,
  };
});

vi.mock("bullmq", async (importOriginal) => ({
  WaitingChildrenError: (await importOriginal<typeof import("bullmq")>()).WaitingChildrenError,
  Job: { addJobLog: hoisted.mockAddJobLog },
  UnrecoverableError: hoisted.MockUnrecoverableError,
  Worker: vi.fn(function vitestConstructor(name: string, processor: (job: unknown) => unknown) {
    const on = vi.fn((...args: unknown[]) => hoisted.mockOn(...args));
    hoisted.workerOnMocks[name] = on;
    hoisted.workerProcessors[name] = processor;
    return { name, on, close: hoisted.mockClose, run: hoisted.mockRun };
  }),
}));

vi.mock("../../db/index.ts", () => ({
  createDatabaseFromEnv: vi.fn(() => hoisted.mockDatabase),
}));

vi.mock("../../db/clickhouse.ts", () => ({
  createClickHouseClientFromEnv: vi.fn(() => hoisted.mockClickHouseClient),
}));

vi.mock("../../account-erasure/identity.ts", () => ({
  validateAccountErasureLedgerKeyring: hoisted.mockValidateAccountErasureLedgerKeyring,
}));

vi.mock("../../account-erasure/remote-snapshot.ts", () => ({
  createEncryptedAccountErasureSnapshot: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock("../../account-erasure/restore-ledger.ts", () => ({
  createAccountErasureRestoreLedgerFromEnv: hoisted.mockCreateAccountErasureRestoreLedgerFromEnv,
}));

vi.mock("../../account-erasure/restore-reconciliation.ts", () => ({
  reconcileAccountErasureRestoreIntents: hoisted.mockReconcileAccountErasureRestoreIntents,
}));

vi.mock("../../db/clickhouse-read-model-refresh.ts", () => ({
  refreshBodyMeasurementReadModel: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../db/provider-data-deletion.ts", () => ({
  markProviderDataDeletionCompleted: vi.fn(() => Promise.resolve()),
  markProviderDataDeletionFailed: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../db/refit-sensor-store.ts", () => ({
  createRefitSensorStore: vi.fn(() => ({})),
}));

vi.mock("../process-file-upload-import-job.ts", () => ({
  processFileUploadImportJob: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock("../../file-upload-storage.ts", () => ({
  createImportUploadStorageFromEnv: hoisted.mockCreateImportUploadStorage,
}));

vi.mock("../process-fit-file-import-job.ts", () => ({
  processFitFileImportJob: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock("../process-fit-file-import-batch-job.ts", () => ({
  processFitFileImportBatchJob: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock("../process-zip-entry-extract-job.ts", () => ({
  processZipEntryExtractJob: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock("../process-sync-job.ts", () => ({
  processSyncJob: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock("../process-export-job.ts", () => ({
  processExportJob: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock("../process-scheduled-sync-job.ts", () => ({
  processScheduledSyncJob: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock("../process-post-sync-job.ts", () => ({
  processPostSyncJob: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock("../process-activity-delete-analytics-job.ts", () => ({
  processActivityDeleteAnalyticsJob: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock("../process-provider-data-deletion-job.ts", () => ({
  processProviderDataDeletionJob: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock("../process-account-erasure-request.ts", () => ({
  processAccountErasureRequest: hoisted.mockProcessAccountErasureRequest,
}));

vi.mock("../account-erasure-runtime.ts", () => ({
  createAccountErasureRuntime: hoisted.mockCreateAccountErasureRuntime,
}));

vi.mock("../account-erasure-work-purger.ts", () => ({
  createAccountErasureWorkPurgerFromEnv: hoisted.mockCreateAccountErasureWorkPurgerFromEnv,
}));

vi.mock("../account-erasure-outbox.ts", () => ({
  startAccountErasureOutboxDispatcher: vi.fn(() => ({
    close: hoisted.mockCloseAccountErasureOutbox,
  })),
}));

vi.mock("../provider-data-deletion-outbox.ts", () => ({
  startProviderDataDeletionOutboxDispatcher: vi.fn(() => ({
    close: hoisted.mockCloseProviderDataDeletionOutbox,
  })),
}));

vi.mock("../data-export-outbox.ts", () => ({
  startDataExportOutboxDispatcher: vi.fn(() => ({
    close: hoisted.mockCloseDataExportOutbox,
  })),
}));

vi.mock("../file-upload-outbox.ts", () => ({
  startFileUploadOutboxDispatcher: vi.fn(() => ({
    close: hoisted.mockCloseFileUploadOutbox,
  })),
}));

vi.mock("../file-upload-reconciliation.ts", () => ({
  startFileUploadReconciler: vi.fn(() => ({
    close: hoisted.mockCloseFileUploadReconciler,
  })),
}));

vi.mock("../scheduled-sync.ts", () => ({
  DEFAULT_SCHEDULED_SYNC_INTERVAL_MINUTES: 30,
  setupScheduledSync: () =>
    hoisted.scheduledSyncState.error
      ? Promise.reject(hoisted.scheduledSyncState.error)
      : Promise.resolve(),
}));

vi.mock("../worker-readiness.ts", () => ({
  createWorkerReadinessServer: vi.fn(() => hoisted.mockReadinessServer),
}));

vi.mock("../garmin-import-progress.ts", () => ({
  createGarminImportProgressCoordinator: vi.fn(() => hoisted.mockGarminProgressCoordinator),
}));

vi.mock("../account-erasure-work-guard.ts", () => ({
  accountErasureAllowsQueuedUserWork: vi.fn(async () => true),
  createAccountErasureWorkLockPoolFromEnv: vi.fn(() => ({
    close: hoisted.mockCloseAccountErasureWorkLockPool,
  })),
  runQueuedUserWorkUnlessAccountErasing: vi.fn(
    async (
      _workLockPool: unknown,
      _database: unknown,
      _userId: string,
      _workKind: string,
      run: () => unknown,
    ) => run(),
  ),
}));

vi.mock("../provider-queue-config.ts", () => ({
  getConfiguredProviderIds: vi.fn(() => ["strava", "garmin"]),
  getProviderQueueConfig: vi.fn(() => ({
    concurrency: 3,
    syncTier: "frequent",
    limiter: { max: 10, duration: 1000 },
  })),
}));

vi.mock("../queues.ts", () => ({
  accountErasureJobDataSchema: {
    parse: vi.fn((data: unknown) => {
      if (
        typeof data === "object" &&
        data !== null &&
        "type" in data &&
        data.type === "account-erasure" &&
        "requestId" in data &&
        typeof data.requestId === "string"
      ) {
        return data;
      }
      throw new Error("Invalid account erasure payload containing private@example.com");
    }),
  },
  providerDataDeletionJobDataSchema: {
    parse: vi.fn((data: unknown) => {
      if (
        typeof data === "object" &&
        data !== null &&
        "generation" in data &&
        typeof data.generation === "number"
      ) {
        return data;
      }
      throw new Error("Invalid provider data deletion job payload");
    }),
  },
  getRedisConnection: vi.fn(() => ({})),
  getImportQueue: vi.fn(() => ({})),
  getDataExportQueue: vi.fn(() => ({})),
  getAccountErasureQueue: vi.fn(() => ({})),
  providerSyncQueueName: vi.fn((id: string) => `sync-${id}`),
  IMPORT_QUEUE: "import-queue",
  FIT_FILE_IMPORT_QUEUE: "fit-file-import-queue",
  FIT_FILE_IMPORT_BATCH_QUEUE: "fit-file-import-batch-queue",
  ZIP_ENTRY_EXTRACT_QUEUE: "zip-entry-extract-queue",
  SYNC_QUEUE: "sync-queue",
  EXPORT_QUEUE: "export-queue",
  SCHEDULED_SYNC_QUEUE: "scheduled-sync-queue",
  POST_SYNC_QUEUE: "post-sync-queue",
  ACTIVITY_DELETE_ANALYTICS_QUEUE: "activity-delete-analytics-queue",
  PROVIDER_DATA_DELETION_QUEUE: "provider-data-deletion-queue",
  ACCOUNT_ERASURE_QUEUE: "account-erasure-queue",
  enqueueProviderDeleteAnalyticsRefresh: vi.fn(() => Promise.resolve()),
  getProviderDataDeletionQueue: vi.fn(() => ({})),
  closeAllQueueResources: vi.fn(() => Promise.resolve()),
}));

vi.mock("@sentry/node", () => ({
  init: vi.fn<(...args: unknown[]) => unknown>(),
  captureException: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock("../../lib/posthog.ts", () => ({
  initProductionPostHog: vi.fn<(...args: unknown[]) => unknown>(),
  capturePostHogException: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock("../../logger.ts", () => ({
  jobContext: { run: vi.fn((_store: unknown, fn: () => unknown) => fn()) },
  logger: {
    info: vi.fn<(...args: unknown[]) => unknown>(),
    warn: vi.fn<(...args: unknown[]) => unknown>(),
    error: vi.fn<(...args: unknown[]) => unknown>(),
  },
}));

export const {
  exitSpy,
  setTimeoutSpy,
  clearTimeoutSpy,
  mockOn,
  mockClose,
  mockRun,
  mockAddJobLog,
  mockDatabase,
  mockClickHouseClient,
  mockReadinessListen,
  mockReadinessClose,
  mockObserveFitJob,
  reconcileGarminProgressError,
  mockReconcileGarminProgress,
  mockCloseGarminProgress,
  mockCloseAccountErasureOutbox,
  mockCloseAccountErasureRuntime,
  mockCloseAccountErasureWorkLockPool,
  mockCloseProviderDataDeletionOutbox,
  mockCloseDataExportOutbox,
  workerOnMocks,
  workerProcessors,
} = hoisted;

afterAll(() => {
  vi.stubEnv("DEPLOY_ENVIRONMENT", "test");
  vi.stubEnv("SENTRY_DSN", undefined);
  vi.stubEnv("METRIC_STREAM_LIVE_TOPIC", undefined);
  vi.stubEnv("METRIC_STREAM_HISTORY_TOPIC", undefined);
});

export function getQueueWorkerHandler(
  queueName: string,
  eventName: string,
): (...args: unknown[]) => unknown {
  const on = workerOnMocks[queueName];
  if (!on) throw new Error(`${queueName} worker on mock was not registered`);
  const call = on.mock.calls.find((mockCall: [string, unknown]) => mockCall[0] === eventName);
  expect(call).toBeDefined();
  const handler = call?.[1];
  if (typeof handler !== "function") {
    throw new Error(`No ${eventName} handler registered for ${queueName}`);
  }
  return handler;
}

export function getWorkerHandler(eventName: string): (...args: unknown[]) => unknown {
  return getQueueWorkerHandler("sync-strava", eventName);
}

export function getWorkerFailedHandler(queueName: string): (...args: unknown[]) => unknown {
  const on = workerOnMocks[queueName];
  if (!on) throw new Error(`${queueName} worker on mock was not registered`);
  const failedCall = on.mock.calls.find((call: [string, unknown]) => call[0] === "failed");
  if (!failedCall || typeof failedCall[1] !== "function") {
    throw new Error(`${queueName} worker failed handler was not registered`);
  }
  return failedCall[1];
}

export function getFitWorkerFailedHandler(): (...args: unknown[]) => unknown {
  return getWorkerFailedHandler("fit-file-import-queue");
}

export function getProviderDataDeletionRedriveHandler(): (...args: unknown[]) => unknown {
  const on = workerOnMocks["provider-data-deletion-queue"];
  if (!on) throw new Error("provider deletion worker on mock was not registered");
  const failedCall = on.mock.calls.find((call: [string, unknown]) => call[0] === "failed");
  if (!failedCall || typeof failedCall[1] !== "function") {
    throw new Error("provider deletion redrive handler was not registered");
  }
  return failedCall[1];
}

export async function invokeProcessor(
  queueName: string,
  jobData: Record<string, unknown>,
  token?: string,
  jobOverrides?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<void> {
  const { Worker } = await import("bullmq");
  const call = vi.mocked(Worker).mock.calls.find((workerCall) => workerCall[0] === queueName);
  const processor = call?.[1];
  if (typeof processor !== "function") {
    throw new Error(`No processor function found for queue "${queueName}"`);
  }
  const mockJob = { data: jobData, id: "test-job-1", ...jobOverrides };
  await Reflect.apply(processor, undefined, [mockJob, token, signal]);
}

export async function processorArity(queueName: string): Promise<number> {
  const { Worker } = await import("bullmq");
  const call = vi.mocked(Worker).mock.calls.find((workerCall) => workerCall[0] === queueName);
  const processor = call?.[1];
  if (typeof processor !== "function") {
    throw new Error(`No processor function found for queue "${queueName}"`);
  }
  return processor.length;
}
export const EXPECTED_WORKER_COUNT = 13;

export async function workerQueueDependencies() {
  const { createDatabaseFromEnv } = await import("../../db/index.ts");
  const { createClickHouseClientFromEnv } = await import("../../db/clickhouse.ts");
  const { createRefitSensorStore } = await import("../../db/refit-sensor-store.ts");
  const { refreshBodyMeasurementReadModel } = await import(
    "../../db/clickhouse-read-model-refresh.ts"
  );
  const { createImportUploadStorageFromEnv } = await import("../../file-upload-storage.ts");
  const { createAccountErasureWorkLockPoolFromEnv } = await import(
    "../account-erasure-work-guard.ts"
  );
  const { createAccountErasureRuntime } = await import("../account-erasure-runtime.ts");
  const { createAccountErasureWorkPurgerFromEnv } = await import(
    "../account-erasure-work-purger.ts"
  );
  const { getRedisConnection } = await import("../queues.ts");
  const db = createDatabaseFromEnv();
  const connection = getRedisConnection();
  const accountErasureWorkLockPool = createAccountErasureWorkLockPoolFromEnv();
  const clickHouse = createClickHouseClientFromEnv();
  const storage = createImportUploadStorageFromEnv();
  const accountErasureRuntime = await createAccountErasureRuntime(
    db,
    clickHouse,
    createAccountErasureWorkPurgerFromEnv(),
  );
  return {
    db,
    connection,
    accountErasureWorkLockPool,
    accountErasureRuntime,
    accountErasureLeaseOwner: "account-erasure-worker:test-owner",
    onSyncWaitingChildren:
      vi.fn<(worker: import("bullmq").Worker, job: import("bullmq").Job) => void>(),
    getClickHouseClient: () => clickHouse,
    getImportUploadStorage: () => storage,
    getRefitSensorStore: () => createRefitSensorStore(clickHouse),
    refreshPostSyncBodyMeasurements: () => refreshBodyMeasurementReadModel(clickHouse),
  };
}

export async function workerLifecycleDependencies(
  queues: ReturnType<typeof import("../worker-queues.ts").createWorkerQueues>,
  dependencies: Awaited<ReturnType<typeof workerQueueDependencies>>,
): Promise<Parameters<typeof import("../worker-lifecycle.ts").createWorkerLifecycle>[0]> {
  const { startAccountErasureOutboxDispatcher } = await import("../account-erasure-outbox.ts");
  const { startProviderDataDeletionOutboxDispatcher } = await import(
    "../provider-data-deletion-outbox.ts"
  );
  const { startDataExportOutboxDispatcher } = await import("../data-export-outbox.ts");
  const { startFileUploadOutboxDispatcher } = await import("../file-upload-outbox.ts");
  const { startFileUploadReconciler } = await import("../file-upload-reconciliation.ts");
  const { createGarminImportProgressCoordinator } = await import("../garmin-import-progress.ts");
  const { createWorkerReadinessServer } = await import("../worker-readiness.ts");
  const {
    getAccountErasureQueue,
    getProviderDataDeletionQueue,
    getDataExportQueue,
    getImportQueue,
  } = await import("../queues.ts");
  const { db, connection } = dependencies;
  const readinessServer = createWorkerReadinessServer(queues.allWorkers);
  return {
    ...dependencies,
    allWorkers: queues.allWorkers,
    getReadinessServer: () => readinessServer,
    accountErasureOutboxDispatcher: startAccountErasureOutboxDispatcher(
      db,
      getAccountErasureQueue(),
    ),
    providerDataDeletionOutboxDispatcher: startProviderDataDeletionOutboxDispatcher(
      db,
      getProviderDataDeletionQueue(),
    ),
    dataExportOutboxDispatcher: startDataExportOutboxDispatcher(db, getDataExportQueue()),
    fileUploadOutboxDispatcher: startFileUploadOutboxDispatcher(db, getImportQueue()),
    fileUploadReconciler: startFileUploadReconciler(db, dependencies.getImportUploadStorage()),
    garminImportProgressCoordinator: createGarminImportProgressCoordinator(connection),
  };
}

export { hoisted };
