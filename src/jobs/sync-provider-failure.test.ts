import {
  ProviderRateLimitError,
  ProviderRequestTimeoutError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../db/index.ts";
import { AccessTokenExpiredError } from "../providers/auth-errors.ts";
import { SyncWindow } from "../providers/sync-window.ts";
import type { SyncResult } from "../providers/types.ts";
import type { SyncJob } from "./queues.ts";

import {
  createMockJob,
  createMockProvider,
  MockJobDataSchema,
  mockAppendProcessingStageEvent,
  mockCaptureException,
  mockDb,
  mockEnqueueDebouncedPostSyncMaintenance,
  mockEnqueueDebouncedUserRefit,
  mockGetEnabledSyncProviders,
  mockLogSync,
  mockProviderQueueAdd,
  mockSyncDuration,
  mockSyncErrorsTotal,
  mockSyncOperationsTotal,
  processingOperationId,
  resetSyncMocks,
} from "./sync-test/test-helpers.ts";

const { SyncJobContext } = await import("./sync-job-context.ts");
const { SyncProcessingOperation } = await import("./sync-processing-operation.ts");
const { handleSyncProviderFailure, throwRetryableSyncResultError } = await import(
  "./sync-provider-failure.ts"
);
async function runSyncJob(job: SyncJob, db: SyncDatabase, signal?: AbortSignal) {
  const context = await SyncJobContext.create(job, db, signal);
  const providers = mockGetEnabledSyncProviders().filter(
    (provider) => !job.data.providerId || provider.id === job.data.providerId,
  );
  await context.initializeProviders(providers);
  for (const provider of providers) {
    const operation = await SyncProcessingOperation.start(job, db, provider);
    const startedAt = Date.now();
    try {
      const result = await provider.sync(context.createRun(provider));
      throwRetryableSyncResultError(result.errors);
    } catch (error) {
      await handleSyncProviderFailure(context, provider, operation, startedAt, error);
    }
  }
}

describe("sync-provider-failure", () => {
  beforeEach(resetSyncMocks);
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("records provider rate-limit cooldown records and schedules a deterministic delayed retry", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const provider = createMockProvider({
      id: "garmin",
      name: "Garmin",
      sync: vi.fn().mockRejectedValue(
        new ProviderRateLimitError({
          message: "Garmin API rate limit exceeded (429): limited",
          providerId: "garmin",
          statusCode: 429,
          responseBody: "limited",
          scope: "provider",
          retryAfterSeconds: 600,
        }),
      ),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    const job = createMockJob({ providerId: "garmin", userId: "user-1", sinceDays: 1 });
    await runSyncJob(job, mockDb);

    expect(mockProviderQueueAdd).toHaveBeenCalledWith(
      "sync",
      {
        providerId: "garmin",
        processingOperationIds: { garmin: processingOperationId },
        userId: "user-1",
        requestedAtIso: "2026-06-02T12:00:00.000Z",
        sinceDays: 1,
        sinceIso: "2026-06-01T00:00:00.000Z",
        untilIso: "2026-06-02T23:59:59.999Z",
      },
      expect.objectContaining({
        attempts: 288,
        delay: 600_000,
        jobId: "provider-rate-limit-garmin-provider-1780402200000",
      }),
    );
    expect(mockCaptureException).not.toHaveBeenCalledWith(
      expect.any(ProviderRateLimitError),
      expect.anything(),
    );

    // The rate-limited provider counts as completed (1/1 → 100%) and its status
    // is reported as running with the retry message.
    expect(job.updateProgress).toHaveBeenCalledWith({
      providers: {
        garmin: { status: "running", message: expect.stringContaining("retry scheduled") },
      },
      percentage: 100,
    });

    // The 429 is logged as an error with the provider's message and the elapsed
    // duration (0 under frozen time — guards against Date.now() + syncStart).
    expect(mockLogSync).toHaveBeenCalledWith(mockDb, {
      providerId: "garmin",
      dataType: "sync",
      status: "error",
      errorMessage: "Garmin API rate limit exceeded (429): limited",
      durationMs: 0,
      userId: "user-1",
      origin: "unknown",
    });

    // Metrics are tagged with the provider, not an empty options object.
    expect(mockSyncOperationsTotal.add).toHaveBeenCalledWith(1, {
      provider: "garmin",
      data_type: "sync",
      status: "error",
    });
    expect(mockSyncDuration.record).toHaveBeenCalledWith(0, {
      provider: "garmin",
      data_type: "sync",
    });
    expect(mockSyncErrorsTotal.add).toHaveBeenCalledWith(1, {
      provider: "garmin",
      data_type: "sync",
    });
    vi.useRealTimers();
  });

  it("requeues a rate-limited run with the resolved absolute since timestamp", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const provider = createMockProvider({
      id: "garmin",
      name: "Garmin",
      sync: vi.fn().mockRejectedValue(
        new ProviderRateLimitError({
          message: "Garmin API rate limit exceeded (429): limited",
          providerId: "garmin",
          statusCode: 429,
          responseBody: "limited",
          scope: "provider",
          retryAfterSeconds: 600,
        }),
      ),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    const job = createMockJob({ providerId: "garmin", userId: "user-1", sinceDays: 7 });
    await runSyncJob(job, mockDb);

    // The original run resolved a 7-day window ending at the end of the sync day.
    const expectedWindow = SyncWindow.lastDays(7, { now: new Date("2026-06-02T12:00:00Z") });
    const firstCall = mockProviderQueueAdd.mock.calls[0];
    expect(firstCall).toBeDefined();
    const requeuedData = MockJobDataSchema.parse(firstCall?.[1]);
    expect(requeuedData.sinceIso).toBe(expectedWindow.sinceIso);
    expect(requeuedData.untilIso).toBe(expectedWindow.untilIso);

    // The delayed retry resolves the same absolute window from persisted ISO timestamps.
    vi.setSystemTime(new Date("2026-06-02T12:30:00Z"));
    const retryProvider = createMockProvider({ id: "garmin", name: "Garmin" });
    mockGetEnabledSyncProviders.mockReturnValue([retryProvider]);
    await runSyncJob(createMockJob(requeuedData), mockDb);

    expect(retryProvider.sync).toHaveBeenCalledWith(
      expect.objectContaining({
        db: mockDb,
        window: expectedWindow,
        options: expect.objectContaining({
          onProgress: expect.any(Function),
          userId: "user-1",
        }),
      }),
    );
    vi.useRealTimers();
  });

  it("preserves a scheduled request anchor in a delayed rate-limit retry", async () => {
    vi.setSystemTime(new Date("2026-09-22T18:00:00.000Z"));
    const requestedAtIso = "2026-09-21T06:30:00.000Z";
    const provider = createMockProvider({
      id: "ziva",
      name: "Ziva",
      sync: vi.fn().mockRejectedValue(
        new ProviderRateLimitError({
          message: "Ziva API rate limit exceeded (429): limited",
          providerId: "ziva",
          statusCode: 429,
          responseBody: "limited",
          scope: "user",
          retryAfterSeconds: 600,
        }),
      ),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    await runSyncJob(
      createMockJob({
        origin: "scheduled",
        providerId: "ziva",
        requestedAtIso,
        sinceDays: 1,
      }),
      mockDb,
    );

    const requeuedData = MockJobDataSchema.parse(mockProviderQueueAdd.mock.calls[0]?.[1]);
    expect(requeuedData).toMatchObject({
      origin: "scheduled",
      providerId: "ziva",
      requestedAtIso,
      sinceIso: "2026-09-20T00:00:00.000Z",
      untilIso: "2026-09-21T23:59:59.999Z",
    });
    vi.useRealTimers();
  });

  it("schedules a delayed retry when a sync result returns a rate-limit error", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const rateLimitError = new ProviderRateLimitError({
      message: "Garmin API rate limit exceeded (429): limited",
      providerId: "garmin",
      statusCode: 429,
      responseBody: "limited",
      scope: "provider",
      retryAfterSeconds: 600,
    });
    const provider = createMockProvider({
      id: "garmin",
      name: "Garmin",
      sync: vi.fn().mockResolvedValue({
        provider: "garmin",
        recordsSynced: 0,
        errors: [{ message: rateLimitError.message, cause: rateLimitError }],
        duration: 100,
      } satisfies SyncResult),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    const job = createMockJob({ providerId: "garmin", userId: "user-1", sinceDays: 1 });
    await runSyncJob(job, mockDb);

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
    expect(mockCaptureException).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("logs errors to sync log when provider.sync throws", async () => {
    const provider = createMockProvider({
      id: "broken",
      name: "Broken",
      sync: vi.fn().mockRejectedValue(new Error("API timeout")),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    const progressSnapshots: Array<Record<string, unknown>> = [];
    const job = createMockJob();
    job.updateProgress.mockImplementation((data: Record<string, unknown>) => {
      progressSnapshots.push(structuredClone(data));
      return Promise.resolve();
    });

    // Should not throw — errors are caught per-provider
    await runSyncJob(job, mockDb);

    expect(mockAppendProcessingStageEvent).toHaveBeenCalledWith(mockDb, {
      operationId: processingOperationId,
      stage: "ingest",
      status: "failed",
      errorCode: "provider_sync_failed",
      errorMessage: "Broken could not be synced. Try the sync again later.",
      idempotencyKey: "worker-failed",
    });

    expect(mockLogSync).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        providerId: "broken",
        dataType: "sync",
        status: "error",
        errorMessage: "API timeout",
        durationMs: expect.any(Number),
        userId: "user-1",
        origin: "unknown",
      }),
    );

    // Verify error status was reported in progress with the error message
    const lastSnapshot = progressSnapshots[progressSnapshots.length - 1];
    expect(lastSnapshot).toEqual({
      providers: { broken: { status: "error", message: "API timeout" } },
      percentage: 100,
    });
  });

  it("reports thrown sync errors to Sentry", async () => {
    const thrownError = new Error("API timeout");
    const provider = createMockProvider({
      id: "broken",
      name: "Broken",
      sync: vi.fn().mockRejectedValue(thrownError),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    await runSyncJob(createMockJob(), mockDb);

    expect(mockCaptureException).toHaveBeenCalledWith(thrownError, {
      tags: { provider: "broken" },
    });
  });

  it("does not report thrown expired access token errors to Sentry", async () => {
    const expiredTokenError = new AccessTokenExpiredError("Wahoo");
    const provider = createMockProvider({
      id: "wahoo",
      name: "Wahoo",
      sync: vi.fn().mockRejectedValue(expiredTokenError),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    await runSyncJob(createMockJob(), mockDb);

    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockLogSync).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        providerId: "wahoo",
        status: "error",
        errorMessage: expiredTokenError.message,
        authFailureReason: "access_token_expired",
      }),
    );
    expect(mockAppendProcessingStageEvent).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        errorCode: "provider_auth_failed",
        errorMessage: "Wahoo authorization needs attention. Reconnect Wahoo, then try again.",
      }),
    );
  });

  it("rethrows retryable infrastructure errors so BullMQ retries the same job", async () => {
    const infraError = new Error("FATAL: the database system is in recovery mode");
    const provider = createMockProvider({
      id: "garmin",
      name: "Garmin",
      sync: vi.fn().mockRejectedValue(infraError),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    const job = createMockJob({ providerId: "garmin" });

    await expect(runSyncJob(job, mockDb)).rejects.toThrow("database system is in recovery mode");

    expect(mockCaptureException).toHaveBeenCalledWith(infraError, {
      tags: { provider: "garmin", retryable: "true" },
      level: "warning",
    });
    expect(mockLogSync).not.toHaveBeenCalled();
    expect(mockEnqueueDebouncedPostSyncMaintenance).not.toHaveBeenCalled();
    expect(mockEnqueueDebouncedUserRefit).not.toHaveBeenCalled();
  });

  it("rethrows retryable infrastructure errors returned in sync results", async () => {
    const cause = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    const fetchError = new TypeError("fetch failed", { cause });
    const provider = createMockProvider({
      id: "withings",
      name: "Withings",
      sync: vi.fn().mockResolvedValue({
        provider: "withings",
        recordsSynced: 0,
        errors: [{ message: "metric_stream: fetch failed", cause: fetchError }],
        duration: 50,
      }),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    await expect(runSyncJob(createMockJob({ providerId: "withings" }), mockDb)).rejects.toThrow(
      "fetch failed",
    );

    expect(mockCaptureException).toHaveBeenCalledWith(fetchError, {
      tags: { provider: "withings", retryable: "true" },
      level: "warning",
    });
    expect(mockLogSync).not.toHaveBeenCalled();
  });

  it.each([502, 503, 504, "timeout"])(
    "retries OpenBeta %s without per-attempt Sentry alerts",
    async (status) => {
      const error =
        status === "timeout"
          ? new ProviderRequestTimeoutError({ providerId: "openbeta", timeoutMs: 120_000 })
          : new ProviderServiceUnavailableError({
              providerId: "openbeta",
              statusCode: Number(status),
              message: "upstream unavailable",
              responseBody: "unavailable",
            });
      const provider = createMockProvider({
        id: "openbeta",
        name: "OpenBeta",
        sync: vi.fn().mockRejectedValue(error),
      });
      mockGetEnabledSyncProviders.mockReturnValue([provider]);
      const job = createMockJob({ providerId: "openbeta" });

      await expect(runSyncJob(job, mockDb)).rejects.toBe(error);
      expect(job.updateProgress).toHaveBeenLastCalledWith({
        providers: { openbeta: { status: "running", message: "Service unavailable; retrying" } },
        percentage: 0,
      });
      expect(mockCaptureException).not.toHaveBeenCalled();
      expect(mockLogSync).not.toHaveBeenCalled();
      expect(mockEnqueueDebouncedPostSyncMaintenance).not.toHaveBeenCalled();
    },
  );

  it("records OpenBeta retry exhaustion as a terminal sync failure", async () => {
    const error = new ProviderServiceUnavailableError({
      providerId: "openbeta",
      statusCode: 504,
      message: "upstream unavailable",
      responseBody: "unavailable",
    });
    mockGetEnabledSyncProviders.mockReturnValue([
      createMockProvider({
        id: "openbeta",
        name: "OpenBeta",
        sync: vi.fn().mockRejectedValue(error),
      }),
    ]);
    const job = createMockJob({ providerId: "openbeta" });
    job.attemptsMade = 287;

    await expect(runSyncJob(job, mockDb)).rejects.toBe(error);
    expect(job.updateProgress).toHaveBeenLastCalledWith({
      providers: {
        openbeta: {
          status: "error",
          message:
            "OpenBeta is unavailable and automatic retries were exhausted. Try syncing again later.",
        },
      },
      percentage: 100,
    });
    expect(mockLogSync).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ providerId: "openbeta", status: "error" }),
    );
    expect(mockAppendProcessingStageEvent).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ stage: "ingest", status: "failed" }),
    );
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockEnqueueDebouncedPostSyncMaintenance).not.toHaveBeenCalled();
  });

  it.each([0, 286])(
    "retries Zepp HTTP500 when attemptsMade=%s without Sentry capture",
    async (attemptsMade) => {
      const serviceUnavailableError = new ProviderServiceUnavailableError({
        message: "Zepp API service unavailable (500): upstream outage",
        providerId: "amazfit-zepp",
        statusCode: 500,
        responseBody: "upstream outage",
      });
      const provider = createMockProvider({
        id: "amazfit-zepp",
        name: "Amazfit/Zepp",
        sync: vi.fn().mockRejectedValue(serviceUnavailableError),
      });
      mockGetEnabledSyncProviders.mockReturnValue([provider]);

      const job = createMockJob({ providerId: "amazfit-zepp" });
      job.attemptsMade = attemptsMade;

      await expect(runSyncJob(job, mockDb)).rejects.toBe(serviceUnavailableError);

      expect(job.updateProgress).toHaveBeenLastCalledWith({
        providers: {
          "amazfit-zepp": { status: "running", message: "Service unavailable; retrying" },
        },
        percentage: 0,
      });
      expect(mockCaptureException).not.toHaveBeenCalled();
      expect(mockLogSync).not.toHaveBeenCalled();
      expect(mockEnqueueDebouncedPostSyncMaintenance).not.toHaveBeenCalled();
      expect(mockEnqueueDebouncedUserRefit).not.toHaveBeenCalled();
    },
  );

  it.each([
    { attemptsMade: 287, attempts: 288 },
    { attemptsMade: 0, attempts: undefined },
    { attemptsMade: 0, attempts: 1 },
  ])("records terminal Zepp HTTP500 with retry policy %j", async ({ attemptsMade, attempts }) => {
    const error = new ProviderServiceUnavailableError({
      providerId: "amazfit-zepp",
      statusCode: 500,
      message: "Zepp unavailable",
      responseBody: "outage",
    });
    mockGetEnabledSyncProviders.mockReturnValue([
      createMockProvider({
        id: "amazfit-zepp",
        name: "Amazfit/Zepp",
        sync: vi.fn().mockRejectedValue(error),
      }),
    ]);
    const job = {
      ...createMockJob({ providerId: "amazfit-zepp" }),
      attemptsMade,
      opts: { attempts },
    };
    const message =
      "Amazfit/Zepp is unavailable and automatic retries were exhausted. Try syncing again later.";
    await expect(runSyncJob(job, mockDb)).rejects.toBe(error);
    expect(job.updateProgress).toHaveBeenLastCalledWith({
      providers: { "amazfit-zepp": { status: "error", message } },
      percentage: 100,
    });
    expect(mockAppendProcessingStageEvent).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        stage: "ingest",
        status: "failed",
        errorCode: "provider_sync_failed",
        errorMessage: message,
      }),
    );
    expect(mockLogSync).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        providerId: "amazfit-zepp",
        status: "error",
        errorMessage: message,
      }),
    );
    expect(mockSyncOperationsTotal.add).toHaveBeenCalledWith(1, {
      provider: "amazfit-zepp",
      data_type: "sync",
      status: "error",
    });
    expect(mockSyncErrorsTotal.add).toHaveBeenCalledWith(1, {
      provider: "amazfit-zepp",
      data_type: "sync",
    });
    expect(mockCaptureException).not.toHaveBeenCalled(); // Terminal failed event owns the alert.
  });

  it("records a non-Zepp HTTP 500 service outage without retrying or reporting it to Sentry", async () => {
    const serviceUnavailableError = new ProviderServiceUnavailableError({
      message: "Zwift API service unavailable (500): upstream outage",
      providerId: "zwift",
      statusCode: 500,
      responseBody: "upstream outage",
    });
    const provider = createMockProvider({
      id: "zwift",
      name: "Zwift",
      sync: vi.fn().mockRejectedValue(serviceUnavailableError),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    await runSyncJob(createMockJob({ providerId: "zwift" }), mockDb);

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

  it("records a Zepp HTTP 503 service outage without retrying or reporting it to Sentry", async () => {
    const serviceUnavailableError = new ProviderServiceUnavailableError({
      message: "Zepp API service unavailable (503): upstream outage",
      providerId: "amazfit-zepp",
      statusCode: 503,
      responseBody: "upstream outage",
    });
    const provider = createMockProvider({
      id: "amazfit-zepp",
      name: "Amazfit/Zepp",
      sync: vi.fn().mockRejectedValue(serviceUnavailableError),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    await runSyncJob(createMockJob({ providerId: "amazfit-zepp" }), mockDb);

    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockSyncOperationsTotal.add).toHaveBeenCalledWith(1, {
      provider: "amazfit-zepp",
      data_type: "sync",
      status: "error",
    });
    expect(mockSyncErrorsTotal.add).toHaveBeenCalledWith(1, {
      provider: "amazfit-zepp",
      data_type: "sync",
    });
  });

  it("reports an untyped Zepp HTTP 500 error instead of retrying it", async () => {
    const lookalikeError = Object.assign(new Error("Zepp API returned 500"), {
      providerId: "amazfit-zepp",
      statusCode: 500,
    });
    const provider = createMockProvider({
      id: "amazfit-zepp",
      name: "Amazfit/Zepp",
      sync: vi.fn().mockRejectedValue(lookalikeError),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    await runSyncJob(createMockJob({ providerId: "amazfit-zepp" }), mockDb);

    expect(mockCaptureException).toHaveBeenCalledWith(lookalikeError, {
      tags: { provider: "amazfit-zepp" },
    });
    expect(mockSyncOperationsTotal.add).toHaveBeenCalledWith(1, {
      provider: "amazfit-zepp",
      data_type: "sync",
      status: "error",
    });
  });

  it("records metrics without reporting thrown provider outages to Sentry", async () => {
    const outage = new ProviderServiceUnavailableError({
      message: "zwift API service unavailable (503)",
      providerId: "zwift",
      statusCode: 503,
      responseBody: "Service Unavailable",
    });
    const provider = createMockProvider({
      id: "zwift",
      name: "Zwift",
      sync: vi.fn().mockRejectedValue(outage),
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

  it("does not report provider outages wrapped in an error cause chain", async () => {
    const outage = new ProviderServiceUnavailableError({
      message: "zwift API service unavailable (503)",
      providerId: "zwift",
      statusCode: 503,
      responseBody: "Service Unavailable",
    });
    const provider = createMockProvider({
      id: "zwift",
      name: "Zwift",
      sync: vi.fn().mockRejectedValue(new Error("activity sync failed", { cause: outage })),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    await runSyncJob(createMockJob(), mockDb);

    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockSyncErrorsTotal.add).toHaveBeenCalledWith(1, {
      provider: "zwift",
      data_type: "sync",
    });
  });

  it("reports non-outage errors with a cyclic cause chain", async () => {
    const cycle = new Error("activity sync failed");
    cycle.cause = cycle;
    const provider = createMockProvider({
      id: "zwift",
      name: "Zwift",
      sync: vi.fn().mockRejectedValue(cycle),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    await runSyncJob(createMockJob(), mockDb);

    expect(mockCaptureException).toHaveBeenCalledWith(cycle, {
      tags: { provider: "zwift" },
    });
  });

  it("emits sync error metrics when sync throws", async () => {
    const provider = createMockProvider({
      id: "broken",
      name: "Broken",
      sync: vi.fn().mockRejectedValue(new Error("API timeout")),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

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
