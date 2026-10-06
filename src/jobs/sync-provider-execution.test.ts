import {
  ProviderRateLimitError,
  ProviderRequestTimeoutError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../db/index.ts";
import { RefreshTokenRevokedError } from "../providers/auth-errors.ts";
import type { SyncRun } from "../providers/sync-run.ts";
import type { SyncResult } from "../providers/types.ts";

import {
  createMockJob,
  createMockProvider,
  type MockJob,
  mockAppendProcessingStageEvent,
  mockCaptureException,
  mockDb,
  mockEnqueueDebouncedPostSyncMaintenance,
  mockEnsureProvider,
  mockGetEnabledSyncProviders,
  mockGetProcessingOutputManifest,
  mockInvalidateAllUserQueries,
  mockLoadTokens,
  mockLoggerError,
  mockLoggerInfo,
  mockLogSync,
  mockProviderQueueAdd,
  mockRecordMetricStreamBatchPublished,
  mockRecordRelationalCanonicalCommits,
  mockSyncDuration,
  mockSyncErrorsTotal,
  mockSyncOperationsTotal,
  mockSyncRecordsTotal,
  mockWithUserWriteFence,
  resetSyncMocks,
} from "./sync-test/test-helpers.ts";

const { SyncJobContext } = await import("./sync-job-context.ts");
const { executeSyncProvider } = await import("./sync-provider-execution.ts");
async function runSyncJob(job: MockJob, db: SyncDatabase, signal?: AbortSignal) {
  const context = await SyncJobContext.create(job, db, signal);
  const providers = mockGetEnabledSyncProviders().filter(
    (provider) => !job.data.providerId || provider.id === job.data.providerId,
  );
  await context.initializeProviders(providers);
  for (const provider of providers) if (!(await executeSyncProvider(context, provider))) return;
}

describe("sync-provider-execution", () => {
  beforeEach(resetSyncMocks);
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("invalidates user queries after a nonzero WHOOP sync", async () => {
    const provider = createMockProvider({
      id: "whoop",
      name: "WHOOP",
      sync: vi.fn().mockResolvedValue({
        provider: "whoop",
        recordsSynced: 2,
        errors: [],
        duration: 100,
      } satisfies SyncResult),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    await runSyncJob(createMockJob({ providerId: "whoop" }), mockDb);

    expect(mockInvalidateAllUserQueries).toHaveBeenCalledOnce();
    expect(mockInvalidateAllUserQueries).toHaveBeenCalledWith("user-1");
  });

  it("does not invalidate queries when a sync writes no records", async () => {
    const provider = createMockProvider({
      sync: vi.fn().mockResolvedValue({
        provider: "test-provider",
        recordsSynced: 0,
        errors: [],
        duration: 100,
      } satisfies SyncResult),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    await runSyncJob(createMockJob(), mockDb);

    expect(mockInvalidateAllUserQueries).not.toHaveBeenCalled();
  });

  it("reports and rethrows activity canonical commit failures without declaring sync success", async () => {
    const error = new Error("Activity grouping failed");
    mockGetEnabledSyncProviders.mockReturnValue([
      createMockProvider({ processingDatasetKeys: ["activity"] }),
    ]);
    mockRecordRelationalCanonicalCommits.mockRejectedValueOnce(error);
    await expect(runSyncJob(createMockJob(), mockDb)).rejects.toBe(error);
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      tags: { phase: "canonical-commit", provider: "test-provider" },
    });
    expect(mockAppendProcessingStageEvent).not.toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ stage: "ingest", status: "succeeded" }),
    );
    expect(mockEnqueueDebouncedPostSyncMaintenance).not.toHaveBeenCalled();
  });

  it("reports abort during relational canonical commit as a canonical-commit failure", async () => {
    const controller = new AbortController();
    const reason = new DOMException("queue cancelled during canonical commit", "AbortError");
    mockGetEnabledSyncProviders.mockReturnValue([
      createMockProvider({ processingDatasetKeys: ["activity"] }),
    ]);
    mockRecordRelationalCanonicalCommits.mockImplementationOnce(async () => {
      controller.abort(reason);
      throw reason;
    });

    await expect(runSyncJob(createMockJob(), mockDb, controller.signal)).rejects.toBe(reason);
    expect(mockCaptureException).toHaveBeenCalledWith(reason, {
      tags: { phase: "canonical-commit", provider: "test-provider" },
    });
    expect(mockEnqueueDebouncedPostSyncMaintenance).not.toHaveBeenCalled();
  });

  it("does not classify later failures as canonical commit failures", async () => {
    const error = new Error("Output manifest unavailable");
    mockGetEnabledSyncProviders.mockReturnValue([
      createMockProvider({ processingDatasetKeys: ["activity"] }),
    ]);
    mockGetProcessingOutputManifest.mockRejectedValueOnce(error);

    await expect(runSyncJob(createMockJob(), mockDb)).resolves.toBeUndefined();

    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      tags: { provider: "test-provider" },
    });
    expect(mockAppendProcessingStageEvent).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ stage: "ingest", status: "failed" }),
    );
  });

  it("fails metric batch recording when transaction support is malformed", async () => {
    const malformedDatabase = Object.assign(
      {
        select: vi.fn(),
        insert: vi.fn(),
        delete: vi.fn(),
        execute: vi.fn(),
      } satisfies SyncDatabase,
      { transaction: "not-a-function" },
    );
    const provider = createMockProvider({
      sync: vi.fn(async (run: SyncRun) => {
        await run.options.metricStreamPublisher?.publishRows(
          [
            {
              recordedAt: "2026-06-02T10:00:00.000Z",
              userId: "00000000-0000-4000-8000-000000000001",
              providerId: "test-provider",
              externalId: "heart-rate-malformed-db",
              sourceType: "api",
              channel: "heart_rate",
              scalar: 72,
            },
          ],
          { operationRevision: "1000000000000002" },
        );
        return {
          provider: "test-provider",
          recordsSynced: 0,
          errors: [],
          duration: 100,
        };
      }),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    await runSyncJob(createMockJob(), malformedDatabase);

    expect(mockRecordMetricStreamBatchPublished).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Processing metric-stream publication requires a transactional database",
      }),
      { tags: { provider: "test-provider" } },
    );
  });

  it("defers sync without calling the provider when a rate-limit cooldown is already active", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const provider = createMockProvider({
      id: "garmin",
      name: "Garmin",
      sync: vi.fn(),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    const { providerRateLimitCooldownStore } = await import("./provider-rate-limit-cooldown.ts");
    await providerRateLimitCooldownStore.record(
      new ProviderRateLimitError({
        message: "Garmin API rate limit exceeded (429): limited",
        providerId: "garmin",
        statusCode: 429,
        responseBody: "limited",
        scope: "provider",
        retryAfterSeconds: 600,
      }),
      "user-1",
    );

    const job = createMockJob({ providerId: "garmin", userId: "user-1", sinceDays: 1 });
    await runSyncJob(job, mockDb);

    expect(provider.sync).not.toHaveBeenCalled();
    expect(mockProviderQueueAdd).toHaveBeenCalledWith(
      "sync",
      expect.objectContaining({
        providerId: "garmin",
        userId: "user-1",
        sinceIso: "2026-06-01T00:00:00.000Z",
        untilIso: "2026-06-02T23:59:59.999Z",
      }),
      expect.objectContaining({
        delay: 600_000,
        jobId: "provider-rate-limit-garmin-provider-1780402200000",
      }),
    );
    expect(mockLogSync).not.toHaveBeenCalled();
    expect(mockSyncErrorsTotal.add).not.toHaveBeenCalled();
    expect(job.updateProgress).toHaveBeenCalledWith({
      providers: {
        garmin: {
          status: "running",
          message: "Rate limited; retry scheduled for 2026-06-02T12:10:00.000Z",
        },
      },
      percentage: 100,
    });
    vi.useRealTimers();
  });

  it("skips disconnected OAuth providers before active cooldown deferral", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const provider = createMockProvider({
      id: "garmin",
      name: "Garmin",
      authSetup: () => undefined,
      sync: vi.fn(),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);
    mockLoadTokens.mockResolvedValue(null);

    const { providerRateLimitCooldownStore } = await import("./provider-rate-limit-cooldown.ts");
    await providerRateLimitCooldownStore.record(
      new ProviderRateLimitError({
        message: "Garmin API rate limit exceeded (429): limited",
        providerId: "garmin",
        statusCode: 429,
        responseBody: "limited",
        scope: "provider",
        retryAfterSeconds: 600,
      }),
      "user-1",
    );

    const job = createMockJob({ providerId: "garmin", userId: "user-1", sinceDays: 1 });
    await runSyncJob(job, mockDb);

    expect(mockLoadTokens).toHaveBeenCalledWith(mockDb, "garmin", "user-1");
    expect(provider.sync).not.toHaveBeenCalled();
    expect(mockProviderQueueAdd).not.toHaveBeenCalled();
    expect(job.updateProgress).toHaveBeenCalledWith({
      providers: { garmin: { status: "done", message: "Skipped — not connected" } },
      percentage: 100,
    });
    vi.useRealTimers();
  });

  it("updates job progress through pending → running → done states", async () => {
    const provider = createMockProvider({ id: "test", name: "Test" });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

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

  it("logs a scheduled sync with its scheduled origin", async () => {
    const provider = createMockProvider({ id: "test", name: "Test" });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    await runSyncJob(createMockJob({ userId: "user-1", origin: "scheduled" }), mockDb);

    expect(mockLogSync).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        providerId: "test",
        dataType: "sync",
        status: "success",
        recordCount: 5,
        errorMessage: undefined,
        userId: "user-1",
        origin: "scheduled",
      }),
    );
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
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

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
    expect(mockAppendProcessingStageEvent).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        errorCode: "provider_sync_failed",
        errorMessage: "Partial could not be synced. Try the sync again later.",
      }),
    );
  });

  it("records metrics without reporting returned provider connect timeouts to Sentry", async () => {
    const cause = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    const fetchError = new TypeError("fetch failed", { cause });
    const timeout = new ProviderRequestTimeoutError({
      cause: fetchError,
      providerId: "withings",
      timeoutMs: 120_000,
    });
    const provider = createMockProvider({
      id: "withings",
      name: "Withings",
      sync: vi.fn().mockResolvedValue({
        provider: "withings",
        recordsSynced: 0,
        errors: [{ message: "metric_stream: fetch failed", cause: timeout }],
        duration: 50,
      }),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    await runSyncJob(createMockJob({ providerId: "withings" }), mockDb);

    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockSyncOperationsTotal.add).toHaveBeenCalledWith(1, {
      provider: "withings",
      data_type: "sync",
      status: "error",
    });
    expect(mockSyncErrorsTotal.add).toHaveBeenCalledWith(1, {
      provider: "withings",
      data_type: "sync",
    });
  });

  it("reports returned sync errors to Sentry", async () => {
    const cause = new Error("original cause");
    const context = { activityId: 456, activitySport: "CYCLING" };
    const provider = createMockProvider({
      id: "partial",
      name: "Partial",
      sync: vi.fn().mockResolvedValue({
        provider: "partial",
        recordsSynced: 3,
        errors: [{ message: "bad record 1", cause, context }, { message: "bad record 2" }],
        duration: 50,
      }),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    await runSyncJob(createMockJob(), mockDb);

    expect(mockCaptureException).toHaveBeenCalledTimes(2);
    expect(mockCaptureException.mock.calls[0]).toEqual([
      cause,
      { tags: { provider: "partial" }, extra: context },
    ]);
    expect(mockCaptureException.mock.calls[1]).toEqual([
      expect.objectContaining({ message: "bad record 2" }),
      { tags: { provider: "partial" } },
    ]);
  });

  it("does not report returned provider auth errors to Sentry", async () => {
    const cause = new RefreshTokenRevokedError("Withings");
    const provider = createMockProvider({
      id: "withings",
      name: "Withings",
      sync: vi.fn().mockResolvedValue({
        provider: "withings",
        recordsSynced: 0,
        errors: [{ message: cause.message, cause }],
        duration: 50,
      }),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    await runSyncJob(createMockJob(), mockDb);

    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockLogSync).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        providerId: "withings",
        status: "error",
        errorMessage: cause.message,
        authFailureReason: "refresh_token_revoked",
      }),
    );
    expect(mockAppendProcessingStageEvent).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        errorCode: "provider_auth_failed",
        errorMessage: "Withings authorization needs attention. Reconnect Withings, then try again.",
      }),
    );
  });

  it("records metrics without reporting returned provider outages to Sentry", async () => {
    const outage = new ProviderServiceUnavailableError({
      message: "zwift API service unavailable (503)",
      providerId: "zwift",
      statusCode: 503,
      responseBody: "Service Unavailable",
    });
    const provider = createMockProvider({
      id: "zwift",
      name: "Zwift",
      sync: vi.fn().mockResolvedValue({
        provider: "zwift",
        recordsSynced: 0,
        errors: [{ message: `activity: ${outage.message}`, cause: outage }],
        duration: 50,
      }),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    await runSyncJob(createMockJob(), mockDb);

    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockSyncOperationsTotal.add).toHaveBeenCalledWith(1, {
      provider: "zwift",
      data_type: "sync",
      status: "error",
    });
    expect(mockSyncErrorsTotal.add).toHaveBeenCalledWith(1, {
      provider: "zwift",
      data_type: "sync",
    });
  });

  it("calls ensureProvider for each synced provider", async () => {
    const provider = createMockProvider({ id: "test", name: "Test Provider" });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    await runSyncJob(createMockJob(), mockDb);

    expect(mockEnsureProvider).toHaveBeenCalledWith(
      mockDb,
      "test",
      "Test Provider",
      undefined,
      "user-1",
    );
  });

  it("does not enqueue a cooldown retry after cancellation while waiting for the write fence", async () => {
    const provider = createMockProvider({ id: "garmin", name: "Garmin" });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);
    const { providerRateLimitCooldownStore } = await import("./provider-rate-limit-cooldown.ts");
    await providerRateLimitCooldownStore.record(
      new ProviderRateLimitError({
        message: "Garmin API rate limit exceeded (429): limited",
        providerId: "garmin",
        statusCode: 429,
        responseBody: "limited",
        scope: "provider",
        retryAfterSeconds: 600,
      }),
      "user-1",
    );
    let releaseFence!: () => void;
    let markFenceEntered!: () => void;
    const fenceEntered = new Promise<void>((resolve) => {
      markFenceEntered = resolve;
    });
    const fenceGate = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    mockWithUserWriteFence.mockImplementationOnce(
      async (
        database: unknown,
        _userId: string,
        operation: (transaction: unknown) => Promise<unknown>,
      ) => {
        markFenceEntered();
        await fenceGate;
        return operation(database);
      },
    );
    const controller = new AbortController();
    const reason = new DOMException("queue cancelled before cooldown retry", "AbortError");

    const syncPromise = runSyncJob(
      createMockJob({ providerId: "garmin" }),
      mockDb,
      controller.signal,
    );
    await fenceEntered;
    controller.abort(reason);
    releaseFence();

    await expect(syncPromise).rejects.toBe(reason);
    expect(provider.sync).not.toHaveBeenCalled();
    expect(mockProviderQueueAdd).not.toHaveBeenCalled();
  });

  it("emits sync metrics on successful sync", async () => {
    const provider = createMockProvider({ id: "garmin", name: "Garmin" });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

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
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

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

  it("skips providers without stored tokens and logs a message", async () => {
    // Wahoo uses OAuth — has authSetup — so the token check applies
    const provider = createMockProvider({
      id: "wahoo",
      name: "Wahoo",
      authSetup: () => undefined,
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);
    mockLoadTokens.mockResolvedValue(null);

    const progressSnapshots: Array<Record<string, unknown>> = [];
    const job = createMockJob();
    job.updateProgress.mockImplementation((data: Record<string, unknown>) => {
      progressSnapshots.push(structuredClone(data));
      return Promise.resolve();
    });

    await runSyncJob(job, mockDb);

    // sync() should never be called
    expect(provider.sync).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();

    // Verify logger was called via the mocked logger
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("Skipping Wahoo: not connected"),
    );

    // Should report skipped status
    const lastSnapshot = progressSnapshots[progressSnapshots.length - 1];
    expect(lastSnapshot).toEqual({
      providers: { wahoo: { status: "done", message: "Skipped — not connected" } },
      percentage: 100,
    });
  });

  it("syncs providers that have stored tokens", async () => {
    // Strava uses OAuth — has authSetup — so the token check applies and tokens are present
    const provider = createMockProvider({
      id: "strava",
      name: "Strava",
      authSetup: () => undefined,
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);
    mockLoadTokens.mockResolvedValue({
      accessToken: "valid",
      refreshToken: "refresh",
      expiresAt: new Date("2099-01-01"),
      scopes: null,
    });

    await runSyncJob(createMockJob(), mockDb);

    expect(provider.sync).toHaveBeenCalledOnce();
    expect(mockLoadTokens).toHaveBeenCalledWith(mockDb, "strava", "user-1");
  });

  it("skips unconnected providers but syncs connected ones", async () => {
    const connected = createMockProvider({
      id: "strava",
      name: "Strava",
      authSetup: () => undefined,
    });
    const unconnected = createMockProvider({
      id: "wahoo",
      name: "Wahoo",
      authSetup: () => undefined,
    });
    mockGetEnabledSyncProviders.mockReturnValue([connected, unconnected]);
    mockLoadTokens.mockImplementation(async (_db: SyncDatabase, providerId: string) => {
      if (providerId === "strava") {
        return {
          accessToken: "valid",
          refreshToken: "refresh",
          expiresAt: new Date("2099-01-01"),
          scopes: null,
        };
      }
      return null;
    });

    await runSyncJob(createMockJob(), mockDb);

    expect(connected.sync).toHaveBeenCalledOnce();
    expect(unconnected.sync).not.toHaveBeenCalled();
  });

  it("always syncs providers without auth setup even when loadTokens returns null", async () => {
    // Providers like AppleHealth have no authSetup — the token check must be skipped
    const provider = createMockProvider({ id: "apple_health", name: "Apple Health" });
    // No authSetup on the provider (default from createMockProvider)
    expect(provider.authSetup).toBeUndefined();

    mockGetEnabledSyncProviders.mockReturnValue([provider]);
    mockLoadTokens.mockResolvedValue(null);

    await runSyncJob(createMockJob(), mockDb);

    // sync() should be called regardless of tokens
    expect(provider.sync).toHaveBeenCalledOnce();
    expect(mockLoadTokens).not.toHaveBeenCalled();
  });
});
