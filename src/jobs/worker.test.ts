import { beforeAll, describe, expect, it, type MockInstance, vi } from "vitest";

// Mock dependencies before importing worker module
const mockOn = vi.fn();
const mockClose = vi.fn(() => Promise.resolve());
const mockRun = vi.fn(() => Promise.resolve());
const mockAddJobLog = vi.fn(() => Promise.resolve(1));
const mockReadinessListen = vi.fn();
const mockReadinessClose = vi.fn((callback: (error?: Error) => void) => callback());
const mockReadinessServer = {
  listen: mockReadinessListen,
  close: mockReadinessClose,
};
const mockObserveFitJob = vi.fn();
const reconcileGarminProgressError = new Error("progress Redis unavailable");
const mockReconcileGarminProgress = vi.fn().mockRejectedValueOnce(reconcileGarminProgressError);
const mockCloseGarminProgress = vi.fn().mockResolvedValue(undefined);
const mockGarminProgressCoordinator = {
  observeFitJob: mockObserveFitJob,
  reconcile: mockReconcileGarminProgress,
  close: mockCloseGarminProgress,
};

vi.mock("bullmq", () => ({
  Job: { addJobLog: mockAddJobLog },
  Worker: vi.fn((name: string) => ({
    name,
    on: mockOn,
    close: mockClose,
    run: mockRun,
  })),
}));

vi.mock("../db/index.ts", () => ({
  createDatabaseFromEnv: vi.fn(() => ({
    $client: { end: vi.fn(() => Promise.resolve()) },
  })),
}));

vi.mock("../db/clickhouse.ts", () => ({
  createClickHouseClientFromEnv: vi.fn(() => ({})),
}));

vi.mock("../db/clickhouse-read-model-refresh.ts", () => ({
  refreshBodyMeasurementReadModel: vi.fn(() => Promise.resolve()),
}));

vi.mock("../db/refit-sensor-store.ts", () => ({
  createRefitSensorStore: vi.fn(() => ({})),
}));

