import type { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { vi } from "vitest";
import { z } from "zod";
import type { SyncDatabase } from "../../db/index.ts";
import { createMetricStreamEvent, type MetricStreamRowInput } from "../../metric-stream/events.ts";
import type { MetricStreamPublishOptions } from "../../metric-stream/redpanda-producer.ts";
import type { ProcessingDatasetKey } from "../../processing/dataset-contracts.ts";
import type { SyncProvider, SyncResult } from "../../providers/types.ts";

export type MockCooldownRecord = {
  providerId: string;
  scope: "provider" | "user";
  userId: string | null;
  expiresAt: Date;
};

export const MockJobDataSchema = z.object({
  origin: z.enum(["manual", "scheduled"]).optional(),
  providerId: z.string().optional(),
  requestedAtIso: z.string().optional(),
  sinceDays: z.number().optional(),
  sinceIso: z.string().optional(),
  untilIso: z.string().optional(),
  userId: z.string(),
  checkpoint: z.unknown().optional(),
});

const mockProviderRateLimitCooldownRecords = vi.hoisted(
  (): Map<string, MockCooldownRecord> => new Map(),
);

export const mockCaptureException = vi.fn<(...args: unknown[]) => unknown>();
vi.mock("@sentry/node", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

export const mockWithUserWriteFence = vi.fn(
  async (
    database: unknown,
    _userId: string,
    operation: (transaction: unknown) => Promise<unknown>,
  ) => operation(database),
);
vi.mock("../../db/account-erasure.ts", () => ({
  withAccountErasureUserWriteFence: (
    database: unknown,
    userId: string,
    operation: (transaction: unknown) => Promise<unknown>,
  ) => mockWithUserWriteFence(database, userId, operation),
}));
vi.mock("../../db/account-erasure-processing.ts", () => ({
  isAccountErasureActive: vi.fn(async () => false),
}));
vi.mock("../../db/home-timezone.ts", () => ({
  loadUserHomeTimezone: vi.fn(async () => null),
}));

export const mockLoggerInfo = vi.fn<(...args: unknown[]) => unknown>();
export const mockLoggerError = vi.fn<(...args: unknown[]) => unknown>();
export const mockLoggerWarn = vi.fn<(...args: unknown[]) => unknown>();
export const mockInvalidateAllUserQueries = vi
  .fn<(...args: unknown[]) => unknown>()
  .mockResolvedValue(undefined);

vi.mock("../../lib/cache.ts", () => ({
  invalidateAllUserQueries: (...args: unknown[]) => mockInvalidateAllUserQueries(...args),
}));

vi.mock("../../logger.ts", () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    debug: vi.fn<(...args: unknown[]) => unknown>(),
  },
}));

export const processingOperationId = "30000000-0000-4000-8000-000000000001";
const mockProcessingOutputManifest = vi.hoisted<
  Partial<Record<ProcessingDatasetKey, Array<"metric_stream" | "relational">>>
>(() => ({}));

