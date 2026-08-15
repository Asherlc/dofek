import {
  ProviderRateLimitError,
  ProviderRequestTimeoutError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SyncDatabase } from "../db/index.ts";
import { createMetricStreamEvent, type MetricStreamRowInput } from "../metric-stream/events.ts";
import type { MetricStreamPublishOptions } from "../metric-stream/redpanda-producer.ts";
import type { ProcessingDatasetKey } from "../processing/dataset-contracts.ts";
import { AccessTokenExpiredError, RefreshTokenRevokedError } from "../providers/auth-errors.ts";
import type { SyncRun } from "../providers/sync-run.ts";
import { SyncWindow } from "../providers/sync-window.ts";
import type { SyncProvider, SyncResult } from "../providers/types.ts";

type MockCooldownRecord = {
  providerId: string;
  scope: "provider" | "user";
  userId: string | null;
  expiresAt: Date;
};

const MockJobDataSchema = z.object({
  origin: z.enum(["manual", "scheduled"]).optional(),
  providerId: z.string().optional(),
  sinceDays: z.number().optional(),
  sinceIso: z.string().optional(),
  untilIso: z.string().optional(),
  userId: z.string(),
  checkpoint: z.unknown().optional(),
});

const mockProviderRateLimitCooldownRecords = vi.hoisted(
  (): Map<string, MockCooldownRecord> => new Map(),
);

const mockCaptureException = vi.fn();
vi.mock("@sentry/node", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

const mockWithUserWriteFence = vi.fn(
  async (
    database: unknown,
    _userId: string,
    operation: (transaction: unknown) => Promise<unknown>,
  ) => operation(database),
);
vi.mock("../db/account-erasure.ts", () => ({
  withAccountErasureUserWriteFence: (
    database: unknown,
    userId: string,
    operation: (transaction: unknown) => Promise<unknown>,
  ) => mockWithUserWriteFence(database, userId, operation),
}));
vi.mock("../db/account-erasure-processing.ts", () => ({
  isAccountErasureActive: vi.fn(async () => false),
}));

const mockLoggerInfo = vi.fn();
const mockLoggerError = vi.fn();
const mockLoggerWarn = vi.fn();
const mockInvalidateAllUserQueries = vi.fn().mockResolvedValue(undefined);

vi.mock("../lib/cache.ts", () => ({
  invalidateAllUserQueries: (...args: unknown[]) => mockInvalidateAllUserQueries(...args),
}));

vi.mock("../logger.ts", () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    debug: vi.fn(),
  },
}));

const processingOperationId = "30000000-0000-4000-8000-000000000001";
const mockProcessingOutputManifest = vi.hoisted<
  Partial<Record<ProcessingDatasetKey, Array<"metric_stream" | "relational">>>
>(() => ({}));

function recordMockProcessingOutputs(
  datasetKeys: readonly ProcessingDatasetKey[],
  outputPath: "metric_stream" | "relational",
): void {
  for (const datasetKey of datasetKeys) {
    const outputPaths = mockProcessingOutputManifest[datasetKey] ?? [];
    if (!outputPaths.includes(outputPath)) {
      outputPaths.push(outputPath);
    }
    mockProcessingOutputManifest[datasetKey] = outputPaths;
  }
}

