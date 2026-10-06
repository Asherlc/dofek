import { vi } from "vitest";

export const mockCaptureException = vi.fn<(...args: unknown[]) => unknown>();
vi.mock("../lib/error-reporting.ts", () => ({ captureException: mockCaptureException }));
export const mockSyncJobRetryOptions = { attempts: 3, backoff: { type: "fixed", delay: 10 } };

// ── Mock setup ──

export const mockLoggerInfo = vi.fn<(...args: unknown[]) => unknown>();
export const mockLoggerError = vi.fn<(...args: unknown[]) => unknown>();
export const mockLoggerWarn = vi.fn<(...args: unknown[]) => unknown>();

vi.mock("../logger.ts", () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    debug: vi.fn<(...args: unknown[]) => unknown>(),
  },
}));

export const mockWaitUntilFinished = vi.fn<() => Promise<void>>(() => Promise.resolve());
export const mockAdd = vi.fn(() => Promise.resolve({ waitUntilFinished: mockWaitUntilFinished }));
export const mockQueueClose = vi.fn(() => Promise.resolve());
export const mockWorkerClose = vi.fn(() => Promise.resolve());
export const mockQueueEventsClose = vi.fn(() => Promise.resolve());
export const mockGetEnabledSyncProviders = vi.fn<() => Array<{ id: string }>>(() => []);
export const mockGetAllProviders = vi.fn<() => Array<Record<string, unknown>>>(() => []);
export const mockEnsureProvidersRegistered = vi.fn(() => Promise.resolve());
export const mockProcessSyncJob = vi.fn<(...args: unknown[]) => unknown>();
export const mockProcessFitFileImportJob = vi.fn<(...args: unknown[]) => unknown>();
export const mockCloseAccountErasureWorkLockPool = vi.fn(() => Promise.resolve());
export const mockRunQueuedUserWorkUnlessAccountErasing = vi.fn(
  async (
    _workLockPool: unknown,
    _database: unknown,
    _userId: string,
    _workKind: string,
    work: () => Promise<unknown>,
  ) => work(),
);
export const mockDbExecute = vi.fn(async () => [{ id: "test-user" }]);
export const mockCreateDatabaseFromEnv = vi.fn(() => ({
  execute: mockDbExecute,
}));
export const mockRedisConnection = { host: "localhost" };
export const mockCreateSyncQueue = vi.fn(() => ({
  add: mockAdd,
  close: mockQueueClose,
}));
export const capturedWorkerCallbacks = new Map<
  string,
  (job: unknown, token?: string, signal?: AbortSignal) => Promise<unknown>
>();
export const MockWorker = vi.fn(function vitestConstructor(
  name: string,
  callback: (job: unknown, token?: string, signal?: AbortSignal) => Promise<unknown>,
) {
  capturedWorkerCallbacks.set(name, callback);
  return { close: mockWorkerClose };
});
export const MockQueueEvents = vi.fn(function vitestConstructor() {
  return { close: mockQueueEventsClose };
});

vi.mock("bullmq", () => ({
  Worker: MockWorker,
  QueueEvents: MockQueueEvents,
}));

vi.mock("../jobs/queues.ts", () => ({
  getRedisConnection: vi.fn(() => mockRedisConnection),
  createSyncQueue: mockCreateSyncQueue,
  FIT_FILE_IMPORT_QUEUE: "fit-file-import",
  SYNC_QUEUE: "sync",
  SYNC_JOB_RETRY_OPTIONS: mockSyncJobRetryOptions,
}));

vi.mock("../jobs/provider-registration.ts", () => ({
  ensureProvidersRegistered: mockEnsureProvidersRegistered,
}));

vi.mock("../jobs/process-sync-job.ts", () => ({
  processSyncJob: mockProcessSyncJob,
}));

vi.mock("../jobs/process-fit-file-import-job.ts", () => ({
  processFitFileImportJob: mockProcessFitFileImportJob,
}));

vi.mock("../jobs/account-erasure-work-guard.ts", () => ({
  createAccountErasureWorkLockPoolFromEnv: vi.fn(() => ({
    close: mockCloseAccountErasureWorkLockPool,
  })),
  runQueuedUserWorkUnlessAccountErasing: mockRunQueuedUserWorkUnlessAccountErasing,
}));

vi.mock("../providers/index.ts", () => ({
  getEnabledSyncProviders: mockGetEnabledSyncProviders,
  getAllProviders: mockGetAllProviders,
  registerProvider: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock("../db/index.ts", () => ({
  createDatabaseFromEnv: mockCreateDatabaseFromEnv,
}));

vi.mock("../db/schema/core.ts", () => ({
  TEST_USER_ID: "test-user",
}));

// Mock modules used by auth/import paths
export const mockExecFile = vi.fn<(...args: unknown[]) => unknown>();
vi.mock("node:child_process", () => ({ execFile: mockExecFile }));

export const mockWaitForAuthCode = vi.fn<(...args: unknown[]) => unknown>();
vi.mock("../auth/callback-server.ts", () => ({
  waitForAuthCode: mockWaitForAuthCode,
}));

export const mockBuildAuthorizationUrl = vi.fn(() => "https://auth.example.com/authorize");
vi.mock("../auth/oauth.ts", () => ({
  buildAuthorizationUrl: mockBuildAuthorizationUrl,
}));

export const mockEnsureProvider = vi.fn(() => Promise.resolve());
export const mockSaveTokens = vi.fn(() => Promise.resolve());
vi.mock("../db/tokens.ts", () => ({
  ensureProvider: mockEnsureProvider,
  saveTokens: mockSaveTokens,
}));

export const mockImportAppleHealthFile =
  vi.fn<
    (
      db: unknown,
      path: string,
      since: Date,
    ) => Promise<{ recordsSynced: number; errors: Array<{ message: string }>; duration: number }>
  >();
vi.mock("../providers/apple-health/import.ts", () => ({
  importAppleHealthFile: mockImportAppleHealthFile,
}));

export const mockRunMetricStreamClickHouseSinkFromEnv = vi.fn(async () => undefined);
vi.mock("../metric-stream/clickhouse-sink.ts", () => ({
  startMetricStreamClickHouseSinkFromEnv: mockRunMetricStreamClickHouseSinkFromEnv,
}));
