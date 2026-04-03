import { execFile } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Use vi.hoisted to ensure mock functions are available inside vi.mock()
const mocks = vi.hoisted(() => ({
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
  waitUntilFinished: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  add: vi.fn(() => Promise.resolve({ waitUntilFinished: vi.fn(() => Promise.resolve()) })),
  queueClose: vi.fn(() => Promise.resolve()),
  workerClose: vi.fn(() => Promise.resolve()),
  queueEventsClose: vi.fn(() => Promise.resolve()),
  getEnabledSyncProviders: vi.fn<() => Array<{ id: string }>>(() => []),
  getAllProviders: vi.fn<() => Array<Record<string, unknown>>>(() => []),
  ensureProvidersRegistered: vi.fn(() => Promise.resolve()),
  processSyncJob: vi.fn(),
  dbExecute: vi.fn(async () => [{ id: "test-user" }]),
  createDatabaseFromEnv: vi.fn(() => ({
    execute: vi.fn(async () => [{ id: "test-user" }]),
  })),
  redisConnection: { host: "localhost" },
  createSyncQueue: vi.fn(() => ({
    add: vi.fn(() => Promise.resolve({ waitUntilFinished: vi.fn(() => Promise.resolve()) })),
    close: vi.fn(() => Promise.resolve()),
  })),
  waitForAuthCode: vi.fn(),
  buildAuthorizationUrl: vi.fn(() => "https://auth.example.com/authorize"),
  ensureProvider: vi.fn(() => Promise.resolve()),
  saveTokens: vi.fn(() => Promise.resolve()),
  importAppleHealthFile: vi.fn(),
}));

let capturedWorkerCallback: ((j: unknown) => Promise<unknown>) | undefined;

vi.mock("./logger.ts", () => ({
  logger: {
    info: (...args: unknown[]) => mocks.loggerInfo(...args),
    error: (...args: unknown[]) => mocks.loggerError(...args),
    warn: (...args: unknown[]) => mocks.loggerWarn(...args),
    debug: vi.fn(),
  },
}));

vi.mock("bullmq", () => ({
  Worker: vi.fn((_name: string, callback: (j: unknown) => Promise<unknown>) => {
    capturedWorkerCallback = callback;
    return { close: mocks.workerClose };
  }),
  QueueEvents: vi.fn(() => ({ close: mocks.queueEventsClose })),
}));

vi.mock("./jobs/queues.ts", () => ({
  getRedisConnection: vi.fn(() => mocks.redisConnection),
  createSyncQueue: mocks.createSyncQueue,
  SYNC_QUEUE: "sync",
}));

vi.mock("./jobs/provider-registration.ts", () => ({
  ensureProvidersRegistered: mocks.ensureProvidersRegistered,
}));

vi.mock("./jobs/process-sync-job.ts", () => ({
  processSyncJob: mocks.processSyncJob,
}));

vi.mock("./providers/index.ts", () => ({
  getEnabledSyncProviders: mocks.getEnabledSyncProviders,
  getAllProviders: mocks.getAllProviders,
  registerProvider: vi.fn(),
}));

vi.mock("./db/index.ts", () => ({
  createDatabaseFromEnv: mocks.createDatabaseFromEnv,
}));

vi.mock("./db/schema.ts", () => ({
  TEST_USER_ID: "test-user",
  DEFAULT_USER_ID: "00000000-0000-0000-0000-000000000001",
}));

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

vi.mock("./auth/callback-server.ts", () => ({
  waitForAuthCode: mocks.waitForAuthCode,
}));

vi.mock("./auth/index.ts", () => ({
  buildAuthorizationUrl: mocks.buildAuthorizationUrl,
}));

vi.mock("./db/tokens.ts", () => ({
  ensureProvider: mocks.ensureProvider,
  saveTokens: mocks.saveTokens,
}));

vi.mock("./providers/apple-health/index.ts", () => ({
  importAppleHealthFile: mocks.importAppleHealthFile,
}));

// Now import commands
import { handleAuthCommand } from "./commands/auth.ts";
import { handleImportCommand } from "./commands/import.ts";
import { handleSyncCommand } from "./commands/sync.ts";
import { main } from "./index.ts";