const mockCreateProcessingOperation = vi.fn(
  async (
    _database: unknown,
    input: {
      userId: string | null;
      providerId?: string | null;
      kind: "provider_sync";
      externalCorrelationKey?: string | null;
      datasetKeys: ProcessingDatasetKey[];
    },
  ) => ({
    id: processingOperationId,
    userId: input.userId,
    providerId: input.providerId ?? null,
    kind: input.kind,
    externalCorrelationKey: input.externalCorrelationKey ?? null,
    datasetKeys: input.datasetKeys,
    createdAt: new Date("2026-06-02T12:00:00.000Z"),
  }),
);
const mockAppendProcessingStageEvent = vi.fn(
  async (_database: unknown, _input: unknown) => undefined,
);
const mockRecordMetricStreamBatchPublished = vi.fn(
  async (_database: unknown, input: { datasetKeys: ProcessingDatasetKey[] }) => {
    recordMockProcessingOutputs(input.datasetKeys, "metric_stream");
  },
);
const mockRecordRelationalCanonicalCommits = vi.fn(
  async (_database: unknown, input: { datasetKeys: ProcessingDatasetKey[] }) => {
    recordMockProcessingOutputs(input.datasetKeys, "relational");
  },
);
const mockGetProcessingOutputManifest = vi.fn(
  async (_database: unknown, _operationId: string) => mockProcessingOutputManifest,
);
vi.mock("../processing/processing-event-store.ts", () => ({
  appendProcessingStageEvent: (database: unknown, input: unknown) =>
    mockAppendProcessingStageEvent(database, input),
  createProcessingOperation: (
    database: unknown,
    input: Parameters<typeof mockCreateProcessingOperation>[1],
  ) => mockCreateProcessingOperation(database, input),
  getProcessingOutputManifest: (database: unknown, operationId: string) =>
    mockGetProcessingOutputManifest(database, operationId),
  recordMetricStreamBatchPublished: (
    database: unknown,
    input: { datasetKeys: ProcessingDatasetKey[] },
  ) => mockRecordMetricStreamBatchPublished(database, input),
  recordRelationalCanonicalCommits: (
    database: unknown,
    input: { datasetKeys: ProcessingDatasetKey[] },
  ) => mockRecordRelationalCanonicalCommits(database, input),
}));

const mockMetricStreamPublishRows = vi.fn(
  async (rows: readonly MetricStreamRowInput[], options: MetricStreamPublishOptions) =>
    rows.map((row) => createMetricStreamEvent(row, options.operationRevision)),
);
const mockMetricStreamReplaceRows = vi.fn();
vi.mock("../metric-stream/redpanda-producer.ts", () => ({
  getDefaultMetricStreamEventPublisher: vi.fn(async () => ({
    publishRows: mockMetricStreamPublishRows,
    replaceRows: mockMetricStreamReplaceRows,
  })),
}));

// Mock dependencies — the mock functions are accessed via module-level refs

vi.mock("./provider-registration.ts", () => ({
  ensureProvidersRegistered: vi.fn().mockResolvedValue(undefined),
}));

const mockGetEnabledSyncProviders = vi.fn<() => SyncProvider[]>().mockReturnValue([]);
const mockGetProvider = vi.fn<
  (providerId: string) => { id: string; importOnly?: boolean } | undefined
>(() => undefined);
const mockIsSyncEligibleProvider = vi.fn<
  (provider: { id: string; importOnly?: boolean }) => boolean
>(() => true);
vi.mock("../providers/index.ts", () => ({
  getEnabledSyncProviders: (...args: []) => mockGetEnabledSyncProviders(...args),
  getProvider: (...args: [string]) => mockGetProvider(...args),
  isSyncEligibleProvider: (...args: [{ id: string; importOnly?: boolean }]) =>
    mockIsSyncEligibleProvider(...args),
}));

const mockLogSync = vi.fn().mockResolvedValue(undefined);
vi.mock("../db/sync-log.ts", () => ({
  logSync: (...args: unknown[]) => mockLogSync(...args),
}));

const mockEnsureProvider = vi.fn().mockResolvedValue("test-id");
const mockLoadTokens = vi.fn().mockResolvedValue({
  accessToken: "valid",
  refreshToken: "refresh",
  expiresAt: new Date("2099-01-01"),
  scopes: null,
});
vi.mock("../db/tokens.ts", () => ({
  ensureProvider: (...args: unknown[]) => mockEnsureProvider(...args),
  loadTokens: (...args: unknown[]) => mockLoadTokens(...args),
}));

