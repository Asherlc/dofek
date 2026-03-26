import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../db/index.ts";
import type { SyncProvider, SyncResult } from "../providers/types.ts";

const mockCaptureException = vi.fn();
vi.mock("@sentry/node", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

const mockLoggerInfo = vi.fn();
const mockLoggerError = vi.fn();
const mockLoggerWarn = vi.fn();

vi.mock("../logger.ts", () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    debug: vi.fn(),
  },
}));

// Mock dependencies — the mock functions are accessed via module-level refs

vi.mock("./provider-registration.ts", () => ({
  ensureProvidersRegistered: vi.fn().mockResolvedValue(undefined),
}));

const mockGetSyncProviders = vi.fn<() => SyncProvider[]>().mockReturnValue([]);
vi.mock("../providers/index.ts", () => ({
  getSyncProviders: (...args: []) => mockGetSyncProviders(...args),
}));

const mockLogSync = vi.fn().mockResolvedValue(undefined);
vi.mock("../db/sync-log.ts", () => ({
  logSync: (...args: unknown[]) => mockLogSync(...args),
}));

const mockEnsureProvider = vi.fn().mockResolvedValue("test-id");
vi.mock("../db/tokens.ts", () => ({
  ensureProvider: (...args: unknown[]) => mockEnsureProvider(...args),
}));

const mockUpdateUserMaxHr = vi.fn().mockResolvedValue(undefined);
const mockRefreshDedupViews = vi.fn().mockResolvedValue(undefined);
vi.mock("../db/dedup.ts", () => ({
  updateUserMaxHr: (...args: unknown[]) => mockUpdateUserMaxHr(...args),
  refreshDedupViews: (...args: unknown[]) => mockRefreshDedupViews(...args),
}));

const mockSyncRecordsTotal = { add: vi.fn() };
const mockSyncOperationsTotal = { add: vi.fn() };
const mockSyncDuration = { record: vi.fn() };
const mockSyncErrorsTotal = { add: vi.fn() };
vi.mock("../sync-metrics.ts", () => ({
  syncRecordsTotal: mockSyncRecordsTotal,
  syncOperationsTotal: mockSyncOperationsTotal,
  syncDuration: mockSyncDuration,
  syncErrorsTotal: mockSyncErrorsTotal,
}));

// Import after mocks are set up
const { processSyncJob } = await import("./process-sync-job.ts");

// All DB functions are mocked at module level, so the db object is never actually called.
const mockDb: SyncDatabase = {
  select: vi.fn(),
  insert: vi.fn(),
  delete: vi.fn(),
  execute: vi.fn(),
};

interface MockJob {
  data: { providerId?: string; sinceDays?: number; userId: string };
  updateProgress: ReturnType<typeof vi.fn>;
}