export function recordMockProcessingOutputs(
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

export const mockCreateProcessingOperation = vi.fn(
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
export const mockAppendProcessingStageEvent = vi.fn(
  async (_database: unknown, _input: unknown) => undefined,
);
export const mockRecordMetricStreamBatchPublished = vi.fn(
  async (_database: unknown, input: { datasetKeys: ProcessingDatasetKey[] }) => {
    recordMockProcessingOutputs(input.datasetKeys, "metric_stream");
  },
);
export const mockRecordRelationalCanonicalCommits = vi.fn(
  async (_database: unknown, input: { datasetKeys: ProcessingDatasetKey[] }) => {
    recordMockProcessingOutputs(input.datasetKeys, "relational");
  },
);
export const mockGetProcessingOutputManifest = vi.fn(
  async (_database: unknown, _operationId: string) => mockProcessingOutputManifest,
);
vi.mock("../../processing/processing-event-store.ts", () => ({
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

export const mockMetricStreamPublishRows = vi.fn(
  async (rows: readonly MetricStreamRowInput[], options: MetricStreamPublishOptions) =>
    rows.map((row) => createMetricStreamEvent(row, options.operationRevision)),
);
export const mockMetricStreamReplaceRows = vi.fn<(...args: unknown[]) => unknown>();
export const mockCreateMetricStreamEventPublisherForRoute = vi.fn(async () => ({
  publishRows: mockMetricStreamPublishRows,
  replaceRows: mockMetricStreamReplaceRows,
}));
vi.mock("../../metric-stream/redpanda-producer.ts", () => ({
  createKafkaMetricStreamEventPublisherForRoute: mockCreateMetricStreamEventPublisherForRoute,
}));

// Mock dependencies — the mock functions are accessed via module-level refs

vi.mock("../provider-registration.ts", () => ({
  ensureProvidersRegistered: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined),
}));

export const mockGetEnabledSyncProviders = vi.fn<() => SyncProvider[]>().mockReturnValue([]);
export const mockGetProvider = vi.fn<
  (providerId: string) => { id: string; importOnly?: boolean } | undefined
>(() => undefined);
export const mockIsSyncEligibleProvider = vi.fn<
  (provider: { id: string; importOnly?: boolean }) => boolean
>(() => true);
vi.mock("../../providers/index.ts", () => ({
  getEnabledSyncProviders: (...args: []) => mockGetEnabledSyncProviders(...args),
  getProvider: (...args: [string]) => mockGetProvider(...args),
  isSyncEligibleProvider: (...args: [{ id: string; importOnly?: boolean }]) =>
    mockIsSyncEligibleProvider(...args),
}));

export const mockLogSync = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined);
vi.mock("../../db/sync-log.ts", () => ({
  logSync: (...args: unknown[]) => mockLogSync(...args),
}));

export const mockEnsureProvider = vi
  .fn<(...args: unknown[]) => unknown>()
  .mockResolvedValue("test-id");
export const mockLoadTokens = vi
  .fn<
    (
      db: SyncDatabase,
      providerId: string,
      userId?: string,
    ) => ReturnType<typeof import("../../db/tokens.ts").loadTokens>
  >()
  .mockResolvedValue({
    accessToken: "valid",
    refreshToken: "refresh",
    expiresAt: new Date("2099-01-01"),
    scopes: null,
  });
vi.mock("../../db/tokens.ts", () => ({
  ensureProvider: (...args: unknown[]) => mockEnsureProvider(...args),
  loadTokens: (...args: Parameters<typeof mockLoadTokens>) => mockLoadTokens(...args),
}));

export const mockEnqueueDebouncedPostSyncMaintenance = vi
  .fn<(...args: unknown[]) => unknown>()
  .mockResolvedValue(undefined);
export const mockEnqueueDebouncedUserRefit = vi
  .fn<(...args: unknown[]) => unknown>()
  .mockResolvedValue(undefined);
export function createMockQueuedJob() {
  return {
    getState: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue("waiting"),
    remove: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined),
  };
}

export const mockProviderQueueAdd = vi
  .fn<(...args: unknown[]) => unknown>()
  .mockResolvedValue(createMockQueuedJob());
export const mockProviderQueueGetJob = vi
  .fn<(...args: unknown[]) => unknown>()
  .mockResolvedValue(undefined);
vi.mock("../queues.ts", () => ({
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

export const mockSyncRecordsTotal = { add: vi.fn<(...args: unknown[]) => unknown>() };
export const mockSyncOperationsTotal = { add: vi.fn<(...args: unknown[]) => unknown>() };
export const mockSyncDuration = { record: vi.fn<(...args: unknown[]) => unknown>() };
export const mockSyncErrorsTotal = { add: vi.fn<(...args: unknown[]) => unknown>() };
vi.mock("../../sync-metrics.ts", () => ({
  syncRecordsTotal: mockSyncRecordsTotal,
  syncOperationsTotal: mockSyncOperationsTotal,
  syncDuration: mockSyncDuration,
  syncErrorsTotal: mockSyncErrorsTotal,
}));

vi.mock("../provider-rate-limit-cooldown.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../provider-rate-limit-cooldown.ts")>();

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

// All DB functions are mocked at module level, so the db object is never actually called.
export const mockDb: SyncDatabase & { transaction: CallableVitestMock } = {
  select: vi.fn(),
  insert: vi.fn(),
  delete: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn<(...args: unknown[]) => unknown>(),
};

export interface MockJob {
  attemptsMade: number;
  opts: { attempts: number };
  id?: string;
  token: string;
  queueQualifiedName: string;
  getDependencies: CallableVitestMock;
  moveToWaitingChildren: CallableVitestMock;
  data: {
    origin?: "manual" | "scheduled";
    providerId?: string;
    requestedAtIso?: string;
    sinceDays?: number;
    sinceIso?: string;
    untilIso?: string;
    targetRefreshWindow?:
      | { type: "full" }
      | { type: "days"; days: number }
      | { type: "range"; sinceIso: string; untilIso: string };
    userId: string;
    checkpoint?: unknown;
    processingOperationIds?: Record<string, string>;
  };
  updateProgress: CallableVitestMock;
  updateData: CallableVitestMock;
}

export function createMockJob(
  data: {
    origin?: "manual" | "scheduled";
    providerId?: string;
    requestedAtIso?: string;
    sinceDays?: number;
    sinceIso?: string;
    untilIso?: string;
    targetRefreshWindow?:
      | { type: "full" }
      | { type: "days"; days: number }
      | { type: "range"; sinceIso: string; untilIso: string };
    userId?: string;
    checkpoint?: unknown;
    processingOperationIds?: Record<string, string>;
  } = {},
): MockJob {
  const job: MockJob = {
    attemptsMade: 0,
    token: "sync-token",
    queueQualifiedName: "bull:sync",
    getDependencies: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue({}),
    moveToWaitingChildren: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(false),
    opts: { attempts: 288 },
    data: { userId: "user-1", ...data },
    updateProgress: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined),
    updateData: vi.fn<(...args: unknown[]) => unknown>(),
  };
  job.updateData.mockImplementation((nextData: MockJob["data"]) => {
    job.data = nextData;
    return Promise.resolve();
  });
  return job;
}

export function createMockProvider(overrides: Partial<SyncProvider> = {}): SyncProvider {
  return {
    id: "test-provider",
    name: "Test Provider",
    processingDatasetKeys: ["recovery", "training"],
    validate: () => null,
    sync: vi.fn<SyncProvider["sync"]>().mockResolvedValue({
      provider: "test-provider",
      recordsSynced: 5,
      errors: [],
      duration: 100,
    } satisfies SyncResult),
    ...overrides,
  };
}

export function resetSyncMocks() {
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
  mockCreateMetricStreamEventPublisherForRoute.mockClear();
  mockWithUserWriteFence.mockImplementation(
    async (
      database: unknown,
      _userId: string,
      operation: (transaction: unknown) => Promise<unknown>,
    ) => operation(database),
  );
}

export { mockProcessingOutputManifest, mockProviderRateLimitCooldownRecords };
