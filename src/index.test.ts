import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock setup ──

const mockWaitUntilFinished = vi.fn<() => Promise<void>>(() => Promise.resolve());
const mockAdd = vi.fn(() => Promise.resolve({ waitUntilFinished: mockWaitUntilFinished }));
const mockQueueClose = vi.fn(() => Promise.resolve());
const mockWorkerClose = vi.fn(() => Promise.resolve());
const mockQueueEventsClose = vi.fn(() => Promise.resolve());
const mockGetEnabledProviders = vi.fn<() => Array<{ id: string }>>(() => []);
const mockEnsureProvidersRegistered = vi.fn(() => Promise.resolve());
const mockCreateSyncQueue = vi.fn(() => ({
  add: mockAdd,
  close: mockQueueClose,
}));

vi.mock("bullmq", () => ({
  Worker: vi.fn(() => ({ close: mockWorkerClose })),
  QueueEvents: vi.fn(() => ({ close: mockQueueEventsClose })),
}));

vi.mock("./jobs/queues.ts", () => ({
  getRedisConnection: vi.fn(() => ({})),
  createSyncQueue: mockCreateSyncQueue,
  SYNC_QUEUE: "sync",
}));

vi.mock("./jobs/provider-registration.ts", () => ({
  ensureProvidersRegistered: mockEnsureProvidersRegistered,
}));

vi.mock("./jobs/process-sync-job.ts", () => ({
  processSyncJob: vi.fn(),
}));

vi.mock("./providers/index.ts", () => ({
  getEnabledProviders: mockGetEnabledProviders,
  getAllProviders: vi.fn(() => []),
  registerProvider: vi.fn(),
}));

vi.mock("./db/index.ts", () => ({
  createDatabaseFromEnv: vi.fn(() => ({})),
}));

vi.mock("./db/schema.ts", () => ({
  DEFAULT_USER_ID: "test-user",
}));

// Mock modules only used by auth/import paths to avoid side effects on import
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("./auth/callback-server.ts", () => ({ waitForAuthCode: vi.fn() }));
vi.mock("./auth/index.ts", () => ({ buildAuthorizationUrl: vi.fn() }));
vi.mock("./db/tokens.ts", () => ({ ensureProvider: vi.fn(), saveTokens: vi.fn() }));

// Prevent main()'s auto-call from exiting the process (same pattern as worker.test.ts)
function noOpExit(): never {
  throw new Error("process.exit called in test");
}
vi.spyOn(process, "exit").mockImplementation(noOpExit);

// Set argv to a non-matching command so main()'s auto-call is a no-op.
// main() will throw via noOpExit — suppress that unhandled rejection.
const savedArgv = process.argv;
process.argv = ["node", "test", "__test_noop__"];

const suppressRejection = () => {};
process.on("unhandledRejection", suppressRejection);
const { handleSyncCommand } = await import("./index.ts");
await new Promise((resolve) => setTimeout(resolve, 0));
process.off("unhandledRejection", suppressRejection);

process.argv = savedArgv;

describe("handleSyncCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdd.mockResolvedValue({ waitUntilFinished: mockWaitUntilFinished });
    mockWaitUntilFinished.mockResolvedValue(undefined);
  });

  it("returns 0 when no providers are enabled", async () => {
    mockGetEnabledProviders.mockReturnValue([]);
    const code = await handleSyncCommand(["node", "index.ts", "sync"]);
    expect(code).toBe(0);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("registers providers before checking enabled list", async () => {
    mockGetEnabledProviders.mockReturnValue([]);
    await handleSyncCommand(["node", "index.ts", "sync"]);
    expect(mockEnsureProvidersRegistered).toHaveBeenCalledOnce();
  });

  it("enqueues sync job with default sinceDays and returns 0", async () => {
    mockGetEnabledProviders.mockReturnValue([{ id: "strava" }]);
    const code = await handleSyncCommand(["node", "index.ts", "sync"]);
    expect(code).toBe(0);
    expect(mockAdd).toHaveBeenCalledWith("sync", {
      sinceDays: 7,
      userId: "test-user",
    });
  });

  it("returns 1 when job fails", async () => {
    mockGetEnabledProviders.mockReturnValue([{ id: "strava" }]);
    mockWaitUntilFinished.mockRejectedValue(new Error("sync failed"));
    const code = await handleSyncCommand(["node", "index.ts", "sync"]);
    expect(code).toBe(1);
  });

  it("passes undefined sinceDays for --full-sync", async () => {
    mockGetEnabledProviders.mockReturnValue([{ id: "strava" }]);
    await handleSyncCommand(["node", "index.ts", "sync", "--full-sync"]);
    expect(mockAdd).toHaveBeenCalledWith("sync", {
      sinceDays: undefined,
      userId: "test-user",
    });
  });

  it("passes custom --since-days value", async () => {
    mockGetEnabledProviders.mockReturnValue([{ id: "strava" }]);
    await handleSyncCommand(["node", "index.ts", "sync", "--since-days=30"]);
    expect(mockAdd).toHaveBeenCalledWith("sync", {
      sinceDays: 30,
      userId: "test-user",
    });
  });

  it("cleans up BullMQ resources on success", async () => {
    mockGetEnabledProviders.mockReturnValue([{ id: "strava" }]);
    await handleSyncCommand(["node", "index.ts", "sync"]);
    expect(mockWorkerClose).toHaveBeenCalledOnce();
    expect(mockQueueEventsClose).toHaveBeenCalledOnce();
    expect(mockQueueClose).toHaveBeenCalledOnce();
  });

  it("cleans up BullMQ resources on failure", async () => {
    mockGetEnabledProviders.mockReturnValue([{ id: "strava" }]);
    mockWaitUntilFinished.mockRejectedValue(new Error("boom"));
    await handleSyncCommand(["node", "index.ts", "sync"]);
    expect(mockWorkerClose).toHaveBeenCalledOnce();
    expect(mockQueueEventsClose).toHaveBeenCalledOnce();
    expect(mockQueueClose).toHaveBeenCalledOnce();
  });
});
