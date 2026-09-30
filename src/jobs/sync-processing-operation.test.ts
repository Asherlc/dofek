import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../db/index.ts";
import type { SyncRun } from "../providers/sync-run.ts";
import type { SyncResult } from "../providers/types.ts";

import {
  createMockJob,
  createMockProvider,
  type MockJob,
  mockAppendProcessingStageEvent,
  mockCreateMetricStreamEventPublisherForRoute,
  mockCreateProcessingOperation,
  mockDb,
  mockGetEnabledSyncProviders,
  mockGetProcessingOutputManifest,
  mockMetricStreamPublishRows,
  mockRecordMetricStreamBatchPublished,
  mockRecordRelationalCanonicalCommits,
  processingOperationId,
  resetSyncMocks,
} from "./sync-test/test-helpers.ts";

const { SyncJobContext } = await import("./sync-job-context.ts");
const { SyncProcessingOperation } = await import("./sync-processing-operation.ts");
async function runSyncJob(job: MockJob, db: SyncDatabase, signal?: AbortSignal) {
  const context = await SyncJobContext.create(job, db, signal);
  const providers = mockGetEnabledSyncProviders().filter(
    (provider) => !job.data.providerId || provider.id === job.data.providerId,
  );
  await context.initializeProviders(providers);
  for (const provider of providers) {
    const operation = await SyncProcessingOperation.start(job, db, provider);
    const result = await provider.sync(
      context.createRun(provider, operation.metricStreamPublisher),
    );
    await operation.recordOutputs(result.recordsSynced);
    await operation.finish();
  }
}

describe("sync-processing-operation", () => {
  beforeEach(resetSyncMocks);
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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
      targetRefreshWindow: { type: "full" },
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
    expect(mockCreateMetricStreamEventPublisherForRoute).toHaveBeenCalledWith("history");
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

  it("routes rolling provider sync metric output to the live stream", async () => {
    const provider = createMockProvider({
      sync: vi.fn(async (run: SyncRun) => {
        await run.options.metricStreamPublisher?.publishRows(
          [
            {
              recordedAt: "2026-06-02T10:00:00.000Z",
              userId: "00000000-0000-4000-8000-000000000001",
              providerId: "test-provider",
              externalId: "heart-rate-live",
              sourceType: "api",
              channel: "heart_rate",
              scalar: 72,
            },
          ],
          { operationRevision: "1000000000000000" },
        );
        return { provider: "test-provider", recordsSynced: 1, errors: [], duration: 100 };
      }),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    await runSyncJob(createMockJob({ targetRefreshWindow: { type: "days", days: 7 } }), mockDb);

    expect(mockCreateMetricStreamEventPublisherForRoute).toHaveBeenCalledWith("live");
    expect(mockRecordMetricStreamBatchPublished).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ expectedEventCount: 1 }),
    );
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
});