vi.mock("./process-import-job.ts", () => ({
  processImportJob: vi.fn(),
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

vi.mock("./scheduled-sync.ts", () => ({
  setupScheduledSync: vi.fn(() => Promise.resolve()),
}));

vi.mock("./worker-readiness.ts", () => ({
  createWorkerReadinessServer: vi.fn(() => mockReadinessServer),
}));

vi.mock("./garmin-import-progress.ts", () => ({
  createGarminImportProgressCoordinator: vi.fn(() => mockGarminProgressCoordinator),
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
  getRedisConnection: vi.fn(() => ({})),
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
  closeAllQueueResources: vi.fn(() => Promise.resolve()),
}));

vi.mock("@sentry/node", () => ({
  init: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("../logger.ts", () => ({
  jobContext: { run: vi.fn((_store: unknown, fn: () => unknown) => fn()) },
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Prevent process.exit from actually exiting — must return `never` to match the real signature.
// The throw is unreachable because no test triggers SIGTERM/SIGINT.
function noOpExit(): never {
  throw new Error("process.exit called unexpectedly in test");
}
const exitSpy = vi.spyOn(process, "exit").mockImplementation(noOpExit);

describe("worker module", () => {
  let setTimeoutSpy: MockInstance;
  let clearTimeoutSpy: MockInstance;

  beforeAll(async () => {
    process.env.SENTRY_DSN = "https://test@sentry.io/123";
    setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    // Import the module to trigger its side effects
    await import("./worker.ts");
  });

  // 2 per-provider workers (strava, garmin) + 1 legacy sync + 1 import + 1 FIT import
  // + 1 FIT batch + 1 ZIP extract + 1 export + 1 scheduled-sync + 1 post-sync
  // + 1 activity-delete-analytics = 11
  // Training export is handled by the standalone Python BullMQ worker (packages/ml).
  const EXPECTED_WORKER_COUNT = 11;

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

  it("initializes Sentry when DSN is set", async () => {
    const Sentry = await import("@sentry/node");
    expect(Sentry.init).toHaveBeenCalledWith({
      dsn: "https://test@sentry.io/123",
      skipOpenTelemetrySetup: true,
    });
  });

  it("registers standard handlers plus FIT progress observers", () => {
    expect(mockOn).toHaveBeenCalledTimes(6 * EXPECTED_WORKER_COUNT + 2);
    const events = mockOn.mock.calls.map((call) => String(call[0]));
    expect(events.filter((e: string) => e === "active")).toHaveLength(EXPECTED_WORKER_COUNT);
    expect(events.filter((e: string) => e === "completed")).toHaveLength(EXPECTED_WORKER_COUNT + 1);
    expect(events.filter((e: string) => e === "failed")).toHaveLength(EXPECTED_WORKER_COUNT + 1);
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

  function getWorkerHandler(eventName: string): (...args: unknown[]) => unknown {
    const call = mockOn.mock.calls.find((mockCall) => mockCall[0] === eventName);
    expect(call).toBeDefined();
    const handler = call?.[1];
    if (typeof handler !== "function") {
      throw new Error(`No ${eventName} handler registered`);
    }
    return handler;
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

  it("import processor delegates to processImportJob", async () => {
    const { processImportJob } = await import("./process-import-job.ts");
    vi.mocked(processImportJob).mockClear();

    await invokeProcessor("import-queue", {
      filePath: "/tmp/f",
      since: "2026-01-01",
      userId: "u",
      importType: "apple-health",
    });

    expect(processImportJob).toHaveBeenCalled();
  });

  it("import processor fails loudly when BullMQ omits the job ID", async () => {
    const { processImportJob } = await import("./process-import-job.ts");
    vi.mocked(processImportJob).mockClear();

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

    expect(processImportJob).not.toHaveBeenCalled();
  });

  it("import processor passes a token-backed lock extender to processImportJob", async () => {
    const { processImportJob } = await import("./process-import-job.ts");
    vi.mocked(processImportJob).mockClear();
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

    const processCall = vi.mocked(processImportJob).mock.calls[0];
    const job = processCall?.[0];
    expect(job).toBeDefined();
    if (!job) {
      throw new Error("processImportJob was not called");
    }

    await job.extendLock(600_000);

    expect(extendLock).toHaveBeenCalledWith("token-1", 600_000);
  });

  it("import processor exposes token-bound durable flow operations to processImportJob", async () => {
    const { processImportJob } = await import("./process-import-job.ts");
    vi.mocked(processImportJob).mockClear();
    const updateProgress = vi.fn().mockResolvedValue(undefined);
    const updateData = vi.fn().mockResolvedValue(undefined);
    const moveToWaitingChildren = vi.fn().mockResolvedValue(true);
    const getChildrenValues = vi.fn().mockResolvedValue({ "bull:fit-batch:batch-1": {} });
    const getIgnoredChildrenFailures = vi.fn().mockResolvedValue({});
    const nextData = {
      filePath: "/tmp/f",
      since: "2026-01-01",
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

    const processCall = vi.mocked(processImportJob).mock.calls[0];
    const durableJob = processCall?.[0];
    expect(durableJob).toBeDefined();
    if (!durableJob) {
      throw new Error("processImportJob was not called");
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
    const { processImportJob } = await import("./process-import-job.ts");
    vi.mocked(processImportJob).mockClear();
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

    const processCall = vi.mocked(processImportJob).mock.calls[0];
    const job = processCall?.[0];
    expect(job).toBeDefined();
    if (!job) {
      throw new Error("processImportJob was not called");
    }

    await expect(job.extendLock(600_000)).rejects.toThrow("BullMQ import job lock token missing");
    expect(extendLock).not.toHaveBeenCalled();
  });

  it("import processor lock extender fails when BullMQ no longer owns the lock", async () => {
    const { processImportJob } = await import("./process-import-job.ts");
    vi.mocked(processImportJob).mockClear();
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

    const processCall = vi.mocked(processImportJob).mock.calls[0];
    const job = processCall?.[0];
    expect(job).toBeDefined();
    if (!job) {
      throw new Error("processImportJob was not called");
    }

    await expect(job.extendLock(600_000)).rejects.toThrow(
      "BullMQ import job lock is no longer owned: test-job-1",
    );
    expect(extendLock).toHaveBeenCalledWith("stale-token", 600_000);
  });

  it("export processor delegates to processExportJob", async () => {
    const { processExportJob } = await import("./process-export-job.ts");
    vi.mocked(processExportJob).mockClear();

    await invokeProcessor("export-queue", { userId: "u", outputPath: "/tmp/out.zip" });

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
    vi.mocked(createClickHouseClientFromEnv).mockClear();
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

  it("closes readiness and Garmin progress resources during graceful shutdown", async () => {
    const { closeAllQueueResources } = await import("./queues.ts");
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
    expect(mockClose).toHaveBeenCalledTimes(EXPECTED_WORKER_COUNT);
    expect(closeAllQueueResources).toHaveBeenCalledOnce();
  });
});
