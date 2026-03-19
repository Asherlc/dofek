import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock setup ──

const mockWaitUntilFinished = vi.fn<() => Promise<void>>(() => Promise.resolve());
const mockAdd = vi.fn(() => Promise.resolve({ waitUntilFinished: mockWaitUntilFinished }));
const mockQueueClose = vi.fn(() => Promise.resolve());
const mockWorkerClose = vi.fn(() => Promise.resolve());
const mockQueueEventsClose = vi.fn(() => Promise.resolve());
const mockGetEnabledProviders = vi.fn<() => Array<{ id: string }>>(() => []);
const mockGetAllProviders = vi.fn<() => Array<Record<string, unknown>>>(() => []);
const mockEnsureProvidersRegistered = vi.fn(() => Promise.resolve());
const mockProcessSyncJob = vi.fn();
const mockRedisConnection = { host: "localhost" };
const mockCreateSyncQueue = vi.fn(() => ({
  add: mockAdd,
  close: mockQueueClose,
}));
let capturedWorkerCallback: ((j: unknown) => Promise<unknown>) | undefined;
const MockWorker = vi.fn((_name: string, callback: (j: unknown) => Promise<unknown>) => {
  capturedWorkerCallback = callback;
  return { close: mockWorkerClose };
});
const MockQueueEvents = vi.fn(() => ({ close: mockQueueEventsClose }));

vi.mock("bullmq", () => ({
  Worker: MockWorker,
  QueueEvents: MockQueueEvents,
}));

vi.mock("./jobs/queues.ts", () => ({
  getRedisConnection: vi.fn(() => mockRedisConnection),
  createSyncQueue: mockCreateSyncQueue,
  SYNC_QUEUE: "sync",
}));

vi.mock("./jobs/provider-registration.ts", () => ({
  ensureProvidersRegistered: mockEnsureProvidersRegistered,
}));

vi.mock("./jobs/process-sync-job.ts", () => ({
  processSyncJob: mockProcessSyncJob,
}));

vi.mock("./providers/index.ts", () => ({
  getEnabledProviders: mockGetEnabledProviders,
  getAllProviders: mockGetAllProviders,
  registerProvider: vi.fn(),
}));

vi.mock("./db/index.ts", () => ({
  createDatabaseFromEnv: vi.fn(() => ({})),
}));

vi.mock("./db/schema.ts", () => ({
  DEFAULT_USER_ID: "test-user",
}));

// Mock modules used by auth/import paths
const mockExecFile = vi.fn();
vi.mock("node:child_process", () => ({ execFile: mockExecFile }));

const mockWaitForAuthCode = vi.fn();
vi.mock("./auth/callback-server.ts", () => ({
  waitForAuthCode: mockWaitForAuthCode,
}));

const mockBuildAuthorizationUrl = vi.fn(() => "https://auth.example.com/authorize");
vi.mock("./auth/index.ts", () => ({
  buildAuthorizationUrl: mockBuildAuthorizationUrl,
}));

const mockEnsureProvider = vi.fn(() => Promise.resolve());
const mockSaveTokens = vi.fn(() => Promise.resolve());
vi.mock("./db/tokens.ts", () => ({
  ensureProvider: mockEnsureProvider,
  saveTokens: mockSaveTokens,
}));