const mockEnqueueDebouncedPostSyncMaintenance = vi.fn().mockResolvedValue(undefined);
const mockEnqueueDebouncedUserRefit = vi.fn().mockResolvedValue(undefined);
function createMockQueuedJob() {
  return {
    getState: vi.fn().mockResolvedValue("waiting"),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

const mockProviderQueueAdd = vi.fn().mockResolvedValue(createMockQueuedJob());
const mockProviderQueueGetJob = vi.fn().mockResolvedValue(undefined);
vi.mock("./queues.ts", () => ({
  enqueueDebouncedPostSyncMaintenance: (...args: unknown[]) =>
    mockEnqueueDebouncedPostSyncMaintenance(...args),
  enqueueDebouncedUserRefit: (...args: unknown[]) => mockEnqueueDebouncedUserRefit(...args),
  getProviderSyncQueue: vi.fn(() => ({
    add: mockProviderQueueAdd,
    getJob: mockProviderQueueGetJob,
  })),
  SYNC_JOB_RETRY_OPTIONS: {
    attempts: 288,
    backoff: { type: "fixed", delay: 300_000 },
    removeOnComplete: { age: 86_400, count: 1_000 },
    removeOnFail: { age: 604_800, count: 1_000 },
  },
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

vi.mock("./provider-rate-limit-cooldown.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./provider-rate-limit-cooldown.ts")>();

  function cooldownKey(providerId: string, scope: "provider" | "user", userId: string | null) {
    return scope === "provider"
      ? `${providerId}:provider`
      : `${providerId}:user:${userId ?? "unknown"}`;
  }

  function activeCooldown(cooldown: MockCooldownRecord | null): MockCooldownRecord | null {
    if (!cooldown) return null;
    return cooldown.expiresAt > new Date() ? cooldown : null;
  }

  function laterCooldown(
    first: MockCooldownRecord | null,
    second: MockCooldownRecord | null,
  ): MockCooldownRecord | null {
    if (!first) return second;
    if (!second) return first;
    return first.expiresAt >= second.expiresAt ? first : second;
  }

  return {
    ...actual,
    providerRateLimitCooldownStore: {
      record: async (error: ProviderRateLimitError, fallbackUserId: string) => {
        const scope = error.scope;
        const userId = scope === "user" ? (error.userId ?? fallbackUserId) : null;
        const expiresAt = new Date(Date.now() + (error.retryAfterSeconds ?? 30 * 60) * 1000);
        const cooldown = { providerId: error.providerId, scope, userId, expiresAt };
        const key = cooldownKey(cooldown.providerId, cooldown.scope, cooldown.userId);
        const existing = activeCooldown(mockProviderRateLimitCooldownRecords.get(key) ?? null);
        const effective = laterCooldown(existing, cooldown) ?? cooldown;
        mockProviderRateLimitCooldownRecords.set(key, effective);
        return effective;
      },
      getActive: async (providerId: string, userId: string) => {
        const providerCooldown = activeCooldown(
          mockProviderRateLimitCooldownRecords.get(cooldownKey(providerId, "provider", null)) ??
            null,
        );
        const userCooldown = activeCooldown(
          mockProviderRateLimitCooldownRecords.get(cooldownKey(providerId, "user", userId)) ?? null,
        );
        return laterCooldown(providerCooldown, userCooldown);
      },
    },
  };
});

// Import after mocks are set up
const { processSyncJob } = await import("./process-sync-job.ts");

// All DB functions are mocked at module level, so the db object is never actually called.
const mockDb: SyncDatabase & { transaction: ReturnType<typeof vi.fn> } = {
  select: vi.fn(),
  insert: vi.fn(),
  delete: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
};

interface MockJob {
  id?: string;
  data: {
    origin?: "manual" | "scheduled";
    providerId?: string;
    sinceDays?: number;
    sinceIso?: string;
    untilIso?: string;
    targetRefreshWindow?: { type: "full" } | { type: "days"; days: number };
    userId: string;
    checkpoint?: unknown;
    processingOperationIds?: Record<string, string>;
  };
  updateProgress: ReturnType<typeof vi.fn>;
  updateData: ReturnType<typeof vi.fn>;
}

function createMockJob(
  data: {
    origin?: "manual" | "scheduled";
    providerId?: string;
    sinceDays?: number;
    sinceIso?: string;
    untilIso?: string;
    targetRefreshWindow?: { type: "full" } | { type: "days"; days: number };
    userId?: string;
    checkpoint?: unknown;
    processingOperationIds?: Record<string, string>;
  } = {},
): MockJob {
  const job: MockJob = {
    data: { userId: "user-1", ...data },
    updateProgress: vi.fn().mockResolvedValue(undefined),
    updateData: vi.fn(),
  };
  job.updateData.mockImplementation((nextData: MockJob["data"]) => {
    job.data = nextData;
    return Promise.resolve();
  });
  return job;
}

function createMockProvider(overrides: Partial<SyncProvider> = {}): SyncProvider {
  return {
    id: "test-provider",
    name: "Test Provider",
    processingDatasetKeys: ["recovery", "training"],
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
    mockProviderRateLimitCooldownRecords.clear();
    for (const datasetKey of Object.keys(mockProcessingOutputManifest)) {
      Reflect.deleteProperty(mockProcessingOutputManifest, datasetKey);
    }
    // Restore default return values after clearAllMocks
    mockGetEnabledSyncProviders.mockReturnValue([]);
    mockGetProvider.mockReturnValue(undefined);
    mockIsSyncEligibleProvider.mockReturnValue(true);
    mockLogSync.mockResolvedValue(undefined);
    mockEnsureProvider.mockResolvedValue("test-id");
    mockLoadTokens.mockResolvedValue({
      accessToken: "valid",
      refreshToken: "refresh",
      expiresAt: new Date("2099-01-01"),
      scopes: null,
    });
    mockEnqueueDebouncedPostSyncMaintenance.mockResolvedValue(undefined);
    mockEnqueueDebouncedUserRefit.mockResolvedValue(undefined);
    mockInvalidateAllUserQueries.mockResolvedValue(undefined);
    mockProviderQueueAdd.mockResolvedValue(createMockQueuedJob());
    mockProviderQueueGetJob.mockResolvedValue(undefined);
    mockCreateProcessingOperation.mockClear();
    mockAppendProcessingStageEvent.mockClear();
    mockRecordMetricStreamBatchPublished.mockClear();
    mockRecordRelationalCanonicalCommits.mockClear();
    mockGetProcessingOutputManifest.mockReset();
    mockGetProcessingOutputManifest.mockImplementation(
      async (_database: unknown, _operationId: string) => mockProcessingOutputManifest,
    );
    mockMetricStreamPublishRows.mockClear();
    mockMetricStreamReplaceRows.mockClear();
    mockWithUserWriteFence.mockImplementation(
      async (
        database: unknown,
        _userId: string,
        operation: (transaction: unknown) => Promise<unknown>,
      ) => operation(database),
    );
  });

  afterEach(() => {
    // Restore real timers so a test that throws before its own useRealTimers()
    // can't leak the fake clock into later tests.
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("syncs all valid providers when no providerId specified", async () => {
    const providerA = createMockProvider({ id: "a", name: "Provider A" });
    const providerB = createMockProvider({ id: "b", name: "Provider B" });
    mockGetEnabledSyncProviders.mockReturnValue([providerA, providerB]);

    await runSyncJob(createMockJob(), mockDb);

    expect(providerA.sync).toHaveBeenCalledOnce();
    expect(providerB.sync).toHaveBeenCalledOnce();
    expect(mockInvalidateAllUserQueries).toHaveBeenCalledTimes(2);
    expect(mockInvalidateAllUserQueries).toHaveBeenCalledWith("user-1");
  });

  it("invalidates WHOOP journal queries after a nonzero sync", async () => {
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

  it("records a retry-stable processing lifecycle and correlates metric batches", async () => {
    const provider = createMockProvider({
      id: "garmin",
      name: "Garmin",
      processingDatasetKeys: ["recovery", "training"],
      sync: vi.fn(async (run: SyncRun) => {
        await run.options.metricStreamPublisher?.publishRows(
          [
            {
              recordedAt: "2026-06-02T10:00:00.000Z",
              userId: "00000000-0000-4000-8000-000000000001",
              providerId: "garmin",
              externalId: "heart-rate-1",
              sourceType: "api",
              channel: "heart_rate",
              scalar: 72,
            },
          ],
          { operationRevision: "1000000000000000" },
        );
        return {
          provider: "garmin",
          recordsSynced: 1,
          errors: [],
          duration: 100,
        };
      }),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);
    const job = createMockJob({
      providerId: "garmin",
      userId: "00000000-0000-4000-8000-000000000001",
    });
    Object.assign(job, { id: "bull-sync-1852" });

    await runSyncJob(job, mockDb);

    expect(mockCreateProcessingOperation).toHaveBeenCalledWith(mockDb, {
      userId: "00000000-0000-4000-8000-000000000001",
      providerId: "garmin",
      kind: "provider_sync",
      externalCorrelationKey: "bull-sync-1852:garmin",
      datasetKeys: ["recovery", "training"],
    });
    expect(job.data.processingOperationIds).toEqual({ garmin: processingOperationId });
    expect(mockAppendProcessingStageEvent).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        operationId: processingOperationId,
        stage: "ingest",
        status: "queued",
        idempotencyKey: "worker-queued",
      }),
    );
    expect(mockAppendProcessingStageEvent).toHaveBeenCalledWith(mockDb, {
      operationId: processingOperationId,
      stage: "ingest",
      status: "running",
      progressPercentage: 0,
      idempotencyKey: "worker-running",
    });
    expect(mockAppendProcessingStageEvent).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        operationId: processingOperationId,
        stage: "ingest",
        status: "succeeded",
        progressPercentage: 100,
        idempotencyKey: "worker-succeeded",
      }),
    );
    expect(mockMetricStreamPublishRows).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        processing: expect.objectContaining({
          operationId: processingOperationId,
          datasetKeys: ["recovery", "training"],
        }),
      }),
    );
    expect(mockRecordMetricStreamBatchPublished).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        operationId: processingOperationId,
        datasetKeys: ["recovery", "training"],
        expectedEventCount: 1,
      }),
    );
    expect(mockRecordRelationalCanonicalCommits).toHaveBeenCalledWith(mockDb, {
      operationId: processingOperationId,
      datasetKeys: ["recovery", "training"],
      idempotencyKey: "worker-relational-commit:bull-sync-1852",
    });
  });

  it("records metric-only output without fabricating a relational dependency", async () => {
    const provider = createMockProvider({
      sync: vi.fn(async (run: SyncRun) => {
        await run.options.metricStreamPublisher?.publishRows(
          [
            {
              recordedAt: "2026-06-02T10:00:00.000Z",
              userId: "00000000-0000-4000-8000-000000000001",
              providerId: "test-provider",
              externalId: "heart-rate-only",
              sourceType: "api",
              channel: "heart_rate",
              scalar: 72,
            },
          ],
          { operationRevision: "1000000000000001" },
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

    await runSyncJob(createMockJob(), mockDb);

    expect(mockRecordMetricStreamBatchPublished).toHaveBeenCalledOnce();
    expect(mockRecordRelationalCanonicalCommits).not.toHaveBeenCalled();
    expect(mockAppendProcessingStageEvent).not.toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ status: "skipped", stage: "analytics" }),
    );
  });

  it("does not record relational output for a metric-only dataset", async () => {
    const provider = createMockProvider({
      processingDatasetKeys: ["body"],
      sync: vi.fn(async (run: SyncRun) => {
        await run.options.metricStreamPublisher?.publishRows(
          [
            {
              recordedAt: "2026-06-02T10:00:00.000Z",
              userId: "00000000-0000-4000-8000-000000000001",
              providerId: "test-provider",
              externalId: "body-only",
              sourceType: "api",
              channel: "weight",
              scalar: 75,
            },
          ],
          { operationRevision: "1000000000000001" },
        );
        return {
          provider: "test-provider",
          recordsSynced: 1,
          errors: [],
          duration: 100,
        } satisfies SyncResult;
      }),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    await runSyncJob(createMockJob(), mockDb);

    expect(mockRecordRelationalCanonicalCommits).not.toHaveBeenCalled();
    expect(mockAppendProcessingStageEvent).not.toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ status: "skipped" }),
    );
  });

  it("records relational-only output without requiring a metric batch", async () => {
    const provider = createMockProvider({
      processingDatasetKeys: ["nutrition"],
      sync: vi.fn(async (run: SyncRun) => {
        expect(run.options.metricStreamPublisher).toBeUndefined();
        return {
          provider: "test-provider",
          recordsSynced: 5,
          errors: [],
          duration: 100,
        } satisfies SyncResult;
      }),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    await runSyncJob(createMockJob(), mockDb);

    expect(mockRecordRelationalCanonicalCommits).toHaveBeenCalledOnce();
    expect(mockRecordMetricStreamBatchPublished).not.toHaveBeenCalled();
  });

  it("filters out invalid providers", async () => {
    const valid = createMockProvider({ id: "valid", name: "Valid" });
    mockGetEnabledSyncProviders.mockReturnValue([valid]);

    await runSyncJob(createMockJob(), mockDb);

    expect(valid.sync).toHaveBeenCalledOnce();
  });

  it("records legitimate no-output datasets as skipped", async () => {
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

    expect(mockRecordRelationalCanonicalCommits).not.toHaveBeenCalled();
    expect(mockAppendProcessingStageEvent).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        operationId: processingOperationId,
        datasetKey: "recovery",
        stage: "analytics",
        status: "skipped",
        idempotencyKey: "no-output:recovery:analytics",
      }),
    );
    expect(mockAppendProcessingStageEvent).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        operationId: processingOperationId,
        datasetKey: "training",
        stage: "cache_refresh",
        status: "skipped",
        idempotencyKey: "no-output:training:cache_refresh",
      }),
    );
  });

  it("records no-output skips when a relational-only dataset emits nothing", async () => {
    const provider = createMockProvider({
      processingDatasetKeys: ["nutrition"],
      sync: vi.fn().mockResolvedValue({
        provider: "test-provider",
        recordsSynced: 0,
        errors: [],
        duration: 100,
      } satisfies SyncResult),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    await runSyncJob(createMockJob(), mockDb);

    expect(mockAppendProcessingStageEvent).toHaveBeenCalledWith(mockDb, {
      operationId: processingOperationId,
      stage: "analytics",
      status: "skipped",
      datasetKey: "nutrition",
      message: "No new data was emitted for this dataset",
      idempotencyKey: "no-output:nutrition:analytics",
    });
    expect(mockAppendProcessingStageEvent).toHaveBeenCalledWith(mockDb, {
      operationId: processingOperationId,
      stage: "cache_refresh",
      status: "skipped",
      datasetKey: "nutrition",
      message: "No new data was emitted for this dataset",
      idempotencyKey: "no-output:nutrition:cache_refresh",
    });
  });

  it("does not mark output from an earlier continuation attempt as skipped", async () => {
    const provider = createMockProvider({
      id: "garmin",
      sync: vi.fn().mockResolvedValue({
        provider: "garmin",
        recordsSynced: 0,
        errors: [],
        duration: 100,
      } satisfies SyncResult),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);
    mockGetProcessingOutputManifest.mockResolvedValue({ recovery: ["metric_stream"] });

    await runSyncJob(
      createMockJob({
        providerId: "garmin",
        processingOperationIds: { garmin: processingOperationId },
      }),
      mockDb,
    );

    expect(mockAppendProcessingStageEvent).not.toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        datasetKey: "recovery",
        status: "skipped",
      }),
    );
    expect(mockAppendProcessingStageEvent).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        datasetKey: "training",
        status: "skipped",
      }),
    );
  });

  it("reuses the persisted processing operation on retry", async () => {
    const provider = createMockProvider({ id: "garmin", name: "Garmin" });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);
    const persistedOperationId = "30000000-0000-4000-8000-000000000099";
    const job = createMockJob({
      providerId: "garmin",
      processingOperationIds: { garmin: persistedOperationId },
    });

    await runSyncJob(job, mockDb);

    expect(mockCreateProcessingOperation).not.toHaveBeenCalled();
    expect(job.updateData).not.toHaveBeenCalled();
    expect(mockAppendProcessingStageEvent).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        operationId: persistedOperationId,
        idempotencyKey: "worker-queued",
      }),
    );
  });

  it("builds a stable fallback correlation key from absolute sync bounds", async () => {
    const provider = createMockProvider({ id: "garmin", name: "Garmin" });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    await runSyncJob(
      createMockJob({
        providerId: "garmin",
        sinceIso: "2026-06-01T00:00:00.000Z",
        untilIso: "2026-06-02T23:59:59.999Z",
      }),
      mockDb,
    );

    expect(mockCreateProcessingOperation).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        externalCorrelationKey:
          "user-1:garmin:2026-06-01T00:00:00.000Z:2026-06-02T23:59:59.999Z:garmin",
      }),
    );
  });

  it("builds a stable fallback correlation key from a relative sync window", async () => {
    const provider = createMockProvider({ id: "garmin", name: "Garmin" });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    await runSyncJob(createMockJob({ providerId: "garmin", sinceDays: 30 }), mockDb);

    expect(mockCreateProcessingOperation).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        externalCorrelationKey: "user-1:garmin:days:30:open:garmin",
      }),
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

  it("syncs only the specified provider when providerId is given", async () => {
    const providerA = createMockProvider({ id: "a", name: "Provider A" });
    const providerB = createMockProvider({ id: "b", name: "Provider B" });
    mockGetEnabledSyncProviders.mockReturnValue([providerA, providerB]);

    await runSyncJob(createMockJob({ providerId: "b" }), mockDb);

    expect(providerA.sync).not.toHaveBeenCalled();
    expect(providerB.sync).toHaveBeenCalledOnce();
  });

  it("throws for unknown providerId", async () => {
    const providerA = createMockProvider({ id: "a", name: "Provider A" });
    mockGetEnabledSyncProviders.mockReturnValue([providerA]);

    await expect(runSyncJob(createMockJob({ providerId: "nonexistent" }), mockDb)).rejects.toThrow(
      "Unknown provider: nonexistent",
    );
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

  it("skips import-only providers when enqueued by id", async () => {
    mockGetProvider.mockReturnValue({ id: "strong-csv", importOnly: true });
    mockIsSyncEligibleProvider.mockReturnValue(false);

    const job = createMockJob({ providerId: "strong-csv" });
    await runSyncJob(job, mockDb);

    expect(job.updateProgress).toHaveBeenCalledWith({
      providers: { "strong-csv": { status: "done", message: "Skipped file-import provider" } },
      percentage: 100,
    });
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

  it("enqueues debounced global maintenance and per-user refit after sync", async () => {
    mockGetEnabledSyncProviders.mockReturnValue([]);

    await runSyncJob(createMockJob(), mockDb);

    expect(mockEnqueueDebouncedPostSyncMaintenance).toHaveBeenCalledOnce();
    expect(mockEnqueueDebouncedUserRefit).toHaveBeenCalledWith("user-1");
    expect(mockWithUserWriteFence).toHaveBeenCalledWith(mockDb, "user-1", expect.any(Function));
  });

  it("enqueues a continuation job and skips post-sync when sync returns continued", async () => {
    const continuationCheckpoint = { phase: "api", apiStepIndex: 2 };
    const provider = createMockProvider({
      id: "whoop",
      name: "WHOOP",
      sync: vi.fn().mockImplementation(async (run: SyncRun): Promise<SyncResult> => {
        await run.options.enqueueSyncContinuation?.(continuationCheckpoint);
        return {
          provider: "whoop",
          recordsSynced: 4,
          errors: [],
          duration: 12,
          continued: true,
        };
      }),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    const job = createMockJob({ providerId: "whoop" });
    await runSyncJob(job, mockDb);

    expect(mockProviderQueueAdd).toHaveBeenCalledWith(
      "sync",
      expect.objectContaining({
        providerId: "whoop",
        sinceIso: expect.any(String),
        untilIso: expect.any(String),
        checkpoint: continuationCheckpoint,
      }),
      expect.any(Object),
    );
    expect(mockEnqueueDebouncedPostSyncMaintenance).not.toHaveBeenCalled();
    expect(mockEnqueueDebouncedUserRefit).not.toHaveBeenCalled();
    expect(mockWithUserWriteFence).toHaveBeenCalledWith(mockDb, "user-1", expect.any(Function));
    expect(job.updateProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: { whoop: { status: "running", message: "4 synced so far" } },
      }),
    );
  });

  it("continues when global post-sync enqueue fails", async () => {
    const enqueueError = new Error("queue gone");
    mockGetEnabledSyncProviders.mockReturnValue([]);
    mockEnqueueDebouncedPostSyncMaintenance.mockRejectedValue(enqueueError);

    // Should not throw
    await runSyncJob(createMockJob(), mockDb);

    expect(mockEnqueueDebouncedPostSyncMaintenance).toHaveBeenCalledOnce();
    expect(mockEnqueueDebouncedUserRefit).toHaveBeenCalledWith("user-1");
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining("Failed to enqueue global post-sync maintenance"),
    );
    expect(mockCaptureException).toHaveBeenCalledWith(enqueueError, {
      tags: { phase: "post-sync-global-maintenance-enqueue" },
    });
  });

  it("continues when per-user refit enqueue fails", async () => {
    const enqueueError = new Error("queue gone");
    mockGetEnabledSyncProviders.mockReturnValue([]);
    mockEnqueueDebouncedUserRefit.mockRejectedValue(enqueueError);

    await runSyncJob(createMockJob(), mockDb);

    expect(mockEnqueueDebouncedPostSyncMaintenance).toHaveBeenCalledOnce();
    expect(mockEnqueueDebouncedUserRefit).toHaveBeenCalledWith("user-1");
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining("Failed to enqueue user refit"),
    );
    expect(mockCaptureException).toHaveBeenCalledWith(enqueueError, {
      tags: { phase: "post-sync-user-refit-enqueue" },
    });
  });

  it("relays within-provider progress to job.updateProgress with correct percentage", async () => {
    // Provider that calls the onProgress callback during sync
    const provider = createMockProvider({
      id: "test",
      name: "Test",
      sync: vi.fn().mockImplementation(async (run: SyncRun) => {
        run.options?.onProgress?.(50, "5/10 activities");
        return { provider: "test", recordsSynced: 10, errors: [], duration: 100 };
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
    mockGetEnabledSyncProviders.mockReturnValue([providerA, providerB]);

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
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    const now = new Date("2026-06-18T15:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(now.getTime());

    await runSyncJob(createMockJob({ sinceDays: 30 }), mockDb);

    const expectedWindow = SyncWindow.lastDays(30, { now });
    expect(provider.sync).toHaveBeenCalledWith(
      expect.objectContaining({
        db: mockDb,
        window: expectedWindow,
        options: expect.objectContaining({
          onProgress: expect.any(Function),
          userId: "user-1",
        }),
      }),
    );
  });

  it("uses sinceIso instead of recomputing sinceDays on retry", async () => {
    const provider = createMockProvider({ id: "test", name: "Test" });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const sinceIso = "2026-03-15T12:00:00.000Z";

    await runSyncJob(createMockJob({ sinceDays: 30, sinceIso }), mockDb);

    expect(provider.sync).toHaveBeenCalledWith(
      expect.objectContaining({
        db: mockDb,
        window: SyncWindow.fromIsoRange({
          sinceIso,
          untilIso: new Date(now).toISOString(),
        }),
        options: expect.objectContaining({
          onProgress: expect.any(Function),
          userId: "user-1",
        }),
      }),
    );
  });

  it("passes a Redis-backed checkpoint store to providers", async () => {
    const initialCheckpoint = { phase: "sleep", nextDate: "2026-03-02" };
    const savedCheckpoint = { phase: "daily_metrics", nextDate: "2026-03-03" };
    const observedCheckpoints: unknown[] = [];
    const provider = createMockProvider({
      id: "garmin",
      name: "Garmin",
      sync: vi.fn().mockImplementation(async (run: SyncRun): Promise<SyncResult> => {
        const options = run.options;
        observedCheckpoints.push(await options?.checkpoint?.load());
        await options?.checkpoint?.save(savedCheckpoint);
        return { provider: "garmin", recordsSynced: 1, errors: [], duration: 10 };
      }),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    const job = createMockJob({ providerId: "garmin", checkpoint: initialCheckpoint });

    await runSyncJob(job, mockDb);

    expect(observedCheckpoints).toEqual([initialCheckpoint]);
    expect(job.updateData).toHaveBeenCalledWith({
      providerId: "garmin",
      processingOperationIds: { garmin: processingOperationId },
      userId: "user-1",
      checkpoint: savedCheckpoint,
    });
    expect(job.data.checkpoint).toEqual(savedCheckpoint);
  });

  it("uses epoch when sinceDays is not provided", async () => {
    const provider = createMockProvider({ id: "test", name: "Test" });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    const now = new Date("2026-06-18T15:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(now.getTime());

    await runSyncJob(createMockJob({}), mockDb);

    expect(provider.sync).toHaveBeenCalledWith(
      expect.objectContaining({
        db: mockDb,
        window: SyncWindow.full(now),
        options: expect.objectContaining({
          onProgress: expect.any(Function),
          userId: "user-1",
        }),
      }),
    );
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
