import { afterAll, describe, expect, it, vi } from "vitest";
import { APPLE_HEALTH_IMPORT_VALIDATION_ERROR_NAME } from "./import-validation-error.ts";

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

  function noOpExit(): never {
    throw new Error("process.exit called unexpectedly in test");
  }

  const mockOn = vi.fn();
  const mockClose = vi.fn(() => Promise.resolve());
  const mockRun = vi.fn(() => Promise.resolve());
  const mockAddJobLog = vi.fn(() => Promise.resolve(1));
  const mockDatabase = {
    $client: { end: vi.fn(() => Promise.resolve()) },
  };
  const mockClickHouseClient = {};
  const mockValidateAccountErasureLedgerKeyring = vi.fn();
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
  const workerOnMocks: Record<string, ReturnType<typeof vi.fn>> = {};
  const workerProcessors: Record<string, (job: unknown) => unknown> = {};

  const mockReadinessListen = vi.fn();
  const mockReadinessClose = vi.fn((callback: (error?: Error) => void) => callback());
  const mockReadinessServer = {
    listen: mockReadinessListen,
    close: mockReadinessClose,
  };
  const scheduledSyncState: { error: Error | null } = {
    error: null,
  };

  class MockUnrecoverableError extends Error {}

  const mockObserveFitJob = vi.fn();
  const reconcileGarminProgressError = new Error("progress Redis unavailable");
  const mockReconcileGarminProgress = vi.fn().mockRejectedValueOnce(reconcileGarminProgressError);
  const mockCloseGarminProgress = vi.fn().mockResolvedValue(undefined);
  const mockCloseAccountErasureOutbox = vi.fn().mockResolvedValue(undefined);
  const mockCloseAccountErasureRuntime = vi.fn().mockResolvedValue(undefined);
  const mockCloseAccountErasureWorkLockPool = vi.fn().mockResolvedValue(undefined);
  const mockCloseProviderDataDeletionOutbox = vi.fn().mockResolvedValue(undefined);
  const mockCloseDataExportOutbox = vi.fn().mockResolvedValue(undefined);
  const mockCloseFileUploadOutbox = vi.fn().mockResolvedValue(undefined);
  const mockCloseFileUploadReconciler = vi.fn().mockResolvedValue(undefined);
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

vi.mock("bullmq", () => ({
  Job: { addJobLog: hoisted.mockAddJobLog },
  UnrecoverableError: hoisted.MockUnrecoverableError,
  Worker: vi.fn((name: string, processor: (job: unknown) => unknown) => {
    const on = vi.fn((...args: unknown[]) => hoisted.mockOn(...args));
    hoisted.workerOnMocks[name] = on;
    hoisted.workerProcessors[name] = processor;
    return { name, on, close: hoisted.mockClose, run: hoisted.mockRun };
  }),
}));

vi.mock("../db/index.ts", () => ({
  createDatabaseFromEnv: vi.fn(() => hoisted.mockDatabase),
}));

vi.mock("../db/clickhouse.ts", () => ({
  createClickHouseClientFromEnv: vi.fn(() => hoisted.mockClickHouseClient),
}));

vi.mock("../account-erasure/identity.ts", () => ({
  validateAccountErasureLedgerKeyring: hoisted.mockValidateAccountErasureLedgerKeyring,
}));

vi.mock("../account-erasure/remote-snapshot.ts", () => ({
  createEncryptedAccountErasureSnapshot: vi.fn(),
}));

vi.mock("../account-erasure/restore-ledger.ts", () => ({
  createAccountErasureRestoreLedgerFromEnv: hoisted.mockCreateAccountErasureRestoreLedgerFromEnv,
}));

vi.mock("../account-erasure/restore-reconciliation.ts", () => ({
  reconcileAccountErasureRestoreIntents: hoisted.mockReconcileAccountErasureRestoreIntents,
}));

vi.mock("../db/clickhouse-read-model-refresh.ts", () => ({
  refreshBodyMeasurementReadModel: vi.fn(() => Promise.resolve()),
}));

vi.mock("../db/provider-data-deletion.ts", () => ({
  markProviderDataDeletionCompleted: vi.fn(() => Promise.resolve()),
  markProviderDataDeletionFailed: vi.fn(() => Promise.resolve()),
}));

vi.mock("../db/refit-sensor-store.ts", () => ({
  createRefitSensorStore: vi.fn(() => ({})),
}));

vi.mock("./process-file-upload-import-job.ts", () => ({
  processFileUploadImportJob: vi.fn(),
}));

vi.mock("../file-upload-storage.ts", () => ({
  createImportUploadStorageFromEnv: hoisted.mockCreateImportUploadStorage,
}));

vi.mock("./process-fit-file-import-job.ts", () => ({
  processFitFileImportJob: vi.fn(),
}));

vi.mock("./process-fit-file-import-batch-job.ts", () => ({
  processFitFileImportBatchJob: vi.fn(),
}));

vi.mock("./process-zip-entry-extract-job.ts", () => ({
  processZipEntryExtractJob: vi.fn(),
}));

vi.mock("./process-sync-job.ts", () => ({
  processSyncJob: vi.fn(),
}));

vi.mock("./process-export-job.ts", () => ({
  processExportJob: vi.fn(),
}));

vi.mock("./process-scheduled-sync-job.ts", () => ({
  processScheduledSyncJob: vi.fn(),
}));

vi.mock("./process-post-sync-job.ts", () => ({
  processPostSyncJob: vi.fn(),
}));

vi.mock("./process-activity-delete-analytics-job.ts", () => ({
  processActivityDeleteAnalyticsJob: vi.fn(),
}));

vi.mock("./process-provider-data-deletion-job.ts", () => ({
  processProviderDataDeletionJob: vi.fn(),
}));

vi.mock("./process-account-erasure-request.ts", () => ({
  processAccountErasureRequest: hoisted.mockProcessAccountErasureRequest,
}));

vi.mock("./account-erasure-runtime.ts", () => ({
  createAccountErasureRuntime: hoisted.mockCreateAccountErasureRuntime,
}));

vi.mock("./account-erasure-work-purger.ts", () => ({
  createAccountErasureWorkPurgerFromEnv: hoisted.mockCreateAccountErasureWorkPurgerFromEnv,
}));

vi.mock("./account-erasure-outbox.ts", () => ({
  startAccountErasureOutboxDispatcher: vi.fn(() => ({
    close: hoisted.mockCloseAccountErasureOutbox,
  })),
}));

vi.mock("./provider-data-deletion-outbox.ts", () => ({
  startProviderDataDeletionOutboxDispatcher: vi.fn(() => ({
    close: hoisted.mockCloseProviderDataDeletionOutbox,
  })),
}));

vi.mock("./data-export-outbox.ts", () => ({
  startDataExportOutboxDispatcher: vi.fn(() => ({
    close: hoisted.mockCloseDataExportOutbox,
  })),
}));

vi.mock("./file-upload-outbox.ts", () => ({
  startFileUploadOutboxDispatcher: vi.fn(() => ({
    close: hoisted.mockCloseFileUploadOutbox,
  })),
}));

vi.mock("./file-upload-reconciliation.ts", () => ({
  startFileUploadReconciler: vi.fn(() => ({
    close: hoisted.mockCloseFileUploadReconciler,
  })),
}));

vi.mock("./scheduled-sync.ts", () => ({
  setupScheduledSync: () =>
    hoisted.scheduledSyncState.error
      ? Promise.reject(hoisted.scheduledSyncState.error)
      : Promise.resolve(),
}));

vi.mock("./worker-readiness.ts", () => ({
  createWorkerReadinessServer: vi.fn(() => hoisted.mockReadinessServer),
}));

vi.mock("./garmin-import-progress.ts", () => ({
  createGarminImportProgressCoordinator: vi.fn(() => hoisted.mockGarminProgressCoordinator),
}));