const mockImportAppleHealthFile = vi.fn();
vi.mock("./providers/apple-health/index.ts", () => ({
  importAppleHealthFile: mockImportAppleHealthFile,
}));

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
const { handleSyncCommand, handleAuthCommand, handleImportCommand } = await import("./index.ts");
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

  it("logs message when no providers enabled", async () => {
    mockGetEnabledProviders.mockReturnValue([]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await handleSyncCommand(["node", "index.ts", "sync"]);
    expect(spy).toHaveBeenCalledWith(
      "[sync] No providers enabled. Set API keys in .env to enable providers.",
    );
    spy.mockRestore();
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

  it("logs enqueue message with provider count and day range", async () => {
    mockGetEnabledProviders.mockReturnValue([{ id: "strava" }, { id: "wahoo" }]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await handleSyncCommand(["node", "index.ts", "sync"]);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[sync] Enqueued sync job for 2 provider(s)"),
    );
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("last 7 days"));
    spy.mockRestore();
  });

  it("logs 'all time' label for full sync", async () => {
    mockGetEnabledProviders.mockReturnValue([{ id: "strava" }]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await handleSyncCommand(["node", "index.ts", "sync", "--full-sync"]);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("all time"));
    spy.mockRestore();
  });

  it("creates Worker with processSyncJob callback and connection", async () => {
    mockGetEnabledProviders.mockReturnValue([{ id: "strava" }]);
    await handleSyncCommand(["node", "index.ts", "sync"]);

    expect(MockWorker).toHaveBeenCalledWith("sync", expect.any(Function), {
      connection: mockRedisConnection,
    });
    // Verify the callback calls processSyncJob by invoking the captured callback
    expect(capturedWorkerCallback).toBeDefined();
    const fakeJob = { id: "123" };
    await capturedWorkerCallback?.(fakeJob);
    expect(mockProcessSyncJob).toHaveBeenCalledWith(fakeJob, expect.any(Object));
  });

  it("creates QueueEvents with connection", async () => {
    mockGetEnabledProviders.mockReturnValue([{ id: "strava" }]);
    await handleSyncCommand(["node", "index.ts", "sync"]);

    expect(MockQueueEvents).toHaveBeenCalledWith("sync", {
      connection: mockRedisConnection,
    });
  });

  it("logs done message on success", async () => {
    mockGetEnabledProviders.mockReturnValue([{ id: "strava" }]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await handleSyncCommand(["node", "index.ts", "sync"]);
    expect(spy).toHaveBeenCalledWith("[sync] Done.");
    spy.mockRestore();
  });

  it("returns 1 when job fails", async () => {
    mockGetEnabledProviders.mockReturnValue([{ id: "strava" }]);
    mockWaitUntilFinished.mockRejectedValue(new Error("sync failed"));
    const code = await handleSyncCommand(["node", "index.ts", "sync"]);
    expect(code).toBe(1);
  });

  it("logs error message on failure", async () => {
    mockGetEnabledProviders.mockReturnValue([{ id: "strava" }]);
    mockWaitUntilFinished.mockRejectedValue(new Error("sync failed"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await handleSyncCommand(["node", "index.ts", "sync"]);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("[sync] Failed:"));
    spy.mockRestore();
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
    mockGetAllProviders.mockReturnValue([]);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await handleAuthCommand(["node", "index.ts", "auth"]);
    expect(code).toBe(1);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Usage: health-data auth"));
    spy.mockRestore();
  });

  it("returns 1 when provider not found", async () => {
    mockGetAllProviders.mockReturnValue([{ id: "strava", authSetup: () => ({}) }]);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await handleAuthCommand(["node", "index.ts", "auth", "unknown"]);
    expect(code).toBe(1);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Usage: health-data auth <strava>"));
    spy.mockRestore();
  });

  it("returns 1 when provider validation fails", async () => {
    mockGetAllProviders.mockReturnValue([
      {
        id: "strava",
        name: "Strava",
        authSetup: () => ({}),
        validate: () => "Missing STRAVA_CLIENT_ID",
      },
    ]);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await handleAuthCommand(["node", "index.ts", "auth", "strava"]);
    expect(code).toBe(1);
    expect(spy).toHaveBeenCalledWith("[auth] Missing STRAVA_CLIENT_ID");
    spy.mockRestore();
  });

  it("returns 1 when authSetup() returns undefined", async () => {
    mockGetAllProviders.mockReturnValue([
      {
        id: "strava",
        name: "Strava",
        authSetup: () => undefined,
        validate: () => null,
      },
    ]);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await handleAuthCommand(["node", "index.ts", "auth", "strava"]);
    expect(code).toBe(1);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[auth] Provider strava is not configured for OAuth"),
    );
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("STRAVA_CLIENT_ID"));
    spy.mockRestore();
  });

  it("handles OAuth 2.0 browser flow and saves tokens", async () => {
    const mockExchangeCode = vi.fn().mockResolvedValue(mockTokens);
    mockGetAllProviders.mockReturnValue([
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
    mockWaitForAuthCode.mockResolvedValue({ code: "auth-code-123", cleanup: mockCleanup });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await handleAuthCommand(["node", "index.ts", "auth", "strava"]);

    expect(code).toBe(0);
    expect(mockExchangeCode).toHaveBeenCalledWith("auth-code-123");
    expect(mockCleanup).toHaveBeenCalled();
    expect(mockEnsureProvider).toHaveBeenCalledWith(
      expect.any(Object),
      "strava",
      "Strava",
      "https://www.strava.com/api/v3",
    );
    expect(mockSaveTokens).toHaveBeenCalledWith(expect.any(Object), "strava", mockTokens);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("[auth] Authorized!"));
    expect(spy).toHaveBeenCalledWith("[auth] Tokens saved to database.");
    spy.mockRestore();
  });

  it("uses buildAuthorizationUrl when setup.authUrl is not provided", async () => {
    const mockExchangeCode = vi.fn().mockResolvedValue(mockTokens);
    const oauthConfig = { redirectUri: "http://localhost:9876/callback" };
    mockGetAllProviders.mockReturnValue([
      {
        id: "strava",
        name: "Strava",
        authSetup: () => ({
          oauthConfig,
          exchangeCode: mockExchangeCode,
        }),
        validate: () => null,
      },
    ]);
    mockWaitForAuthCode.mockResolvedValue({ code: "code", cleanup: mockCleanup });

    await handleAuthCommand(["node", "index.ts", "auth", "strava"]);
    expect(mockBuildAuthorizationUrl).toHaveBeenCalledWith(oauthConfig);
  });

  it("uses setup.authUrl when provided", async () => {
    const mockExchangeCode = vi.fn().mockResolvedValue(mockTokens);
    mockGetAllProviders.mockReturnValue([
      {
        id: "strava",
        name: "Strava",
        authSetup: () => ({
          oauthConfig: { redirectUri: "http://localhost:9876/callback" },
          exchangeCode: mockExchangeCode,
          authUrl: "https://custom-auth.example.com",
        }),
        validate: () => null,
      },
    ]);
    mockWaitForAuthCode.mockResolvedValue({ code: "code", cleanup: mockCleanup });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await handleAuthCommand(["node", "index.ts", "auth", "strava"]);
    expect(mockBuildAuthorizationUrl).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("https://custom-auth.example.com"));
    spy.mockRestore();
  });

  it("detects https callback URL", async () => {
    const mockExchangeCode = vi.fn().mockResolvedValue(mockTokens);
    mockGetAllProviders.mockReturnValue([
      {
        id: "strava",
        name: "Strava",
        authSetup: () => ({
          oauthConfig: { redirectUri: "https://localhost:9876/callback" },
          exchangeCode: mockExchangeCode,
        }),
        validate: () => null,
      },
    ]);
    mockWaitForAuthCode.mockResolvedValue({ code: "code", cleanup: mockCleanup });

    await handleAuthCommand(["node", "index.ts", "auth", "strava"]);
    expect(mockWaitForAuthCode).toHaveBeenCalledWith(9876, { https: true });
  });

  it("handles OAuth 1.0 flow (FatSecret)", async () => {
    const mockGetRequestToken = vi.fn().mockResolvedValue({
      oauthToken: "req-token",
      oauthTokenSecret: "req-secret",
      authorizeUrl: "https://fatsecret.com/auth",
    });
    const mockExchangeForAccessToken = vi.fn().mockResolvedValue({
      token: "access-token-1",
      tokenSecret: "access-secret-1",
    });

    mockGetAllProviders.mockReturnValue([
      {
        id: "fatsecret",
        name: "FatSecret",
        authSetup: () => ({
          oauthConfig: {
            redirectUri: "http://localhost:9876/callback",
          },
          exchangeCode: vi.fn(),
          oauth1Flow: {
            getRequestToken: mockGetRequestToken,
            exchangeForAccessToken: mockExchangeForAccessToken,
          },
        }),
        validate: () => null,
      },
    ]);
    mockWaitForAuthCode.mockResolvedValue({ code: "verifier-123", cleanup: mockCleanup });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await handleAuthCommand(["node", "index.ts", "auth", "fatsecret"]);

    expect(code).toBe(0);
    expect(mockGetRequestToken).toHaveBeenCalledWith("http://localhost:9876/callback");
    expect(mockWaitForAuthCode).toHaveBeenCalledWith(9876, {
      https: false,
      paramName: "oauth_verifier",
    });
    expect(mockCleanup).toHaveBeenCalled();
    expect(mockExchangeForAccessToken).toHaveBeenCalledWith(
      "req-token",
      "req-secret",
      "verifier-123",
    );
    expect(mockSaveTokens).toHaveBeenCalledWith(expect.any(Object), "fatsecret", {
      accessToken: "access-token-1",
      refreshToken: "access-secret-1",
      expiresAt: new Date("2099-12-31T23:59:59Z"),
      scopes: "",
    });
    expect(spy).toHaveBeenCalledWith("[auth] Requesting OAuth 1.0 request token...");
    expect(spy).toHaveBeenCalledWith("[auth] Exchanging for access token...");
    spy.mockRestore();
  });

  it("handles automated login flow", async () => {
    const mockAutomatedLogin = vi.fn().mockResolvedValue(mockTokens);
    mockGetAllProviders.mockReturnValue([
      {
        id: "peloton",
        name: "Peloton",
        authSetup: () => ({
          oauthConfig: { redirectUri: "http://localhost:9876/callback" },
          exchangeCode: vi.fn(),
          automatedLogin: mockAutomatedLogin,
        }),
        validate: () => null,
      },
    ]);

    const savedEnv = { ...process.env };
    process.env.PELOTON_USERNAME = "user@test.com";
    process.env.PELOTON_PASSWORD = "secret123";

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await handleAuthCommand(["node", "index.ts", "auth", "peloton"]);

    expect(code).toBe(0);
    expect(mockAutomatedLogin).toHaveBeenCalledWith("user@test.com", "secret123");
    expect(spy).toHaveBeenCalledWith("[auth] Logging in as user@test.com...");

    process.env = savedEnv;
    spy.mockRestore();
  });

  it("returns 1 when automated login credentials missing", async () => {
    mockGetAllProviders.mockReturnValue([
      {
        id: "peloton",
        name: "Peloton",
        authSetup: () => ({
          oauthConfig: { redirectUri: "http://localhost:9876/callback" },
          exchangeCode: vi.fn(),
          automatedLogin: vi.fn(),
        }),
        validate: () => null,
      },
    ]);

    const savedEnv = { ...process.env };
    delete process.env.PELOTON_USERNAME;
    delete process.env.PELOTON_PASSWORD;

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await handleAuthCommand(["node", "index.ts", "auth", "peloton"]);

    expect(code).toBe(1);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("PELOTON_USERNAME and PELOTON_PASSWORD required"),
    );

    process.env = savedEnv;
    spy.mockRestore();
  });

  it("registers providers before checking auth", async () => {
    mockGetAllProviders.mockReturnValue([]);
    await handleAuthCommand(["node", "index.ts", "auth"]);
    expect(mockEnsureProvidersRegistered).toHaveBeenCalledOnce();
  });

  it("opens browser with auth URL", async () => {
    const mockExchangeCode = vi.fn().mockResolvedValue(mockTokens);
    mockGetAllProviders.mockReturnValue([
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
    mockWaitForAuthCode.mockResolvedValue({ code: "code", cleanup: mockCleanup });
    mockBuildAuthorizationUrl.mockReturnValue("https://auth.example.com/oauth");

    vi.spyOn(console, "log").mockImplementation(() => {});
    await handleAuthCommand(["node", "index.ts", "auth", "strava"]);
    expect(mockExecFile).toHaveBeenCalledWith("open", ["https://auth.example.com/oauth"]);
    vi.restoreAllMocks();
  });
});

describe("handleImportCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 1 when subcommand is not recognized", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await handleImportCommand(["node", "index.ts", "import"]);
    expect(code).toBe(1);
    expect(spy).toHaveBeenCalledWith("Usage: health-data import <apple-health> <file>");
    spy.mockRestore();
  });

  it("returns 1 when apple-health file path missing", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await handleImportCommand(["node", "index.ts", "import", "apple-health"]);
    expect(code).toBe(1);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("Usage: health-data import apple-health"),
    );
    spy.mockRestore();
  });

  it("imports apple-health file and returns 0 on success", async () => {
    mockImportAppleHealthFile.mockResolvedValue({
      recordsSynced: 42,
      errors: [],
      duration: 1234,
    });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await handleImportCommand([
      "node",
      "index.ts",
      "import",
      "apple-health",
      "/path/to/export.zip",
    ]);

    expect(code).toBe(0);
    expect(mockImportAppleHealthFile).toHaveBeenCalledWith(
      expect.any(Object),
      "/path/to/export.zip",
      expect.any(Date),
    );
    expect(spy).toHaveBeenCalledWith("[import] Done: 42 records, 0 errors in 1234ms");
    spy.mockRestore();
  });

  it("returns 1 and logs errors when import has errors", async () => {
    mockImportAppleHealthFile.mockResolvedValue({
      recordsSynced: 10,
      errors: [new Error("bad record"), new Error("another bad")],
      duration: 500,
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await handleImportCommand([
      "node",
      "index.ts",
      "import",
      "apple-health",
      "/path/to/export.zip",
    ]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith("  - bad record");
    expect(errSpy).toHaveBeenCalledWith("  - another bad");
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("uses full sync when --full-sync flag present", async () => {
    mockImportAppleHealthFile.mockResolvedValue({
      recordsSynced: 100,
      errors: [],
      duration: 2000,
    });

    vi.spyOn(console, "log").mockImplementation(() => {});
    await handleImportCommand([
      "node",
      "index.ts",
      "import",
      "apple-health",
      "/path/to/export.zip",
      "--full-sync",
    ]);

    // With --full-sync, since should be epoch (Date(0))
    expect(mockImportAppleHealthFile).toHaveBeenCalledWith(
      expect.any(Object),
      "/path/to/export.zip",
      new Date(0),
    );
    vi.restoreAllMocks();
  });

  it("uses --since-days for import", async () => {
    mockImportAppleHealthFile.mockResolvedValue({
      recordsSynced: 50,
      errors: [],
      duration: 1000,
    });

    vi.spyOn(console, "log").mockImplementation(() => {});
    const before = Date.now();
    await handleImportCommand([
      "node",
      "index.ts",
      "import",
      "apple-health",
      "/path/to/export.zip",
      "--since-days=30",
    ]);

    // Verify the since date is approximately 30 days ago
    const sinceArg: Date = mockImportAppleHealthFile.mock.calls[0]?.[2];
    const expectedSince = before - 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs(sinceArg.getTime() - expectedSince)).toBeLessThan(1000);
    vi.restoreAllMocks();
  });
});