// Prevent main()'s auto-call from exiting the process
function noOpExit(): never {
  throw new Error("process.exit called in test");
}
vi.spyOn(process, "exit").mockImplementation(noOpExit);

// Set argv to a non-matching command so main()'s auto-call is a no-op.
const savedArgv = process.argv;
process.argv = ["node", "test", "__test_noop__"];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createDatabaseFromEnv.mockReturnValue({
    execute: vi.fn().mockResolvedValue([{ id: "test-user" }]),
  } as any);
});

describe("handleSyncCommand", () => {
  beforeEach(() => {
    mocks.createSyncQueue.mockReturnValue({
      add: vi.fn().mockResolvedValue({ waitUntilFinished: mocks.waitUntilFinished }),
      close: mocks.queueClose,
    });
    mocks.waitUntilFinished.mockResolvedValue(undefined);
  });

  it("returns 0 when no providers are enabled", async () => {
    mocks.getEnabledSyncProviders.mockReturnValue([]);
    const code = await handleSyncCommand(["node", "index.ts", "sync"]);
    expect(code).toBe(0);
  });

  it("logs message when no providers enabled", async () => {
    mocks.getEnabledSyncProviders.mockReturnValue([]);
    await handleSyncCommand(["node", "index.ts", "sync"]);
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "[sync] No syncable providers enabled. Set API keys in .env to enable providers.",
    );
  });

  it("registers providers before checking enabled list", async () => {
    mocks.getEnabledSyncProviders.mockReturnValue([]);
    await handleSyncCommand(["node", "index.ts", "sync"]);
    expect(mocks.ensureProvidersRegistered).toHaveBeenCalledOnce();
  });

  it("enqueues sync job with providerId and default sinceDays", async () => {
    mocks.getEnabledSyncProviders.mockReturnValue([{ id: "strava" }]);
    const mockAdd = vi.fn().mockResolvedValue({ waitUntilFinished: mocks.waitUntilFinished });
    mocks.createSyncQueue.mockReturnValue({ add: mockAdd, close: mocks.queueClose });

    const code = await handleSyncCommand(["node", "index.ts", "sync"]);
    expect(code).toBe(0);
    expect(mockAdd).toHaveBeenCalledWith("sync", {
      providerId: "strava",
      sinceDays: 7,
      userId: "test-user",
    });
  });

  it("enqueues one sync job per enabled provider", async () => {
    mocks.getEnabledSyncProviders.mockReturnValue([{ id: "strava" }, { id: "wahoo" }]);
    const mockAdd = vi.fn().mockResolvedValue({ waitUntilFinished: mocks.waitUntilFinished });
    mocks.createSyncQueue.mockReturnValue({ add: mockAdd, close: mocks.queueClose });

    await handleSyncCommand(["node", "index.ts", "sync"]);

    expect(mockAdd).toHaveBeenCalledTimes(2);
  });

  it("logs enqueue message with provider count and day range", async () => {
    mocks.getEnabledSyncProviders.mockReturnValue([{ id: "strava" }, { id: "wahoo" }]);
    await handleSyncCommand(["node", "index.ts", "sync"]);
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("[sync] Enqueued 2 sync job(s), one per provider"),
    );
  });

  it("logs 'all time' label for full sync", async () => {
    mocks.getEnabledSyncProviders.mockReturnValue([{ id: "strava" }]);
    await handleSyncCommand(["node", "index.ts", "sync", "--full-sync"]);
    expect(mocks.loggerInfo).toHaveBeenCalledWith(expect.stringContaining("all time"));
  });

  it("creates Worker with processSyncJob callback and connection", async () => {
    mocks.getEnabledSyncProviders.mockReturnValue([{ id: "strava" }]);
    await handleSyncCommand(["node", "index.ts", "sync"]);

    // Verify the callback calls processSyncJob by invoking the captured callback
    expect(capturedWorkerCallback).toBeDefined();
    const fakeJob = { id: "123" };
    await capturedWorkerCallback?.(fakeJob);
    expect(mocks.processSyncJob).toHaveBeenCalledWith(fakeJob, expect.any(Object));
  });

  it("logs done message on success", async () => {
    mocks.getEnabledSyncProviders.mockReturnValue([{ id: "strava" }]);
    await handleSyncCommand(["node", "index.ts", "sync"]);
    expect(mocks.loggerInfo).toHaveBeenCalledWith("[sync] Done.");
  });

  it("returns 1 when job fails", async () => {
    mocks.getEnabledSyncProviders.mockReturnValue([{ id: "strava" }]);
    mocks.waitUntilFinished.mockRejectedValue(new Error("sync failed"));
    const mockAdd = vi.fn().mockResolvedValue({ waitUntilFinished: mocks.waitUntilFinished });
    mocks.createSyncQueue.mockReturnValue({ add: mockAdd, close: mocks.queueClose });

    const code = await handleSyncCommand(["node", "index.ts", "sync"]);
    expect(code).toBe(1);
  });

  it("logs error message on failure", async () => {
    mocks.getEnabledSyncProviders.mockReturnValue([{ id: "strava" }]);
    mocks.waitUntilFinished.mockRejectedValue(new Error("sync failed"));
    const mockAdd = vi.fn().mockResolvedValue({ waitUntilFinished: mocks.waitUntilFinished });
    mocks.createSyncQueue.mockReturnValue({ add: mockAdd, close: mocks.queueClose });

    await handleSyncCommand(["node", "index.ts", "sync"]);
    expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringContaining("[sync] Failed:"));
  });

  it("passes undefined sinceDays for --full-sync", async () => {
    mocks.getEnabledSyncProviders.mockReturnValue([{ id: "strava" }]);
    const mockAdd = vi.fn().mockResolvedValue({ waitUntilFinished: mocks.waitUntilFinished });
    mocks.createSyncQueue.mockReturnValue({ add: mockAdd, close: mocks.queueClose });

    await handleSyncCommand(["node", "index.ts", "sync", "--full-sync"]);
    expect(mockAdd).toHaveBeenCalledWith("sync", {
      providerId: "strava",
      sinceDays: undefined,
      userId: "test-user",
    });
  });

  it("passes custom --since-days value", async () => {
    mocks.getEnabledSyncProviders.mockReturnValue([{ id: "strava" }]);
    const mockAdd = vi.fn().mockResolvedValue({ waitUntilFinished: mocks.waitUntilFinished });
    mocks.createSyncQueue.mockReturnValue({ add: mockAdd, close: mocks.queueClose });

    await handleSyncCommand(["node", "index.ts", "sync", "--since-days=30"]);
    expect(mockAdd).toHaveBeenCalledWith("sync", {
      providerId: "strava",
      sinceDays: 30,
      userId: "test-user",
    });
  });

  it("uses DOFEK_USER_ID when provided and skips DB user lookup", async () => {
    const priorUserId = process.env.DOFEK_USER_ID;
    process.env.DOFEK_USER_ID = "env-user-123";
    mocks.getEnabledSyncProviders.mockReturnValue([{ id: "strava" }]);
    const mockDb = { execute: vi.fn().mockRejectedValue(new Error("should not query DB")) };
    mocks.createDatabaseFromEnv.mockReturnValue(mockDb as any);

    try {
      const code = await handleSyncCommand(["node", "index.ts", "sync"]);
      expect(code).toBe(0);
      expect(mockDb.execute).not.toHaveBeenCalled();
    } finally {
      if (priorUserId === undefined) {
        delete process.env.DOFEK_USER_ID;
      } else {
        process.env.DOFEK_USER_ID = priorUserId;
      }
    }
  });

  it("cleans up BullMQ resources on success", async () => {
    mocks.getEnabledSyncProviders.mockReturnValue([{ id: "strava" }]);
    await handleSyncCommand(["node", "index.ts", "sync"]);
    expect(mocks.workerClose).toHaveBeenCalledOnce();
    expect(mocks.queueEventsClose).toHaveBeenCalledOnce();
    expect(mocks.queueClose).toHaveBeenCalledOnce();
  });
});