vi.mock("./account-erasure-work-guard.ts", () => ({
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

vi.mock("./provider-queue-config.ts", () => ({
  getConfiguredProviderIds: vi.fn(() => ["strava", "garmin"]),
  getProviderQueueConfig: vi.fn(() => ({
    concurrency: 3,
    syncTier: "frequent",
    limiter: { max: 10, duration: 1000 },
  })),
}));

vi.mock("./queues.ts", () => ({
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
  init: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("../lib/posthog.ts", () => ({
  initProductionPostHog: vi.fn(),
  capturePostHogException: vi.fn(),
}));

vi.mock("../logger.ts", () => ({
  jobContext: { run: vi.fn((_store: unknown, fn: () => unknown) => fn()) },
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const {
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

// Static import ensures vitest `related` mode (used by Stryker in CI) detects this
// test file as related to worker.ts, so mutations in worker.ts are covered.
import "./worker.ts";

// Restore only the deployment-environment/DSN stubs so the "prod"
// classification does not outlive this file within a reused vitest fork.
// Use targeted vi.stubEnv calls (not vi.unstubAllEnvs) so future tests in this
// file can safely stub other env vars without having them implicitly cleared.
afterAll(() => {
  vi.stubEnv("DEPLOY_ENVIRONMENT", "test");
  vi.stubEnv("SENTRY_DSN", undefined);
});

describe("worker module", () => {
  // 2 per-provider workers (strava, garmin) + 1 legacy sync + 1 import + 1 FIT import
  // + 1 FIT batch + 1 ZIP extract + 1 export + 1 scheduled-sync + 1 post-sync
  // + 1 activity-delete-analytics + 1 provider-data-deletion + 1 account-erasure = 13
  // Training export is handled by the standalone Python BullMQ worker (packages/ml).
  const EXPECTED_WORKER_COUNT = 13;

  it("creates per-provider workers plus standard workers", async () => {
    const { Worker } = await import("bullmq");
    expect(Worker).toHaveBeenCalledTimes(EXPECTED_WORKER_COUNT);
    // Per-provider workers
    expect(Worker).toHaveBeenCalledWith("sync-strava", expect.any(Function), expect.any(Object));
    expect(Worker).toHaveBeenCalledWith("sync-garmin", expect.any(Function), expect.any(Object));
    // Legacy sync worker
    expect(Worker).toHaveBeenCalledWith("sync-queue", expect.any(Function), expect.any(Object));
    // Standard workers
    expect(Worker).toHaveBeenCalledWith("import-queue", expect.any(Function), expect.any(Object));
    expect(Worker).toHaveBeenCalledWith(
      "fit-file-import-queue",
      expect.any(Function),
      expect.objectContaining({ concurrency: 2 }),
    );
    expect(Worker).toHaveBeenCalledWith(
      "fit-file-import-batch-queue",
      expect.any(Function),
      expect.objectContaining({ concurrency: 1 }),
    );
    expect(Worker).toHaveBeenCalledWith(
      "zip-entry-extract-queue",
      expect.any(Function),
      expect.objectContaining({ concurrency: 2 }),
    );
    expect(Worker).toHaveBeenCalledWith("export-queue", expect.any(Function), expect.any(Object));
    expect(Worker).toHaveBeenCalledWith(
      "scheduled-sync-queue",
      expect.any(Function),
      expect.any(Object),
    );
    expect(Worker).toHaveBeenCalledWith(
      "post-sync-queue",
      expect.any(Function),
      expect.any(Object),
    );
    expect(Worker).toHaveBeenCalledWith(
      "activity-delete-analytics-queue",
      expect.any(Function),
      expect.objectContaining({ concurrency: 1 }),
    );
    expect(Worker).toHaveBeenCalledWith(
      "provider-data-deletion-queue",
      expect.any(Function),
      expect.objectContaining({ concurrency: 1 }),
    );
    expect(Worker).toHaveBeenCalledWith(
      "account-erasure-queue",
      expect.any(Function),
      expect.objectContaining({ concurrency: 1 }),
    );
  });

  it("reconciles external deletion intents before creating any queue worker", async () => {
    const { Worker } = await import("bullmq");
    expect(hoisted.mockValidateAccountErasureLedgerKeyring).toHaveBeenCalledOnce();
    expect(hoisted.mockReconcileAccountErasureRestoreIntents).toHaveBeenCalledWith(
      expect.objectContaining({
        database: mockDatabase,
        ledger: hoisted.mockAccountErasureRestoreLedger,
      }),
    );
    const reconciliationOrder =
      hoisted.mockReconcileAccountErasureRestoreIntents.mock.invocationCallOrder[0];
    const firstWorkerOrder = vi.mocked(Worker).mock.invocationCallOrder[0];
    expect(reconciliationOrder).toBeDefined();
    expect(firstWorkerOrder).toBeDefined();
    if (reconciliationOrder === undefined || firstWorkerOrder === undefined) {
      throw new Error("Startup invocation order was not recorded");
    }
    expect(reconciliationOrder).toBeLessThan(firstWorkerOrder);
  });

  it("initializes the durable erasure runtime before creating queue workers", async () => {
    const { Worker } = await import("bullmq");
    const { createAccountErasureRuntime } = await import("./account-erasure-runtime.ts");

    expect(createAccountErasureRuntime).toHaveBeenCalledWith(
      mockDatabase,
      mockClickHouseClient,
      hoisted.mockAccountErasureWorkPurger,
    );
    const runtimeOrder = hoisted.mockCreateAccountErasureRuntime.mock.invocationCallOrder[0];
    const firstWorkerOrder = vi.mocked(Worker).mock.invocationCallOrder[0];
    expect(runtimeOrder).toBeDefined();
    expect(firstWorkerOrder).toBeDefined();
    if (runtimeOrder === undefined || firstWorkerOrder === undefined) {
      throw new Error("Runtime startup invocation order was not recorded");
    }
    expect(runtimeOrder).toBeLessThan(firstWorkerOrder);
  });

  it("rejects invalid provider deletion jobs at the Redis boundary", () => {
    const processor = workerProcessors["provider-data-deletion-queue"];
    if (!processor) throw new Error("provider deletion processor was not registered");
    const data = {
      type: "provider-data-deletion",
      eventId: "10000000-0000-4000-8000-000000000001",
      generation: 2,
      providerId: "garmin",
      userId: "20000000-0000-4000-8000-000000000002",
      checkpoint: {
        batches: 1,
        deletedRows: 10_000,
        lastId: "30000000-0000-4000-8000-000000000003",
      },
    };
    const invalidJob = {
      data: { ...data, generation: "2" },
      updateData: vi.fn(async () => undefined),
      updateProgress: vi.fn(async () => undefined),
    };

    expect(() => processor(invalidJob)).toThrow(hoisted.MockUnrecoverableError);
  });

  it("passes limiter config to per-provider workers", async () => {
    const { Worker } = await import("bullmq");
    expect(Worker).toHaveBeenCalledWith(
      "sync-strava",
      expect.any(Function),
      expect.objectContaining({ limiter: { max: 10, duration: 1000 } }),
    );
  });

  it("attaches worker handlers before workers start processing jobs", async () => {
    const { Worker } = await import("bullmq");
    const workerOptions = vi.mocked(Worker).mock.calls.map((workerCall) => workerCall[2]);
    expect(workerOptions).toHaveLength(EXPECTED_WORKER_COUNT);
    for (const options of workerOptions) {
      expect(options).toEqual(expect.objectContaining({ autorun: false }));
    }

    expect(mockRun).toHaveBeenCalledTimes(EXPECTED_WORKER_COUNT);
    const lastHandlerRegistration =
      mockOn.mock.invocationCallOrder[mockOn.mock.invocationCallOrder.length - 1];
    const firstWorkerRun = mockRun.mock.invocationCallOrder[0];
    expect(lastHandlerRegistration).toBeDefined();
    expect(firstWorkerRun).toBeDefined();
    if (lastHandlerRegistration === undefined || firstWorkerRun === undefined) {
      throw new Error("Worker startup order was not recorded");
    }
    expect(lastHandlerRegistration).toBeLessThan(firstWorkerRun);
  });

  it("serves readiness from the worker process after starting every queue worker", async () => {
    const { Worker } = await import("bullmq");
    const { createWorkerReadinessServer } = await import("./worker-readiness.ts");
    const workerInstances = vi.mocked(Worker).mock.results.map((result) => result.value);

    expect(createWorkerReadinessServer).toHaveBeenCalledWith(workerInstances);
    expect(mockReadinessListen).toHaveBeenCalledWith(3001, "127.0.0.1");
    const lastWorkerRun =
      mockRun.mock.invocationCallOrder[mockRun.mock.invocationCallOrder.length - 1];
    const readinessListen = mockReadinessListen.mock.invocationCallOrder[0];
    expect(lastWorkerRun).toBeDefined();
    expect(readinessListen).toBeDefined();
    if (lastWorkerRun === undefined || readinessListen === undefined) {
      throw new Error("Worker readiness startup order was not recorded");
    }
    expect(lastWorkerRun).toBeLessThan(readinessListen);
  });

  it("initializes Sentry and PostHog when DSN is set", async () => {
    const Sentry = await import("@sentry/node");
    const { initProductionPostHog } = await import("../lib/posthog.ts");
    expect(Sentry.init).toHaveBeenCalledWith({
      beforeSend: expect.any(Function),
      dsn: "https://test@sentry.io/123",
      environment: "production",
      skipOpenTelemetrySetup: true,
    });
    expect(initProductionPostHog).toHaveBeenCalledWith("dofek-worker");
  });

  it("registers standard handlers plus FIT progress observers", () => {
    expect(mockOn).toHaveBeenCalledTimes(6 * EXPECTED_WORKER_COUNT + 3);
    const events = mockOn.mock.calls.map((call) => String(call[0]));
    expect(events.filter((e: string) => e === "active")).toHaveLength(EXPECTED_WORKER_COUNT);
    expect(events.filter((e: string) => e === "completed")).toHaveLength(EXPECTED_WORKER_COUNT + 1);
    expect(events.filter((e: string) => e === "failed")).toHaveLength(EXPECTED_WORKER_COUNT + 2);
    expect(events.filter((e: string) => e === "stalled")).toHaveLength(EXPECTED_WORKER_COUNT);
    expect(events.filter((e: string) => e === "lockRenewalFailed")).toHaveLength(
      EXPECTED_WORKER_COUNT,
    );
    expect(events.filter((e: string) => e === "error")).toHaveLength(EXPECTED_WORKER_COUNT);
  });

  it("reports a durable Garmin progress reconciliation failure when the worker starts", async () => {
    const Sentry = await import("@sentry/node");
    const { logger } = await import("../logger.ts");

    expect(mockReconcileGarminProgress).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(Sentry.captureException).toHaveBeenCalledWith(reconcileGarminProgressError, {
        tags: { garminDumpStep: "progress-reconcile" },
      });
    });
    expect(logger.error).toHaveBeenCalledWith(
      "[worker] Failed to reconcile Garmin import progress: Error: progress Redis unavailable",
    );
  });

  it("starts export outbox recovery with the durable database row and export queue", async () => {
    const { startDataExportOutboxDispatcher } = await import("./data-export-outbox.ts");
    const { getDataExportQueue } = await import("./queues.ts");

    expect(startDataExportOutboxDispatcher).toHaveBeenCalledWith(
      mockDatabase,
      vi.mocked(getDataExportQueue).mock.results[0]?.value,
    );
  });

  it("starts account erasure outbox recovery with the durable request row", async () => {
    const { startAccountErasureOutboxDispatcher } = await import("./account-erasure-outbox.ts");
    const { getAccountErasureQueue } = await import("./queues.ts");

    expect(startAccountErasureOutboxDispatcher).toHaveBeenCalledWith(
      mockDatabase,
      vi.mocked(getAccountErasureQueue).mock.results[0]?.value,
    );
  });

  it("observes completed and failed FIT jobs for durable parent progress", () => {
    mockObserveFitJob.mockClear();
    const completedHandlers = mockOn.mock.calls.filter((mockCall) => mockCall[0] === "completed");
    const failedHandlers = mockOn.mock.calls.filter((mockCall) => mockCall[0] === "failed");
    const completedHandler = completedHandlers.at(-1)?.[1];
    const failedHandler = failedHandlers.at(-1)?.[1];
    if (typeof completedHandler !== "function" || typeof failedHandler !== "function") {
      throw new Error("FIT progress handlers were not registered");
    }
    const fitJob = { id: "fit-1", parent: { id: "batch-1", queueKey: "bull:fit-batch" } };

    completedHandler(fitJob);
    failedHandler(fitJob, new Error("invalid FIT"));
    failedHandler(undefined, new Error("missing FIT job"));

    expect(mockObserveFitJob).toHaveBeenNthCalledWith(1, fitJob);
    expect(mockObserveFitJob).toHaveBeenNthCalledWith(2, fitJob);
    expect(mockObserveFitJob).toHaveBeenCalledTimes(2);
  });

  it("registers SIGTERM and SIGINT handlers", () => {
    const signalListeners = process.listeners("SIGTERM");
    expect(signalListeners.length).toBeGreaterThan(0);
  });

  it("does not actually exit", () => {
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("starts idle timer at init (setTimeout called)", () => {
    // Module init calls startIdleTimer() which calls setTimeout
    expect(setTimeoutSpy).toHaveBeenCalled();
  });

  function getQueueWorkerHandler(
    queueName: string,
    eventName: string,
  ): (...args: unknown[]) => unknown {
    const on = workerOnMocks[queueName];
    if (!on) throw new Error(`${queueName} worker on mock was not registered`);
    const call = on.mock.calls.find((mockCall) => mockCall[0] === eventName);
    expect(call).toBeDefined();
    const handler = call?.[1];
    if (typeof handler !== "function") {
      throw new Error(`No ${eventName} handler registered for ${queueName}`);
    }
    return handler;
  }

  function getWorkerHandler(eventName: string): (...args: unknown[]) => unknown {
    return getQueueWorkerHandler("sync-strava", eventName);
  }

  it("active event handler resets idle timer without starting a new one", () => {
    const clearBefore = clearTimeoutSpy.mock.calls.length;
    const setTimeoutBefore = setTimeoutSpy.mock.calls.length;

    getWorkerHandler("active")();

    expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(clearBefore);
    expect(setTimeoutSpy.mock.calls.length).toBe(setTimeoutBefore);
    getWorkerHandler("completed")();
  });

  it("completed event handler restarts idle timer when no active jobs", () => {
    getWorkerHandler("active")();
    const setTimeoutBefore = setTimeoutSpy.mock.calls.length;

    getWorkerHandler("completed")();

    expect(setTimeoutSpy.mock.calls.length).toBeGreaterThan(setTimeoutBefore);
  });

  it("completed event handler does not restart idle timer while another job is active", () => {
    getWorkerHandler("active")();
    getWorkerHandler("active")();
    const setTimeoutBefore = setTimeoutSpy.mock.calls.length;

    getWorkerHandler("completed")();

    expect(setTimeoutSpy.mock.calls.length).toBe(setTimeoutBefore);
    getWorkerHandler("completed")();
  });

  it("failed event handler reports to Sentry and logs the error", async () => {
    const Sentry = await import("@sentry/node");
    const { logger } = await import("../logger.ts");
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(logger.error).mockClear();

    getWorkerHandler("active")();
    const error = new Error("test failure");
    const setTimeoutBefore = setTimeoutSpy.mock.calls.length;
    getWorkerHandler("failed")(undefined, error);

    expect(Sentry.captureException).toHaveBeenCalledWith(error);
    expect(logger.error).toHaveBeenCalledWith("[worker] Job failed: test failure");
    expect(setTimeoutSpy.mock.calls.length).toBeGreaterThan(setTimeoutBefore);
  });

  it("failed event handler appends the detailed cause to the BullMQ job log", async () => {
    mockAddJobLog.mockClear();
    mockAddJobLog.mockResolvedValue(1);
    const failedJob = { id: "failed-fit-1" };

    getWorkerHandler("failed")(failedJob, new Error("invalid timestamp in activity.fit"));
    await vi.waitFor(() => {
      expect(mockAddJobLog).toHaveBeenCalledWith(
        expect.objectContaining({ name: "sync-strava" }),
        "failed-fit-1",
        "[error] BullMQ job failed: queue=sync-strava jobId=failed-fit-1 cause=invalid timestamp in activity.fit",
        100,
      );
    });
  });

  it("sanitizes account erasure job failures across Sentry, logs, and BullMQ", async () => {
    const Sentry = await import("@sentry/node");
    const { logger } = await import("../logger.ts");
    const privateRequestId = "10000000-0000-4000-8000-000000001994";
    const privateFailure = new Error("Processor rejected private@example.com");
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(logger.error).mockClear();
    mockAddJobLog.mockClear();

    getQueueWorkerHandler("account-erasure-queue", "failed")(
      { id: privateRequestId },
      privateFailure,
    );

    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Account erasure job failed",
      }),
      {
        tags: {
          bullmqEvent: "failed",
          queue: "account-erasure-queue",
        },
      },
    );
    expect(logger.error).toHaveBeenCalledWith("[worker] Account erasure job failed");
    expect(mockAddJobLog).not.toHaveBeenCalled();
    const capturedMessages = vi
      .mocked(Sentry.captureException)
      .mock.calls.map(([error]) => (error instanceof Error ? error.message : String(error)))
      .join("\n");
    const loggedMessages = vi.mocked(logger.error).mock.calls.flat().map(String).join("\n");
    expect(`${capturedMessages}\n${loggedMessages}`).not.toContain(privateRequestId);
    expect(`${capturedMessages}\n${loggedMessages}`).not.toContain("private@example.com");
  });

  it("sanitizes account erasure stalled, lock, and worker errors", async () => {
    const Sentry = await import("@sentry/node");
    const { logger } = await import("../logger.ts");
    const privateRequestId = "20000000-0000-4000-8000-000000001994";
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(logger.error).mockClear();
    mockAddJobLog.mockClear();

    getQueueWorkerHandler("account-erasure-queue", "stalled")(privateRequestId, "active");
    getQueueWorkerHandler("account-erasure-queue", "lockRenewalFailed")([privateRequestId]);
    getQueueWorkerHandler(
      "account-erasure-queue",
      "error",
    )(new Error("Redis rejected private@example.com"));

    const capturedMessages = vi
      .mocked(Sentry.captureException)
      .mock.calls.map(([error]) => (error instanceof Error ? error.message : String(error)));
    expect(capturedMessages).toEqual([
      "Account erasure BullMQ job stalled",
      "Account erasure BullMQ lock renewal failed",
      "Account erasure worker error",
    ]);
    expect(vi.mocked(logger.error).mock.calls).toEqual([
      ["[worker] Account erasure BullMQ job stalled"],
      ["[worker] Account erasure BullMQ lock renewal failed"],
      ["[worker] Account erasure worker error"],
    ]);
    expect(mockAddJobLog).not.toHaveBeenCalled();
    expect(capturedMessages.join("\n")).not.toContain(privateRequestId);
    expect(capturedMessages.join("\n")).not.toContain("private@example.com");
  });

  it("reports a failed-event BullMQ job-log write failure", async () => {
    const Sentry = await import("@sentry/node");
    const { logger } = await import("../logger.ts");
    const logError = new Error("job log Redis unavailable");
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(logger.error).mockClear();
    mockAddJobLog.mockRejectedValueOnce(logError);

    getWorkerHandler("failed")({ id: "failed-fit-log-1" }, new Error("invalid FIT"));

    await vi.waitFor(() => {
      expect(Sentry.captureException).toHaveBeenCalledWith(logError, {
        tags: { bullmqEvent: "failed", queue: "sync-strava" },
        extra: { jobId: "failed-fit-log-1", operation: "addJobLog" },
      });
    });
    expect(logger.error).toHaveBeenCalledWith(
      "[worker] Failed to append failed job log: queue=sync-strava jobId=failed-fit-log-1: Error: job log Redis unavailable",
    );
  });

  it("failed event handler does not restart idle timer while another job is active", async () => {
    const Sentry = await import("@sentry/node");
    vi.mocked(Sentry.captureException).mockClear();
    getWorkerHandler("active")();
    getWorkerHandler("active")();
    const setTimeoutBefore = setTimeoutSpy.mock.calls.length;

    getWorkerHandler("failed")(undefined, new Error("one of two jobs failed"));

    expect(Sentry.captureException).toHaveBeenCalledOnce();
    expect(setTimeoutSpy.mock.calls.length).toBe(setTimeoutBefore);
    getWorkerHandler("completed")();
  });

  it("failed event handler ignores stale failed jobs for idle accounting", async () => {
    const Sentry = await import("@sentry/node");
    vi.mocked(Sentry.captureException).mockClear();
    getWorkerHandler("active")({ id: "active-job" });
    const setTimeoutBefore = setTimeoutSpy.mock.calls.length;

    getWorkerHandler("failed")({ id: "stale-job" }, new Error("stale stalled job"));

    expect(Sentry.captureException).toHaveBeenCalledOnce();
    expect(setTimeoutSpy.mock.calls.length).toBe(setTimeoutBefore);
    getWorkerHandler("completed")({ id: "active-job" });
  });

  // ── FIT batch child failure suppression tests ──
  // Each worker gets its own `on` mock; tests resolve a specific worker's
  // handler by queue name via workerOnMocks rather than relying on call order.
  function getWorkerFailedHandler(queueName: string): (...args: unknown[]) => unknown {
    const on = workerOnMocks[queueName];
    if (!on) throw new Error(`${queueName} worker on mock was not registered`);
    const failedCall = on.mock.calls.find((call) => call[0] === "failed");
    if (!failedCall || typeof failedCall[1] !== "function") {
      throw new Error(`${queueName} worker failed handler was not registered`);
    }
    return failedCall[1];
  }

  function getFitWorkerFailedHandler(): (...args: unknown[]) => unknown {
    return getWorkerFailedHandler("fit-file-import-queue");
  }

  function getProviderDataDeletionRedriveHandler(): (...args: unknown[]) => unknown {
    const on = workerOnMocks["provider-data-deletion-queue"];
    if (!on) throw new Error("provider deletion worker on mock was not registered");
    const failedCall = on.mock.calls.find((call) => call[0] === "failed");
    if (!failedCall || typeof failedCall[1] !== "function") {
      throw new Error("provider deletion redrive handler was not registered");
    }
    return failedCall[1];
  }

  it("redrives provider deletion after BullMQ exhausts all attempts", async () => {
    const retry = vi.fn(async () => undefined);

    getProviderDataDeletionRedriveHandler()(
      { attemptsMade: 20, opts: { attempts: 20 }, retry },
      new Error("ClickHouse unavailable"),
    );

    await vi.waitFor(() => {
      expect(retry).toHaveBeenCalledWith("failed", {
        resetAttemptsMade: true,
        resetAttemptsStarted: true,
      });
    });
  });

  it("lets BullMQ handle provider deletion failures before the terminal attempt", () => {
    const retry = vi.fn(async () => undefined);

    getProviderDataDeletionRedriveHandler()(
      { attemptsMade: 19, opts: { attempts: 20 }, retry },
      new Error("ClickHouse unavailable"),
    );

    expect(retry).not.toHaveBeenCalled();
  });

  it("ignores provider deletion failure events without a job", async () => {
    const { markProviderDataDeletionFailed } = await import("../db/provider-data-deletion.ts");
    vi.mocked(markProviderDataDeletionFailed).mockClear();

    expect(
      getProviderDataDeletionRedriveHandler()(undefined, new Error("Missing BullMQ job")),
    ).toBeUndefined();
    expect(markProviderDataDeletionFailed).not.toHaveBeenCalled();
  });

  it("persists unrecoverable provider deletion failures", async () => {
    const { markProviderDataDeletionFailed } = await import("../db/provider-data-deletion.ts");
    const retry = vi.fn(async () => undefined);
    vi.mocked(markProviderDataDeletionFailed).mockClear();

    getProviderDataDeletionRedriveHandler()(
      {
        attemptsMade: 20,
        data: { eventId: "10000000-0000-4000-8000-000000000001" },
        opts: { attempts: 20 },
        retry,
      },
      new hoisted.MockUnrecoverableError("Invalid provider data deletion job payload"),
    );

    expect(retry).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(markProviderDataDeletionFailed).toHaveBeenCalledWith(
        hoisted.mockDatabase,
        "10000000-0000-4000-8000-000000000001",
        "Invalid provider data deletion job payload",
      ),
    );
  });

  it("reports provider deletion failure persistence errors", async () => {
    const Sentry = await import("@sentry/node");
    const { markProviderDataDeletionFailed } = await import("../db/provider-data-deletion.ts");
    const { logger } = await import("../logger.ts");
    const persistenceError = new Error("Postgres unavailable");
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(markProviderDataDeletionFailed).mockRejectedValueOnce(persistenceError);
    vi.mocked(logger.error).mockClear();

    getProviderDataDeletionRedriveHandler()(
      {
        attemptsMade: 20,
        data: { eventId: "10000000-0000-4000-8000-000000000001" },
        opts: { attempts: 20 },
        retry: vi.fn(async () => undefined),
      },
      new hoisted.MockUnrecoverableError("Invalid provider data deletion job payload"),
    );

    await vi.waitFor(() =>
      expect(Sentry.captureException).toHaveBeenCalledWith(persistenceError, {
        tags: { providerDataDeletionStep: "persistFailure" },
        extra: { eventId: "10000000-0000-4000-8000-000000000001" },
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      "[provider-data-deletion] Failed to persist terminal failure for 10000000-0000-4000-8000-000000000001: Error: Postgres unavailable",
    );
  });

  it("reports a provider deletion redrive failure with the deletion event context", async () => {
    const Sentry = await import("@sentry/node");
    const { markProviderDataDeletionFailed } = await import("../db/provider-data-deletion.ts");
    const { logger } = await import("../logger.ts");
    const redriveError = new Error("Redis unavailable");
    const retry = vi.fn().mockRejectedValue(redriveError);
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(markProviderDataDeletionFailed).mockClear();
    vi.mocked(logger.error).mockClear();

    getProviderDataDeletionRedriveHandler()(
      {
        attemptsMade: 20,
        data: { eventId: "10000000-0000-4000-8000-000000000001" },
        opts: { attempts: 20 },
        retry,
      },
      new Error("ClickHouse unavailable"),
    );

    await vi.waitFor(() =>
      expect(Sentry.captureException).toHaveBeenCalledWith(redriveError, {
        tags: { providerDataDeletionStep: "redrive" },
        extra: { eventId: "10000000-0000-4000-8000-000000000001" },
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      "[provider-data-deletion] Failed to redrive terminal job 10000000-0000-4000-8000-000000000001: Error: Redis unavailable",
    );
    expect(markProviderDataDeletionFailed).toHaveBeenCalledWith(
      hoisted.mockDatabase,
      "10000000-0000-4000-8000-000000000001",
      "ClickHouse unavailable",
    );
  });

  it("suppresses Sentry for FIT batch child failures with UnrecoverableError", async () => {
    const Sentry = await import("@sentry/node");
    const { UnrecoverableError } = await import("bullmq");
    vi.mocked(Sentry.captureException).mockClear();

    const job = { id: "fit-child-1", parentKey: "bull:fit-batch:batch-1" };
    const error = new UnrecoverableError("invalid FIT file");
    getFitWorkerFailedHandler()(job, error);

    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("suppresses Sentry for invalid Apple Health import archives", async () => {
    const Sentry = await import("@sentry/node");
    const { UnrecoverableError } = await import("bullmq");
    vi.mocked(Sentry.captureException).mockClear();

    const error = new UnrecoverableError(
      "Apple Health ZIP must contain export.xml; upload the original Apple Health export archive",
    );
    error.name = APPLE_HEALTH_IMPORT_VALIDATION_ERROR_NAME;
    getWorkerFailedHandler("import-queue")({ id: "apple-health-import-1" }, error);

    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("does not suppress Sentry for FIT worker failures without UnrecoverableError", async () => {
    const Sentry = await import("@sentry/node");
    vi.mocked(Sentry.captureException).mockClear();

    const job = { id: "fit-child-2", parentKey: "bull:fit-batch:batch-2" };
    const error = new Error("transient connection error");
    getFitWorkerFailedHandler()(job, error);

    expect(Sentry.captureException).toHaveBeenCalledWith(error);
  });

  it("does not suppress Sentry for non-FIT worker UnrecoverableError failures", async () => {
    const Sentry = await import("@sentry/node");
    const { UnrecoverableError } = await import("bullmq");
    vi.mocked(Sentry.captureException).mockClear();

    const job = { id: "sync-child-1", parentKey: "bull:sync-batch:batch-1" };
    const error = new UnrecoverableError("unrecoverable sync error");
    getWorkerFailedHandler("sync-queue")(job, error);

    expect(Sentry.captureException).toHaveBeenCalledWith(error);
  });

  it("does not suppress Sentry for FIT worker failures without a parent job", async () => {
    const Sentry = await import("@sentry/node");
    const { UnrecoverableError } = await import("bullmq");
    vi.mocked(Sentry.captureException).mockClear();

    const error = new UnrecoverableError("unrecoverable fit error");
    getFitWorkerFailedHandler()(undefined, error);

    expect(Sentry.captureException).toHaveBeenCalledWith(error);
  });

  it("error event handler reports to Sentry and logs the error", async () => {
    const Sentry = await import("@sentry/node");
    const { logger } = await import("../logger.ts");
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(logger.error).mockClear();

    const errorCall = mockOn.mock.calls.find((call) => call[0] === "error");
    expect(errorCall).toBeDefined();
    const error = new Error("test worker error");
    errorCall?.[1](error);

    expect(Sentry.captureException).toHaveBeenCalledWith(error);
    expect(logger.error).toHaveBeenCalledWith("[worker] Worker error: test worker error");
  });

  it("stalled event handler reports to Sentry and appends the failure to the BullMQ job log", async () => {
    const Sentry = await import("@sentry/node");
    const { logger } = await import("../logger.ts");
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(logger.error).mockClear();
    mockAddJobLog.mockClear();

    getWorkerHandler("stalled")("stalled-job-1", "active");
    await vi.waitFor(() => expect(mockAddJobLog).toHaveBeenCalledOnce());

    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "BullMQ job stalled: queue=sync-strava jobId=stalled-job-1 previousState=active",
      }),
      expect.objectContaining({
        tags: expect.objectContaining({ bullmqEvent: "stalled", queue: "sync-strava" }),
      }),
    );
    expect(mockAddJobLog).toHaveBeenCalledWith(
      expect.objectContaining({ name: "sync-strava" }),
      "stalled-job-1",
      "[error] BullMQ job stalled: queue=sync-strava jobId=stalled-job-1 previousState=active",
      100,
    );
    expect(logger.error).toHaveBeenCalledWith(
      "[worker] BullMQ job stalled: queue=sync-strava jobId=stalled-job-1 previousState=active",
    );
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it("reports a stalled-event job-log write failure", async () => {
    const Sentry = await import("@sentry/node");
    const { logger } = await import("../logger.ts");
    const logError = new Error("Redis job log unavailable");
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(logger.error).mockClear();
    mockAddJobLog.mockRejectedValueOnce(logError);

    getWorkerHandler("stalled")("stalled-job-1", "active");
    await vi.waitFor(() => expect(Sentry.captureException).toHaveBeenCalledWith(logError));

    expect(logger.error).toHaveBeenCalledWith(
      "[worker] Failed to append stalled job log: Error: Redis job log unavailable",
    );
  });

  it("lockRenewalFailed event handler reports to Sentry and appends the failure to every BullMQ job log", async () => {
    const Sentry = await import("@sentry/node");
    const { logger } = await import("../logger.ts");
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(logger.error).mockClear();
    mockAddJobLog.mockClear();

    getWorkerHandler("lockRenewalFailed")(["locked-job-1", "locked-job-2"]);
    await vi.waitFor(() => expect(mockAddJobLog).toHaveBeenCalledTimes(2));

    const message =
      "BullMQ lock renewal failed: queue=sync-strava jobIds=locked-job-1,locked-job-2";
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message }),
      expect.objectContaining({
        tags: expect.objectContaining({
          bullmqEvent: "lockRenewalFailed",
          queue: "sync-strava",
        }),
        extra: { jobIds: ["locked-job-1", "locked-job-2"] },
      }),
    );
    expect(mockAddJobLog).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ name: "sync-strava" }),
      "locked-job-1",
      `[error] ${message}`,
      100,
    );
    expect(mockAddJobLog).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ name: "sync-strava" }),
      "locked-job-2",
      `[error] ${message}`,
      100,
    );
    expect(logger.error).toHaveBeenCalledWith(`[worker] ${message}`);
  });

  it("reports a lock-renewal job-log write failure with queue and job context", async () => {
    const Sentry = await import("@sentry/node");
    const { logger } = await import("../logger.ts");
    const logError = new Error("Redis job log unavailable");
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(logger.error).mockClear();
    mockAddJobLog.mockRejectedValueOnce(logError);

    getWorkerHandler("lockRenewalFailed")(["locked-job-1"]);
    await vi.waitFor(() =>
      expect(Sentry.captureException).toHaveBeenCalledWith(logError, {
        tags: { bullmqEvent: "lockRenewalFailed", queue: "sync-strava" },
        extra: { jobId: "locked-job-1", operation: "addJobLog" },
      }),
    );

    expect(logger.error).toHaveBeenCalledWith(
      "[worker] Failed to append lock renewal failure job log: queue=sync-strava jobId=locked-job-1: Error: Redis job log unavailable",
    );
  });

  it("unhandledRejection handler reports to Sentry and logs", async () => {
    const Sentry = await import("@sentry/node");
    const { logger } = await import("../logger.ts");
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(logger.error).mockClear();

    const handlers = process.listeners("unhandledRejection");
    const handler = handlers[handlers.length - 1];
    expect(handler).toBeDefined();
    const error = new Error("test unhandled");
    handler?.(error, Promise.resolve());

    expect(Sentry.captureException).toHaveBeenCalledWith(error);
    expect(logger.error).toHaveBeenCalled();
  });

  // ── Processor callback tests ──
  // Invoke each worker's processor to verify it delegates to the correct job handler.

  /**
   * Invoke the processor function registered for a given queue name with mock job data.
   * Uses Reflect.apply to call the BullMQ Processor without needing a full Job instance.
   * Optionally pass a token (second argument to BullMQ processor).
   */
  async function invokeProcessor(
    queueName: string,
    jobData: Record<string, unknown>,
    token?: string,
    jobOverrides?: Record<string, unknown>,
  ): Promise<void> {
    const { Worker } = await import("bullmq");
    const call = vi.mocked(Worker).mock.calls.find((workerCall) => workerCall[0] === queueName);
    const processor = call?.[1];
    if (typeof processor !== "function") {
      throw new Error(`No processor function found for queue "${queueName}"`);
    }
    const mockJob = { data: jobData, id: "test-job-1", ...jobOverrides };
    await Reflect.apply(processor, undefined, [mockJob, token]);
  }

  it("per-provider sync processor delegates to processSyncJob", async () => {
    const { processSyncJob } = await import("./process-sync-job.ts");
    vi.mocked(processSyncJob).mockClear();

    await invokeProcessor("sync-strava", { providerId: "strava", userId: "user-1" });

    expect(processSyncJob).toHaveBeenCalled();
  });

  it("legacy sync processor delegates to processSyncJob and logs warning", async () => {
    const { processSyncJob } = await import("./process-sync-job.ts");
    const { logger } = await import("../logger.ts");
    vi.mocked(processSyncJob).mockClear();
    vi.mocked(logger.warn).mockClear();

    await invokeProcessor("sync-queue", { providerId: "wahoo", userId: "user-1" });

    expect(processSyncJob).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("import processor delegates to processFileUploadImportJob", async () => {
    const { processFileUploadImportJob } = await import("./process-file-upload-import-job.ts");
    vi.mocked(processFileUploadImportJob).mockClear();
    hoisted.mockCreateImportUploadStorage.mockClear();

    await invokeProcessor("import-queue", {
      filePath: "/tmp/f",
      since: "2026-01-01",
      userId: "u",
      importType: "apple-health",
    });

    expect(processFileUploadImportJob).toHaveBeenCalled();
    expect(processFileUploadImportJob).toHaveBeenCalledWith(
      expect.any(Object),
      mockDatabase,
      hoisted.mockImportUploadStorage,
    );
    expect(hoisted.mockCreateImportUploadStorage).not.toHaveBeenCalled();
  });

  it("import processor fails loudly when BullMQ omits the job ID", async () => {
    const { processFileUploadImportJob } = await import("./process-file-upload-import-job.ts");
    vi.mocked(processFileUploadImportJob).mockClear();

    await expect(
      invokeProcessor(
        "import-queue",
        {
          filePath: "/tmp/f",
          since: "2026-01-01",
          userId: "u",
          importType: "garmin-dump",
        },
        "token-1",
        { id: undefined },
      ),
    ).rejects.toThrow("BullMQ import job ID missing");

    expect(processFileUploadImportJob).not.toHaveBeenCalled();
  });

  it("import processor passes a token-backed lock extender to processFileUploadImportJob", async () => {
    const { processFileUploadImportJob } = await import("./process-file-upload-import-job.ts");
    vi.mocked(processFileUploadImportJob).mockClear();
    const extendLock = vi.fn().mockResolvedValue(1);

    await invokeProcessor(
      "import-queue",
      {
        filePath: "/tmp/f",
        since: "2026-01-01",
        userId: "u",
        importType: "garmin-dump",
      },
      "token-1",
      { extendLock },
    );

    const processCall = vi.mocked(processFileUploadImportJob).mock.calls[0];
    const job = processCall?.[0];
    expect(job).toBeDefined();
    if (!job) {
      throw new Error("processFileUploadImportJob was not called");
    }

    await job.extendLock(600_000);

    expect(extendLock).toHaveBeenCalledWith("token-1", 600_000);
  });

  it("import processor exposes token-bound durable flow operations to processFileUploadImportJob", async () => {
    const { processFileUploadImportJob } = await import("./process-file-upload-import-job.ts");
    vi.mocked(processFileUploadImportJob).mockClear();
    const updateProgress = vi.fn().mockResolvedValue(undefined);
    const updateData = vi.fn().mockResolvedValue(undefined);
    const moveToWaitingChildren = vi.fn().mockResolvedValue(true);
    const getChildrenValues = vi.fn().mockResolvedValue({ "bull:fit-batch:batch-1": {} });
    const getIgnoredChildrenFailures = vi.fn().mockResolvedValue({});
    const nextData = {
      uploadId: "00000000-0000-4000-8000-0000000000f6",
      userId: "u",
      importType: "garmin-dump" as const,
      checkpoint: { version: 1 },
    };

    await invokeProcessor(
      "import-queue",
      {
        filePath: "/tmp/f",
        since: "2026-01-01",
        userId: "u",
        importType: "garmin-dump",
      },
      "token-1",
      {
        queueQualifiedName: "bull:import-queue",
        updateProgress,
        updateData,
        moveToWaitingChildren,
        getChildrenValues,
        getIgnoredChildrenFailures,
      },
    );

    const processCall = vi.mocked(processFileUploadImportJob).mock.calls[0];
    const durableJob = processCall?.[0];
    expect(durableJob).toBeDefined();
    if (!durableJob) {
      throw new Error("processFileUploadImportJob was not called");
    }

    expect(durableJob.id).toBe("test-job-1");
    expect(durableJob.queueQualifiedName).toBe("bull:import-queue");
    await durableJob.updateProgress({ percentage: 25 });
    await durableJob.updateData(nextData);
    await expect(durableJob.moveToWaitingChildren()).resolves.toBe(true);
    await expect(durableJob.getChildrenValues()).resolves.toEqual({
      "bull:fit-batch:batch-1": {},
    });
    await expect(durableJob.getIgnoredChildrenFailures()).resolves.toEqual({});
    mockAddJobLog.mockClear();
    await durableJob.log("[phase] prepared");

    expect(updateProgress).toHaveBeenCalledWith({ percentage: 25 });
    expect(updateData).toHaveBeenCalledWith(nextData);
    expect(moveToWaitingChildren).toHaveBeenCalledWith("token-1");
    expect(getChildrenValues).toHaveBeenCalledOnce();
    expect(getIgnoredChildrenFailures).toHaveBeenCalledOnce();
    expect(mockAddJobLog).toHaveBeenCalledWith(
      expect.objectContaining({ name: "import-queue" }),
      "test-job-1",
      "[phase] prepared",
      500,
    );
  });

  it("import processor lock extender fails loudly when BullMQ omits the token", async () => {
    const { processFileUploadImportJob } = await import("./process-file-upload-import-job.ts");
    vi.mocked(processFileUploadImportJob).mockClear();
    const extendLock = vi.fn().mockResolvedValue(1);

    await invokeProcessor(
      "import-queue",
      {
        filePath: "/tmp/f",
        since: "2026-01-01",
        userId: "u",
        importType: "garmin-dump",
      },
      undefined,
      { extendLock },
    );

    const processCall = vi.mocked(processFileUploadImportJob).mock.calls[0];
    const job = processCall?.[0];
    expect(job).toBeDefined();
    if (!job) {
      throw new Error("processFileUploadImportJob was not called");
    }

    await expect(job.extendLock(600_000)).rejects.toThrow("BullMQ import job lock token missing");
    expect(extendLock).not.toHaveBeenCalled();
  });

  it("import processor lock extender fails when BullMQ no longer owns the lock", async () => {
    const { processFileUploadImportJob } = await import("./process-file-upload-import-job.ts");
    vi.mocked(processFileUploadImportJob).mockClear();
    const extendLock = vi.fn().mockResolvedValue(0);

    await invokeProcessor(
      "import-queue",
      {
        filePath: "/tmp/f",
        since: "2026-01-01",
        userId: "u",
        importType: "garmin-dump",
      },
      "stale-token",
      { extendLock },
    );

    const processCall = vi.mocked(processFileUploadImportJob).mock.calls[0];
    const job = processCall?.[0];
    expect(job).toBeDefined();
    if (!job) {
      throw new Error("processFileUploadImportJob was not called");
    }

    await expect(job.extendLock(600_000)).rejects.toThrow(
      "BullMQ import job lock is no longer owned: test-job-1",
    );
    expect(extendLock).toHaveBeenCalledWith("stale-token", 600_000);
  });

  it("export processor delegates to processExportJob", async () => {
    const { processExportJob } = await import("./process-export-job.ts");
    vi.mocked(processExportJob).mockClear();

    await invokeProcessor("export-queue", { exportId: "export-1", userId: "u" });

    expect(processExportJob).toHaveBeenCalled();
  });

  it("FIT file import processor delegates to processFitFileImportJob", async () => {
    const { processFitFileImportJob } = await import("./process-fit-file-import-job.ts");
    vi.mocked(processFitFileImportJob).mockClear();

    await invokeProcessor("fit-file-import-queue", {
      filePath: "/tmp/activity.fit",
      originalPath: "activity.fit",
      userId: "u",
      providerId: "garmin-dump",
      sourceName: "Garmin Dump",
    });

    expect(processFitFileImportJob).toHaveBeenCalled();
  });

  it("FIT file import batch processor delegates to processFitFileImportBatchJob", async () => {
    const { processFitFileImportBatchJob } = await import("./process-fit-file-import-batch-job.ts");
    vi.mocked(processFitFileImportBatchJob).mockClear();

    await invokeProcessor("fit-file-import-batch-queue", { type: "fit-file-import-batch" });

    expect(processFitFileImportBatchJob).toHaveBeenCalled();
  });

  it("ZIP entry extract processor delegates to processZipEntryExtractJob", async () => {
    const { processZipEntryExtractJob } = await import("./process-zip-entry-extract-job.ts");
    vi.mocked(processZipEntryExtractJob).mockClear();

    await invokeProcessor("zip-entry-extract-queue", {
      archivePath: "/tmp/archive.zip",
      entryPath: ["activity.fit"],
      outputExtension: "fit",
    });

    expect(processZipEntryExtractJob).toHaveBeenCalled();
  });

  it("scheduled-sync processor delegates to processScheduledSyncJob", async () => {
    const { processScheduledSyncJob } = await import("./process-scheduled-sync-job.ts");
    vi.mocked(processScheduledSyncJob).mockClear();

    await invokeProcessor("scheduled-sync-queue", { type: "scheduled-sync-all" });

    expect(processScheduledSyncJob).toHaveBeenCalled();
  });

  it("post-sync processor delegates to processPostSyncJob", async () => {
    const { processPostSyncJob } = await import("./process-post-sync-job.ts");
    vi.mocked(processPostSyncJob).mockClear();

    await invokeProcessor("post-sync-queue", { type: "user-refit", userId: "u" });

    expect(processPostSyncJob).toHaveBeenCalled();
  });

  it("post-sync processor passes cached ClickHouse helpers to processPostSyncJob", async () => {
    const { createClickHouseClientFromEnv } = await import("../db/clickhouse.ts");
    const { createRefitSensorStore } = await import("../db/refit-sensor-store.ts");
    const { refreshBodyMeasurementReadModel } = await import(
      "../db/clickhouse-read-model-refresh.ts"
    );
    const { processPostSyncJob } = await import("./process-post-sync-job.ts");
    vi.mocked(createRefitSensorStore).mockClear();
    vi.mocked(refreshBodyMeasurementReadModel).mockClear();
    vi.mocked(processPostSyncJob).mockClear();

    await invokeProcessor("post-sync-queue", { type: "user-refit", userId: "u" });
    const processCall = vi.mocked(processPostSyncJob).mock.calls[0];
    const getSensorStore = processCall?.[2];
    const refreshBodyMeasurements = processCall?.[3];
    expect(getSensorStore).toBeDefined();
    expect(refreshBodyMeasurements).toBeDefined();

    if (typeof getSensorStore !== "function" || typeof refreshBodyMeasurements !== "function") {
      throw new Error("post-sync helpers were not passed to processPostSyncJob");
    }

    getSensorStore();
    getSensorStore();
    await refreshBodyMeasurements();

    expect(createClickHouseClientFromEnv).toHaveBeenCalledOnce();
    expect(createRefitSensorStore).toHaveBeenCalledOnce();
    expect(refreshBodyMeasurementReadModel).toHaveBeenCalledOnce();
  });

  it("activity-delete-analytics processor delegates to processActivityDeleteAnalyticsJob", async () => {
    const { processActivityDeleteAnalyticsJob } = await import(
      "./process-activity-delete-analytics-job.ts"
    );
    vi.mocked(processActivityDeleteAnalyticsJob).mockClear();

    await invokeProcessor("activity-delete-analytics-queue", {
      type: "activity-delete-analytics-refresh",
      userId: "user-1",
      activityIds: ["00000000-0000-0000-0000-000000000001"],
    });

    expect(processActivityDeleteAnalyticsJob).toHaveBeenCalled();
  });

  it("provider-data-deletion processor delegates to processProviderDataDeletionJob", async () => {
    const { markProviderDataDeletionCompleted } = await import("../db/provider-data-deletion.ts");
    const { processProviderDataDeletionJob } = await import(
      "./process-provider-data-deletion-job.ts"
    );
    const { enqueueProviderDeleteAnalyticsRefresh } = await import("./queues.ts");
    vi.mocked(markProviderDataDeletionCompleted).mockClear();
    vi.mocked(processProviderDataDeletionJob).mockClear();

    await invokeProcessor("provider-data-deletion-queue", {
      type: "provider-data-deletion",
      eventId: "30000000-0000-4000-8000-000000000003",
      generation: 2,
      providerId: "garmin",
      userId: "00000000-0000-4000-8000-000000000004",
    });

    expect(processProviderDataDeletionJob).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        clickHouseClient: mockClickHouseClient,
        enqueueAnalyticsRefresh: enqueueProviderDeleteAnalyticsRefresh,
        markCompleted: expect.any(Function),
      }),
    );
    const dependencies = vi.mocked(processProviderDataDeletionJob).mock.calls[0]?.[1];
    if (!dependencies) throw new Error("provider deletion dependencies were not passed");
    await dependencies.markCompleted("30000000-0000-4000-8000-000000000003");
    expect(markProviderDataDeletionCompleted).toHaveBeenCalledWith(
      mockDatabase,
      "30000000-0000-4000-8000-000000000003",
    );
  });

  it("account-erasure processor validates and delegates to the durable phase runner", async () => {
    const requestId = "50000000-0000-4000-8000-000000001994";
    hoisted.mockProcessAccountErasureRequest.mockClear();

    await invokeProcessor("account-erasure-queue", {
      type: "account-erasure",
      requestId,
    });

    expect(hoisted.mockProcessAccountErasureRequest).toHaveBeenCalledWith(
      mockDatabase,
      requestId,
      expect.stringMatching(/^account-erasure-worker:/),
      hoisted.mockAccountErasurePhaseRunner,
    );
  });

  it("rejects invalid account-erasure payloads without disclosing their contents", async () => {
    const privateEmail = "private@example.com";
    hoisted.mockProcessAccountErasureRequest.mockClear();

    await expect(
      invokeProcessor("account-erasure-queue", {
        type: "account-erasure",
        requestId: 1994,
        privateEmail,
      }),
    ).rejects.toThrow("Invalid account erasure job payload");
    await expect(
      invokeProcessor("account-erasure-queue", {
        type: "account-erasure",
        requestId: 1994,
        privateEmail,
      }),
    ).rejects.not.toThrow(privateEmail);
    expect(hoisted.mockProcessAccountErasureRequest).not.toHaveBeenCalled();
  });

  it("closes readiness and Garmin progress resources during graceful shutdown", async () => {
    const { closeAllQueueResources } = await import("./queues.ts");
    const shutdownOrder: string[] = [];
    mockClose.mockImplementation(async () => {
      shutdownOrder.push("worker");
    });
    mockCloseGarminProgress.mockImplementation(async () => {
      shutdownOrder.push("Garmin progress");
    });
    const signalHandler = process.listeners("SIGTERM").at(-1);
    if (!signalHandler) {
      throw new Error("SIGTERM handler was not registered");
    }

    const shutdownResult: unknown = Reflect.apply(signalHandler, process, []);
    if (!(shutdownResult instanceof Promise)) {
      throw new Error("SIGTERM handler did not return its shutdown promise");
    }
    await expect(shutdownResult).rejects.toThrow("process.exit called unexpectedly in test");

    expect(mockReadinessClose).toHaveBeenCalledOnce();
    expect(mockCloseGarminProgress).toHaveBeenCalledOnce();
    expect(mockCloseAccountErasureOutbox).toHaveBeenCalledOnce();
    expect(mockCloseAccountErasureRuntime).toHaveBeenCalledOnce();
    expect(mockCloseAccountErasureWorkLockPool).toHaveBeenCalledOnce();
    expect(mockCloseProviderDataDeletionOutbox).toHaveBeenCalledOnce();
    expect(mockCloseDataExportOutbox).toHaveBeenCalledOnce();
    expect(hoisted.mockCloseFileUploadOutbox).toHaveBeenCalledOnce();
    expect(hoisted.mockCloseFileUploadReconciler).toHaveBeenCalledOnce();
    expect(mockClose).toHaveBeenCalledTimes(EXPECTED_WORKER_COUNT);
    expect(closeAllQueueResources).toHaveBeenCalledOnce();
    expect(shutdownOrder).toEqual([
      ...Array.from({ length: EXPECTED_WORKER_COUNT }, () => "worker"),
      "Garmin progress",
    ]);
  });

  it("fails startup before registering sync when the interval is invalid", async () => {
    const previousSyncInterval = process.env.SYNC_INTERVAL_MINUTES;
    const workerRunCount = mockRun.mock.calls.length;
    const readinessListenCount = mockReadinessListen.mock.calls.length;
    process.env.SYNC_INTERVAL_MINUTES = "not-a-number";
    mockReconcileGarminProgress.mockResolvedValue(undefined);
    vi.resetModules();

    try {
      await expect(import("./worker.ts")).rejects.toThrow(
        'SYNC_INTERVAL_MINUTES must be a finite positive number, received "not-a-number"',
      );
    } finally {
      if (previousSyncInterval === undefined) {
        delete process.env.SYNC_INTERVAL_MINUTES;
      } else {
        process.env.SYNC_INTERVAL_MINUTES = previousSyncInterval;
      }
    }

    expect(mockRun).toHaveBeenCalledTimes(workerRunCount);
    expect(mockReadinessListen).toHaveBeenCalledTimes(readinessListenCount);
  });

  it("fails startup before running workers or exposing readiness when scheduler registration fails", async () => {
    const registrationError = new Error("scheduler Redis command failed");
    const workerRunCount = mockRun.mock.calls.length;
    const readinessListenCount = mockReadinessListen.mock.calls.length;
    hoisted.scheduledSyncState.error = registrationError;
    mockReconcileGarminProgress.mockResolvedValue(undefined);
    vi.resetModules();

    await expect(import("./worker.ts")).rejects.toBe(registrationError);

    const Sentry = await import("@sentry/node");
    const { logger } = await import("../logger.ts");
    expect(Sentry.captureException).toHaveBeenCalledWith(registrationError, {
      tags: { workerStartupStep: "scheduledSyncRegistration" },
    });
    expect(logger.error).toHaveBeenCalledWith("[worker] Failed to set up scheduled sync", {
      error: registrationError,
      errorStack: registrationError.stack,
    });
    expect(mockRun).toHaveBeenCalledTimes(workerRunCount);
    expect(mockReadinessListen).toHaveBeenCalledTimes(readinessListenCount);
  });
});
