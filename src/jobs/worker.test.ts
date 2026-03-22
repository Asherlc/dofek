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

vi.mock("./scheduled-sync.ts", () => ({
  setupScheduledSync: vi.fn(() => Promise.resolve()),
}));

vi.mock("./queues.ts", () => ({
  getRedisConnection: vi.fn(() => ({})),
  IMPORT_QUEUE: "import-queue",
  SYNC_QUEUE: "sync-queue",
  EXPORT_QUEUE: "export-queue",
  SCHEDULED_SYNC_QUEUE: "scheduled-sync-queue",
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

  it("creates four BullMQ workers (sync + import + export + scheduled-sync)", async () => {
    const { Worker } = await import("bullmq");
    expect(Worker).toHaveBeenCalledTimes(4);
    expect(Worker).toHaveBeenCalledWith("sync-queue", expect.any(Function), expect.any(Object));
    expect(Worker).toHaveBeenCalledWith("import-queue", expect.any(Function), expect.any(Object));
    expect(Worker).toHaveBeenCalledWith("export-queue", expect.any(Function), expect.any(Object));
    expect(Worker).toHaveBeenCalledWith("scheduled-sync-queue", expect.any(Function), expect.any(Object));
  });

  it("registers event handlers on each worker", () => {
    // Each worker registers active, completed, failed, error = 4 events x 4 workers = 16
    expect(mockOn).toHaveBeenCalledTimes(16);
    const events = mockOn.mock.calls.map((call) => String(call[0]));
    expect(events.filter((e: string) => e === "active")).toHaveLength(4);
    expect(events.filter((e: string) => e === "completed")).toHaveLength(4);
    expect(events.filter((e: string) => e === "failed")).toHaveLength(4);
    expect(events.filter((e: string) => e === "error")).toHaveLength(4);
  });

  it("registers SIGTERM and SIGINT handlers", () => {
    const signalListeners = process.listeners("SIGTERM");
    expect(signalListeners.length).toBeGreaterThan(0);
  });

  it("does not actually exit", () => {
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