describe("handleAuthCommand", () => {
  const mockCleanup = vi.fn();
  const mockTokens = {
    accessToken: "test-access",
    refreshToken: "test-refresh",
    expiresAt: new Date("2099-12-31T23:59:59Z"),
    scopes: "read",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCleanup.mockReset();
  });

  it("returns 1 when no provider arg given", async () => {
    mocks.getAllProviders.mockReturnValue([]);
    const code = await handleAuthCommand(["node", "index.ts", "auth"]);
    expect(code).toBe(1);
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("Usage: health-data auth"),
    );
  });

  it("handles OAuth 2.0 browser flow and saves tokens", async () => {
    const mockExchangeCode = vi.fn().mockResolvedValue(mockTokens);
    mocks.getAllProviders.mockReturnValue([
      {
        id: "strava",
        name: "Strava",
        authSetup: () => ({
          oauthConfig: {
            redirectUri: "http://localhost:9876/callback",
          },
          exchangeCode: mockExchangeCode,
          apiBaseUrl: "https://www.strava.com/api/v3",
        }),
        validate: () => null,
      },
    ]);
    mocks.waitForAuthCode.mockResolvedValue({ code: "auth-code-123", cleanup: mockCleanup });

    const code = await handleAuthCommand(["node", "index.ts", "auth", "strava"]);

    expect(code).toBe(0);
    expect(mockExchangeCode).toHaveBeenCalledWith("auth-code-123");
    expect(mocks.ensureProvider).toHaveBeenCalled();
    expect(mocks.saveTokens).toHaveBeenCalled();
  });

  it("opens browser with auth URL", async () => {
    const mockExchangeCode = vi.fn().mockResolvedValue(mockTokens);
    mocks.getAllProviders.mockReturnValue([
      {
        id: "strava",
        name: "Strava",
        authSetup: () => ({
          oauthConfig: { redirectUri: "http://localhost:9876/callback" },
          exchangeCode: mockExchangeCode,
        }),
        validate: () => null,
      },
    ]);
    mocks.waitForAuthCode.mockResolvedValue({ code: "code", cleanup: mockCleanup });
    mocks.buildAuthorizationUrl.mockReturnValue("https://auth.example.com/oauth");

    await handleAuthCommand(["node", "index.ts", "auth", "strava"]);
    expect(execFile).toHaveBeenCalledWith("open", ["https://auth.example.com/oauth"]);
  });
});

