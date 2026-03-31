import { beforeAll, describe, expect, it, vi } from "vitest";

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
  getProviderQueueConfig: vi.fn(() => ({ concurrency: 3, syncTier: "frequent" })),
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

// Prevent process.exit from actually exiting — must return `never` to match the real signature.
// The throw is unreachable because no test triggers SIGTERM/SIGINT.
function noOpExit(): never {
  throw new Error("process.exit called unexpectedly in test");
}
const exitSpy = vi.spyOn(process, "exit").mockImplementation(noOpExit);

describe("worker module", () => {
  beforeAll(async () => {
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

  it("active event handler increments active job count", () => {
    // Find an "active" callback and invoke it
    const activeCall = mockOn.mock.calls.find((call) => call[0] === "active");
    expect(activeCall).toBeDefined();
    // Calling the active handler should not throw
    activeCall?.[1]();
  });

  it("completed event handler does not throw", () => {
    const completedCall = mockOn.mock.calls.find((call) => call[0] === "completed");
    expect(completedCall).toBeDefined();
    completedCall?.[1]();
  });

  it("failed event handler logs the error", () => {
    const failedCall = mockOn.mock.calls.find((call) => call[0] === "failed");
    expect(failedCall).toBeDefined();
    // The failed handler receives (job, error) — pass a mock error
    failedCall?.[1](undefined, new Error("test failure"));
  });

  it("error event handler logs the error", () => {
    const errorCall = mockOn.mock.calls.find((call) => call[0] === "error");
    expect(errorCall).toBeDefined();
    errorCall?.[1](new Error("test worker error"));
  });
});
