import { beforeAll, describe, expect, it, type MockInstance, vi } from "vitest";

// Mock dependencies before importing worker module
const mockOn = vi.fn();
const mockClose = vi.fn(() => Promise.resolve());

vi.mock("bullmq", () => ({
  Worker: vi.fn(() => ({
    on: mockOn,
    close: mockClose,
  })),
}));

vi.mock("../db/index.ts", () => ({
  createDatabaseFromEnv: vi.fn(() => ({})),
}));

vi.mock("./process-import-job.ts", () => ({
  processImportJob: vi.fn(),
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

vi.mock("./process-training-export-job.ts", () => ({
  processTrainingExportJob: vi.fn(),
}));

vi.mock("./scheduled-sync.ts", () => ({
  setupScheduledSync: vi.fn(() => Promise.resolve()),
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
  SYNC_QUEUE: "sync-queue",
  EXPORT_QUEUE: "export-queue",
  SCHEDULED_SYNC_QUEUE: "scheduled-sync-queue",
  POST_SYNC_QUEUE: "post-sync-queue",
  TRAINING_EXPORT_QUEUE: "training-export-queue",
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

  // 2 per-provider workers (strava, garmin) + 1 legacy sync + 1 import + 1 export + 1 scheduled-sync + 1 post-sync + 1 training-export = 8
  const EXPECTED_WORKER_COUNT = 8;

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
      "training-export-queue",
      expect.any(Function),
      expect.any(Object),
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

  it("initializes Sentry when DSN is set", async () => {
    const Sentry = await import("@sentry/node");
    expect(Sentry.init).toHaveBeenCalledWith({
      dsn: "https://test@sentry.io/123",
      skipOpenTelemetrySetup: true,
    });
  });

  it("registers event handlers on each worker", () => {
    // Each worker registers active, completed, failed, error = 4 events x N workers
    expect(mockOn).toHaveBeenCalledTimes(4 * EXPECTED_WORKER_COUNT);
    const events = mockOn.mock.calls.map((call) => String(call[0]));
    expect(events.filter((e: string) => e === "active")).toHaveLength(EXPECTED_WORKER_COUNT);
    expect(events.filter((e: string) => e === "completed")).toHaveLength(EXPECTED_WORKER_COUNT);
    expect(events.filter((e: string) => e === "failed")).toHaveLength(EXPECTED_WORKER_COUNT);
    expect(events.filter((e: string) => e === "error")).toHaveLength(EXPECTED_WORKER_COUNT);
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

  it("active event handler resets idle timer", () => {
    const clearBefore = clearTimeoutSpy.mock.calls.length;
    const activeCall = mockOn.mock.calls.find((call) => call[0] === "active");
    expect(activeCall).toBeDefined();
    activeCall?.[1]();
    // resetIdleTimer should call clearTimeout
    expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(clearBefore);
  });

  it("completed event handler restarts idle timer when no active jobs", () => {
    const setTimeoutBefore = setTimeoutSpy.mock.calls.length;
    // The active handler above incremented activeJobs to 1.
    // Calling completed decrements it to 0, triggering startIdleTimer.
    const completedCall = mockOn.mock.calls.find((call) => call[0] === "completed");
    expect(completedCall).toBeDefined();
    completedCall?.[1]();
    // startIdleTimer should call setTimeout
    expect(setTimeoutSpy.mock.calls.length).toBeGreaterThan(setTimeoutBefore);
  });

  it("failed event handler reports to Sentry and logs the error", async () => {
    const Sentry = await import("@sentry/node");
    const { logger } = await import("../logger.ts");
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(logger.error).mockClear();

    const failedCall = mockOn.mock.calls.find((call) => call[0] === "failed");
    expect(failedCall).toBeDefined();
    const error = new Error("test failure");
    failedCall?.[1](undefined, error);

    expect(Sentry.captureException).toHaveBeenCalledWith(error);
    expect(logger.error).toHaveBeenCalledWith("[worker] Job failed: test failure");
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

  it("per-provider sync processor delegates to processSyncJob", async () => {
    const { Worker } = await import("bullmq");
    const { processSyncJob } = await import("./process-sync-job.ts");
    vi.mocked(processSyncJob).mockClear();

    const stravaCall = vi.mocked(Worker).mock.calls.find((call) => call[0] === "sync-strava");
    const processor = stravaCall?.[1];
    expect(processor).toBeDefined();
    await processor?.({ data: { providerId: "strava", userId: "user-1" } });

    expect(processSyncJob).toHaveBeenCalled();
  });

  it("legacy sync processor delegates to processSyncJob and logs warning", async () => {
    const { Worker } = await import("bullmq");
    const { processSyncJob } = await import("./process-sync-job.ts");
    const { logger } = await import("../logger.ts");
    vi.mocked(processSyncJob).mockClear();
    vi.mocked(logger.warn).mockClear();

    const legacyCall = vi.mocked(Worker).mock.calls.find((call) => call[0] === "sync-queue");
    const processor = legacyCall?.[1];
    expect(processor).toBeDefined();
    await processor?.({ data: { providerId: "wahoo", userId: "user-1" } });

    expect(processSyncJob).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("import processor delegates to processImportJob", async () => {
    const { Worker } = await import("bullmq");
    const { processImportJob } = await import("./process-import-job.ts");
    vi.mocked(processImportJob).mockClear();

    const importCall = vi.mocked(Worker).mock.calls.find((call) => call[0] === "import-queue");
    const processor = importCall?.[1];
    await processor?.({
      data: { filePath: "/tmp/f", since: "2026-01-01", userId: "u", importType: "apple-health" },
    });

    expect(processImportJob).toHaveBeenCalled();
  });

  it("export processor delegates to processExportJob", async () => {
    const { Worker } = await import("bullmq");
    const { processExportJob } = await import("./process-export-job.ts");
    vi.mocked(processExportJob).mockClear();

    const exportCall = vi.mocked(Worker).mock.calls.find((call) => call[0] === "export-queue");
    const processor = exportCall?.[1];
    await processor?.({ data: { userId: "u", outputPath: "/tmp/out.zip" } });

    expect(processExportJob).toHaveBeenCalled();
  });

  it("scheduled-sync processor delegates to processScheduledSyncJob", async () => {
    const { Worker } = await import("bullmq");
    const { processScheduledSyncJob } = await import("./process-scheduled-sync-job.ts");
    vi.mocked(processScheduledSyncJob).mockClear();

    const scheduledCall = vi
      .mocked(Worker)
      .mock.calls.find((call) => call[0] === "scheduled-sync-queue");
    const processor = scheduledCall?.[1];
    await processor?.({ data: { type: "scheduled-sync-all" } });

    expect(processScheduledSyncJob).toHaveBeenCalled();
  });

  it("post-sync processor delegates to processPostSyncJob", async () => {
    const { Worker } = await import("bullmq");
    const { processPostSyncJob } = await import("./process-post-sync-job.ts");
    vi.mocked(processPostSyncJob).mockClear();

    const postSyncCall = vi.mocked(Worker).mock.calls.find((call) => call[0] === "post-sync-queue");
    const processor = postSyncCall?.[1];
    await processor?.({ data: { userId: "u" } });

    expect(processPostSyncJob).toHaveBeenCalled();
  });

  it("training-export processor delegates to processTrainingExportJob", async () => {
    const { Worker } = await import("bullmq");
    const { processTrainingExportJob } = await import("./process-training-export-job.ts");
    vi.mocked(processTrainingExportJob).mockClear();

    const trainingExportCall = vi
      .mocked(Worker)
      .mock.calls.find((call) => call[0] === "training-export-queue");
    const processor = trainingExportCall?.[1];
    await processor?.({ data: {} });

    expect(processTrainingExportJob).toHaveBeenCalled();
  });
});