describe("handleImportCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("imports apple-health file and returns 0 on success", async () => {
    mocks.importAppleHealthFile.mockResolvedValue({
      recordsSynced: 42,
      errors: [],
      duration: 1234,
    });

    const code = await handleImportCommand([
      "node",
      "index.ts",
      "import",
      "apple-health",
      "/path/to/export.zip",
    ]);

    expect(code).toBe(0);
    expect(mocks.importAppleHealthFile).toHaveBeenCalled();
    expect(mocks.loggerInfo).toHaveBeenCalledWith("[import] Done: 42 records, 0 errors in 1234ms");
  });
});

describe("main", () => {
  const createProcessExitSpy = () => vi.spyOn(process, "exit");
  let mockProcessExit: ReturnType<typeof createProcessExitSpy>;
  let originalArgv: string[];

  beforeEach(() => {
    mockProcessExit = createProcessExitSpy().mockImplementation((..._args: unknown[]) => {
      throw new Error("exit-called");
    });
    originalArgv = process.argv;
  });

  afterEach(() => {
    mockProcessExit.mockRestore();
    process.argv = originalArgv;
  });

  it("exits with 1 for unknown command", async () => {
    process.argv = ["node", "index.ts", "unknown"];
    await expect(main()).rejects.toThrow("exit-called");
    expect(mockProcessExit).toHaveBeenCalledWith(1);
  });

  it("calls handleSyncCommand for 'sync'", async () => {
    process.argv = ["node", "index.ts", "sync"];
    mocks.getEnabledSyncProviders.mockReturnValue([{ id: "strava" }]);
    await expect(main()).rejects.toThrow("exit-called");
    expect(mockProcessExit).toHaveBeenCalledWith(0);
  });
});