function createMockJob(
  data: { providerId?: string; sinceDays?: number; userId?: string } = {},
): MockJob {
  return {
    data: { userId: "user-1", ...data },
    updateProgress: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockProvider(overrides: Partial<SyncProvider> = {}): SyncProvider {
  return {
    id: "test-provider",
    name: "Test Provider",
    validate: () => null,
    sync: vi.fn().mockResolvedValue({
      provider: "test-provider",
      recordsSynced: 5,
      errors: [],
      duration: 100,
    } satisfies SyncResult),
    ...overrides,
  };
}

// Helper to call processSyncJob with a mock job.
// processSyncJob accepts any object with .data and .updateProgress (SyncJob interface).
function runSyncJob(job: MockJob, db: SyncDatabase) {
  return processSyncJob(job, db);
}

describe("processSyncJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default return values after clearAllMocks
    mockGetSyncProviders.mockReturnValue([]);
    mockLogSync.mockResolvedValue(undefined);
    mockEnsureProvider.mockResolvedValue("test-id");
    mockUpdateUserMaxHr.mockResolvedValue(undefined);
    mockRefreshDedupViews.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("syncs all valid providers when no providerId specified", async () => {
    const providerA = createMockProvider({ id: "a", name: "Provider A" });
    const providerB = createMockProvider({ id: "b", name: "Provider B" });
    mockGetSyncProviders.mockReturnValue([providerA, providerB]);

    await runSyncJob(createMockJob(), mockDb);

    expect(providerA.sync).toHaveBeenCalledOnce();
    expect(providerB.sync).toHaveBeenCalledOnce();
  });

  it("filters out invalid providers", async () => {
    const valid = createMockProvider({ id: "valid", name: "Valid" });
    const invalid = createMockProvider({
      id: "invalid",
      name: "Invalid",
      validate: () => "missing API key",
    });
    mockGetSyncProviders.mockReturnValue([valid, invalid]);

    await runSyncJob(createMockJob(), mockDb);

    expect(valid.sync).toHaveBeenCalledOnce();
    expect(invalid.sync).not.toHaveBeenCalled();
  });

  it("syncs only the specified provider when providerId is given", async () => {
    const providerA = createMockProvider({ id: "a", name: "Provider A" });
    const providerB = createMockProvider({ id: "b", name: "Provider B" });
    mockGetSyncProviders.mockReturnValue([providerA, providerB]);

    await runSyncJob(createMockJob({ providerId: "b" }), mockDb);

    expect(providerA.sync).not.toHaveBeenCalled();
    expect(providerB.sync).toHaveBeenCalledOnce();
  });

  it("throws for unknown providerId", async () => {
    const providerA = createMockProvider({ id: "a", name: "Provider A" });
    mockGetSyncProviders.mockReturnValue([providerA]);

    await expect(runSyncJob(createMockJob({ providerId: "nonexistent" }), mockDb)).rejects.toThrow(
      "Unknown provider: nonexistent",
    );
  });

  it("updates job progress through pending → running → done states", async () => {
    const provider = createMockProvider({ id: "test", name: "Test" });
    mockGetSyncProviders.mockReturnValue([provider]);

    // Capture snapshots since the status object is mutated in place
    const progressSnapshots: Array<Record<string, unknown>> = [];
    const job = createMockJob();
    job.updateProgress.mockImplementation((data: Record<string, unknown>) => {
      progressSnapshots.push(structuredClone(data));
      return Promise.resolve();
    });

    await runSyncJob(job, mockDb);

    expect(progressSnapshots).toHaveLength(3);
    expect(progressSnapshots[0]).toEqual({
      providers: { test: { status: "pending" } },
      percentage: 0,
    });
    expect(progressSnapshots[1]).toEqual({
      providers: { test: { status: "running" } },
      percentage: 0,
    });
    expect(progressSnapshots[2]).toEqual({
      providers: { test: { status: "done", message: "5 synced" } },
      percentage: 100,
    });
  });

  it("logs success to sync log with userId", async () => {
    const provider = createMockProvider({ id: "test", name: "Test" });
    mockGetSyncProviders.mockReturnValue([provider]);

    await runSyncJob(createMockJob({ userId: "user-1" }), mockDb);

    expect(mockLogSync).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        providerId: "test",
        dataType: "sync",
        status: "success",
        recordCount: 5,
        errorMessage: undefined,
        userId: "user-1",
      }),
    );
  });

  it("logs errors to sync log when provider.sync throws", async () => {
    const provider = createMockProvider({
      id: "broken",
      name: "Broken",
      sync: vi.fn().mockRejectedValue(new Error("API timeout")),
    });
    mockGetSyncProviders.mockReturnValue([provider]);

    const progressSnapshots: Array<Record<string, unknown>> = [];
    const job = createMockJob();
    job.updateProgress.mockImplementation((data: Record<string, unknown>) => {
      progressSnapshots.push(structuredClone(data));
      return Promise.resolve();
    });

    // Should not throw — errors are caught per-provider
    await runSyncJob(job, mockDb);

    expect(mockLogSync).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        providerId: "broken",
        dataType: "sync",
        status: "error",
        errorMessage: "API timeout",
        durationMs: expect.any(Number),
        userId: "user-1",
      }),
    );

    // Verify error status was reported in progress with the error message
    const lastSnapshot = progressSnapshots[progressSnapshots.length - 1];
    expect(lastSnapshot).toEqual({
      providers: { broken: { status: "error", message: "API timeout" } },
      percentage: 100,
    });
  });

  it("reports error status with message when sync has errors", async () => {
    const provider = createMockProvider({
      id: "partial",
      name: "Partial",
      sync: vi.fn().mockResolvedValue({
        provider: "partial",
        recordsSynced: 3,
        errors: [{ message: "bad record 1" }, { message: "bad record 2" }],
        duration: 50,
      }),
    });
    mockGetSyncProviders.mockReturnValue([provider]);

    const progressSnapshots: Array<Record<string, unknown>> = [];
    const job = createMockJob();
    job.updateProgress.mockImplementation((data: Record<string, unknown>) => {
      progressSnapshots.push(structuredClone(data));
      return Promise.resolve();
    });

    await runSyncJob(job, mockDb);

    const lastSnapshot = progressSnapshots[progressSnapshots.length - 1];
    expect(lastSnapshot).toEqual({
      providers: { partial: { status: "error", message: "3 synced, 2 errors" } },
      percentage: 100,
    });

    // Verify errors are joined with "; " separator
    expect(mockLogSync).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        providerId: "partial",
        status: "error",
        errorMessage: "bad record 1; bad record 2",
        userId: "user-1",
      }),
    );

    // Verify each error is logged individually via Winston
    expect(mockLoggerError).toHaveBeenCalledWith("[worker] Partial sync error: bad record 1");
    expect(mockLoggerError).toHaveBeenCalledWith("[worker] Partial sync error: bad record 2");
  });

  it("reports thrown sync errors to Sentry", async () => {
    const thrownError = new Error("API timeout");
    const provider = createMockProvider({
      id: "broken",
      name: "Broken",
      sync: vi.fn().mockRejectedValue(thrownError),
    });
    mockGetSyncProviders.mockReturnValue([provider]);

    await runSyncJob(createMockJob(), mockDb);

    expect(mockCaptureException).toHaveBeenCalledWith(thrownError, {
      tags: { provider: "broken" },
    });
  });

  it("reports returned sync errors to Sentry", async () => {
    const cause = new Error("original cause");
    const provider = createMockProvider({
      id: "partial",
      name: "Partial",
      sync: vi.fn().mockResolvedValue({
        provider: "partial",
        recordsSynced: 3,
        errors: [{ message: "bad record 1", cause }, { message: "bad record 2" }],
        duration: 50,
      }),
    });
    mockGetSyncProviders.mockReturnValue([provider]);

    await runSyncJob(createMockJob(), mockDb);

    // First error: uses the cause as the exception
    expect(mockCaptureException).toHaveBeenCalledWith(cause, {
      tags: { provider: "partial" },
    });
    // Second error: creates an Error from the message
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "bad record 2" }),
      { tags: { provider: "partial" } },
    );
  });

  it("calls ensureProvider for each synced provider", async () => {
    const provider = createMockProvider({ id: "test", name: "Test Provider" });
    mockGetSyncProviders.mockReturnValue([provider]);

    await runSyncJob(createMockJob(), mockDb);

    expect(mockEnsureProvider).toHaveBeenCalledWith(mockDb, "test", "Test Provider");
  });

  it("calls updateUserMaxHr and refreshDedupViews post-sync", async () => {
    mockGetSyncProviders.mockReturnValue([]);

    await runSyncJob(createMockJob(), mockDb);

    expect(mockUpdateUserMaxHr).toHaveBeenCalledWith(mockDb);
    expect(mockRefreshDedupViews).toHaveBeenCalledWith(mockDb);
  });

  it("handles post-sync cleanup failures gracefully and logs errors", async () => {
    mockGetSyncProviders.mockReturnValue([]);
    mockUpdateUserMaxHr.mockRejectedValue(new Error("db gone"));
    mockRefreshDedupViews.mockRejectedValue(new Error("db gone"));

    // Should not throw
    await runSyncJob(createMockJob(), mockDb);

    expect(mockUpdateUserMaxHr).toHaveBeenCalled();
    expect(mockRefreshDedupViews).toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining("Failed to update max HR"),
    );
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining("Failed to refresh views"),
    );
  });

  it("relays within-provider progress to job.updateProgress with correct percentage", async () => {
    // Provider that calls the onProgress callback during sync
    const provider = createMockProvider({
      id: "test",
      name: "Test",
      sync: vi
        .fn()
        .mockImplementation(
          async (
            _db: SyncDatabase,
            _since: Date,
            options?: { onProgress?: (percentage: number, message: string) => void },
          ) => {
            options?.onProgress?.(50, "5/10 activities");
            return { provider: "test", recordsSynced: 10, errors: [], duration: 100 };
          },
        ),
    });
    mockGetSyncProviders.mockReturnValue([provider]);

    const progressSnapshots: Array<Record<string, unknown>> = [];
    const job = createMockJob();
    job.updateProgress.mockImplementation((data: Record<string, unknown>) => {
      progressSnapshots.push(structuredClone(data));
      return Promise.resolve();
    });

    await runSyncJob(job, mockDb);

    // With 1 provider: within-provider 50% should yield 50% overall
    const withinProviderSnapshot = progressSnapshots.find(
      (s) => "percentage" in s && s.percentage === 50,
    );
    expect(withinProviderSnapshot).toBeDefined();
    expect(withinProviderSnapshot).toMatchObject({
      providers: { test: { status: "running", message: "5/10 activities" } },
      percentage: 50,
    });
  });

  it("computes percentage across multiple providers", async () => {
    const providerA = createMockProvider({ id: "a", name: "A" });
    const providerB = createMockProvider({ id: "b", name: "B" });
    mockGetSyncProviders.mockReturnValue([providerA, providerB]);

    const progressSnapshots: Array<Record<string, unknown>> = [];
    const job = createMockJob();
    job.updateProgress.mockImplementation((data: Record<string, unknown>) => {
      progressSnapshots.push(structuredClone(data));
      return Promise.resolve();
    });

    await runSyncJob(job, mockDb);

    // After first provider completes: 50%, after second: 100%
    const percentages = progressSnapshots.map((s) =>
      "percentage" in s ? s.percentage : undefined,
    );
    expect(percentages[percentages.length - 1]).toBe(100);
    // After first provider done, before second starts running
    expect(percentages).toContain(50);
  });

  it("computes since date from sinceDays", async () => {
    const provider = createMockProvider({ id: "test", name: "Test" });
    mockGetSyncProviders.mockReturnValue([provider]);

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);

    await runSyncJob(createMockJob({ sinceDays: 30 }), mockDb);

    const expectedSince = new Date(now - 30 * 24 * 60 * 60 * 1000);
    expect(provider.sync).toHaveBeenCalledWith(
      mockDb,
      expectedSince,
      expect.objectContaining({ onProgress: expect.any(Function), userId: "user-1" }),
    );
  });

  it("uses epoch when sinceDays is not provided", async () => {
    const provider = createMockProvider({ id: "test", name: "Test" });
    mockGetSyncProviders.mockReturnValue([provider]);

    await runSyncJob(createMockJob({}), mockDb);

    expect(provider.sync).toHaveBeenCalledWith(
      mockDb,
      new Date(0),
      expect.objectContaining({ onProgress: expect.any(Function), userId: "user-1" }),
    );
  });

  it("emits sync metrics on successful sync", async () => {
    const provider = createMockProvider({ id: "garmin", name: "Garmin" });
    mockGetSyncProviders.mockReturnValue([provider]);

    await runSyncJob(createMockJob(), mockDb);

    expect(mockSyncRecordsTotal.add).toHaveBeenCalledWith(5, {
      provider: "garmin",
      data_type: "sync",
      status: "success",
    });
    expect(mockSyncOperationsTotal.add).toHaveBeenCalledWith(1, {
      provider: "garmin",
      data_type: "sync",
      status: "success",
    });
    expect(mockSyncDuration.record).toHaveBeenCalledWith(expect.any(Number), {
      provider: "garmin",
      data_type: "sync",
    });
    expect(mockSyncErrorsTotal.add).not.toHaveBeenCalled();
  });

  it("emits sync error metrics when sync has errors", async () => {
    const provider = createMockProvider({
      id: "partial",
      name: "Partial",
      sync: vi.fn().mockResolvedValue({
        provider: "partial",
        recordsSynced: 3,
        errors: [{ message: "bad record 1" }, { message: "bad record 2" }],
        duration: 50,
      }),
    });
    mockGetSyncProviders.mockReturnValue([provider]);

    await runSyncJob(createMockJob(), mockDb);

    expect(mockSyncRecordsTotal.add).toHaveBeenCalledWith(3, {
      provider: "partial",
      data_type: "sync",
      status: "error",
    });
    expect(mockSyncOperationsTotal.add).toHaveBeenCalledWith(1, {
      provider: "partial",
      data_type: "sync",
      status: "error",
    });
    expect(mockSyncErrorsTotal.add).toHaveBeenCalledWith(2, {
      provider: "partial",
      data_type: "sync",
    });
  });

  it("emits sync error metrics when sync throws", async () => {
    const provider = createMockProvider({
      id: "broken",
      name: "Broken",
      sync: vi.fn().mockRejectedValue(new Error("API timeout")),
    });
    mockGetSyncProviders.mockReturnValue([provider]);

    await runSyncJob(createMockJob(), mockDb);

    expect(mockSyncOperationsTotal.add).toHaveBeenCalledWith(1, {
      provider: "broken",
      data_type: "sync",
      status: "error",
    });
    expect(mockSyncDuration.record).toHaveBeenCalledWith(expect.any(Number), {
      provider: "broken",
      data_type: "sync",
    });
    expect(mockSyncErrorsTotal.add).toHaveBeenCalledWith(1, {
      provider: "broken",
      data_type: "sync",
    });
  });
});
