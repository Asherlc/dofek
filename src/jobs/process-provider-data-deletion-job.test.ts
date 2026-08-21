import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.ts";
import {
  type ProviderDataDeletionJob,
  processProviderDataDeletionJob,
} from "./process-provider-data-deletion-job.ts";
import type { ProviderDataDeletionJobData } from "./queues.ts";

const mockCaptureException = vi.hoisted(() => vi.fn());
const mockInvalidateAllUserQueries = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@sentry/node", () => ({ captureException: mockCaptureException }));
vi.mock("dofek/lib/cache", () => ({
  invalidateAllUserQueries: mockInvalidateAllUserQueries,
}));

const firstId = "10000000-0000-4000-8000-000000000001";
const secondId = "20000000-0000-4000-8000-000000000002";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function tombstoneRow(id: string, generation: number) {
  return {
    activity_id: null,
    channel: "heart_rate",
    device_id: null,
    external_id: id,
    generation,
    id,
    ingested_at: "2026-07-19 00:00:00.000000000",
    is_deleted: 1,
    metadata: "{}",
    point: "null",
    provider_id: "garmin",
    recorded_at: "2026-07-18 12:00:00.000000",
    scalar: 140,
    source_type: "test",
    user_id: "00000000-0000-4000-8000-000000000004",
    vector: [],
    version: 2,
  };
}

function makeJob(dataOverrides: Partial<ProviderDataDeletionJobData> = {}) {
  const data: ProviderDataDeletionJobData = {
    type: "provider-data-deletion",
    eventId: "30000000-0000-4000-8000-000000000003",
    generation: 2,
    providerId: "garmin",
    userId: "00000000-0000-4000-8000-000000000004",
    ...dataOverrides,
  };
  return {
    data,
    updateData: vi.fn(async (nextData: ProviderDataDeletionJobData) => {
      Object.assign(data, nextData);
    }),
    updateProgress: vi.fn(
      async (_progress: Parameters<ProviderDataDeletionJob["updateProgress"]>[0]) => undefined,
    ),
  };
}

describe("processProviderDataDeletionJob", () => {
  it("enqueues the next checkpoint as a separate job after one bounded batch", async () => {
    const command = vi.fn(async () => undefined);
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        json: async () => [{ active_parts: 1, missing_projection_parts: 0 }],
      })
      .mockResolvedValueOnce({ json: async () => [{ generation: 0, id: firstId }] })
      .mockResolvedValueOnce({ json: async () => [tombstoneRow(firstId, 0)] });
    const enqueueContinuation = vi.fn(async () => undefined);
    const enqueueAnalyticsRefresh = vi.fn(async () => undefined);
    const markCompleted = vi.fn(async () => undefined);
    const job = makeJob();

    await processProviderDataDeletionJob(job, {
      accountErasureAllowsWork: vi.fn(async () => true),
      clickHouseClient: { command, insert: vi.fn(async () => undefined), query },
      enqueueAnalyticsRefresh,
      enqueueContinuation,
      markCompleted,
    });

    expect(enqueueContinuation).toHaveBeenCalledWith({
      ...job.data,
      checkpoint: {
        batches: 1,
        deletedRows: 1,
        examinedRows: 1,
        lastGeneration: 0,
        lastId: firstId,
      },
    });
    expect(query).toHaveBeenCalledTimes(3);
    expect(enqueueAnalyticsRefresh).not.toHaveBeenCalled();
    expect(markCompleted).not.toHaveBeenCalled();
  });

  it("advances the ClickHouse generation fence, checkpoints bounded batches, then acknowledges", async () => {
    const command = vi.fn(
      async (_options: { query: string; query_params?: Record<string, unknown> }) => undefined,
    );
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        json: async () => [{ active_parts: 1, missing_projection_parts: 0 }],
      })
      .mockResolvedValueOnce({
        json: async () => [
          { generation: 0, id: firstId },
          { generation: 1, id: secondId },
        ],
      })
      .mockResolvedValueOnce({
        json: async () => [tombstoneRow(firstId, 0), tombstoneRow(secondId, 1)],
      })
      .mockResolvedValueOnce({ json: async () => [] });
    const insert = vi.fn(async () => undefined);
    const enqueueAnalyticsRefresh = vi.fn(async () => undefined);
    const enqueueContinuation = vi.fn(async () => undefined);
    const markCompleted = vi.fn(async () => undefined);
    const job = makeJob();

    await processProviderDataDeletionJob(job, {
      accountErasureAllowsWork: vi.fn(async () => true),
      clickHouseClient: { command, insert, query },
      enqueueAnalyticsRefresh,
      enqueueContinuation,
      markCompleted,
    });
    await processProviderDataDeletionJob(job, {
      accountErasureAllowsWork: vi.fn(async () => true),
      clickHouseClient: { command, insert, query },
      enqueueAnalyticsRefresh,
      enqueueContinuation,
      markCompleted,
    });

    expect(command).toHaveBeenCalledTimes(2);
    expect(command.mock.calls[0]?.[0]).toEqual({
      query: expect.stringContaining("INSERT INTO ingest.provider_data_generation"),
      query_params: expect.objectContaining({ generation: 2 }),
    });
    expect(query.mock.calls[2]?.[0]).toEqual({
      query: expect.stringMatching(
        /tuple\(generation, id\) IN \{batch_keys:Array\(Tuple\(UInt64, UUID\)\)\}[\s\S]*ORDER BY generation, id, source_version DESC, ingested_at DESC[\s\S]*LIMIT 1 BY generation, id/,
      ),
      query_params: expect.objectContaining({
        batch_keys: [
          expect.objectContaining({ values: [0, firstId] }),
          expect.objectContaining({ values: [1, secondId] }),
        ],
      }),
      format: "JSONEachRow",
    });
    expect(insert).toHaveBeenCalledWith({
      table: "ingest.metric_stream",
      values: [tombstoneRow(firstId, 0), tombstoneRow(secondId, 1)],
      format: "JSONEachRow",
      clickhouse_settings: { date_time_input_format: "best_effort" },
    });
    expect(query.mock.calls[0]?.[0]).toEqual({
      query: expect.stringContaining("FROM system.parts"),
      query_params: {
        covering_projection_name: "by_provider_generation",
        database_name: "ingest",
        live_projection_name: "by_provider_live_generation",
        table_name: "metric_stream",
      },
      format: "JSONEachRow",
    });
    expect(query.mock.calls[1]?.[0]).toEqual({
      query: expect.stringMatching(
        /is_deleted = 0[\s\S]*ORDER BY generation, id[\s\S]*LIMIT \{batch_size:UInt64\}[\s\S]*force_optimize_projection_name = 'by_provider_live_generation'/,
      ),
      query_params: expect.objectContaining({ batch_size: 1_000 }),
      format: "JSONEachRow",
    });
    expect(command.mock.calls[1]?.[0]).toEqual({
      query: expect.stringContaining("ingest.metric_stream_delete_acknowledgement"),
      query_params: { event_id: job.data.eventId },
    });
    expect(job.updateData).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpoint: {
          batches: 1,
          deletedRows: 2,
          examinedRows: 2,
          lastGeneration: 1,
          lastId: secondId,
        },
      }),
    );
    expect(enqueueContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpoint: {
          batches: 1,
          deletedRows: 2,
          examinedRows: 2,
          lastGeneration: 1,
          lastId: secondId,
        },
      }),
    );
    expect(job.updateProgress).toHaveBeenCalledWith({
      checkpoint: undefined,
      message: "Advancing provider generation fence...",
      percentage: 0,
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      checkpoint: {
        batches: 1,
        deletedRows: 2,
        examinedRows: 2,
        lastGeneration: 1,
        lastId: secondId,
      },
      message: "Checked 2 metric stream rows; deleted 2...",
    });
    const tombstoneProgress = job.updateProgress.mock.calls.find(
      ([progress]) => progress.message === "Checked 2 metric stream rows; deleted 2...",
    )?.[0];
    expect(tombstoneProgress).not.toHaveProperty("percentage");
    expect(job.updateProgress).toHaveBeenCalledWith({
      checkpoint: {
        batches: 1,
        deletedRows: 2,
        examinedRows: 2,
        lastGeneration: 1,
        lastId: secondId,
      },
      message: "Provider data deletion complete.",
      percentage: 100,
    });
    expect(enqueueAnalyticsRefresh).toHaveBeenCalledWith(
      job.data.userId,
      job.data.providerId,
      job.data.eventId,
    );
    expect(mockInvalidateAllUserQueries).toHaveBeenCalledWith(job.data.userId);
    expect(markCompleted).toHaveBeenCalledWith(job.data.eventId);
    expect(command.mock.invocationCallOrder[1]).toBeLessThan(
      enqueueAnalyticsRefresh.mock.invocationCallOrder[0] ?? 0,
    );
    expect(enqueueAnalyticsRefresh.mock.invocationCallOrder[0]).toBeLessThan(
      mockInvalidateAllUserQueries.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mockInvalidateAllUserQueries.mock.invocationCallOrder[0]).toBeLessThan(
      markCompleted.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("does not acknowledge or enqueue analytics when a tombstone batch fails", async () => {
    const command = vi.fn(
      async (_options: { query: string; query_params?: Record<string, unknown> }) => undefined,
    );
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        json: async () => [{ active_parts: 1, missing_projection_parts: 0 }],
      })
      .mockResolvedValueOnce({ json: async () => [{ generation: 0, id: firstId }] })
      .mockResolvedValue({ json: async () => [tombstoneRow(firstId, 0)] });
    const insert = vi.fn().mockRejectedValue(new Error("ClickHouse batch failed"));
    const enqueueAnalyticsRefresh = vi.fn(async () => undefined);
    const markCompleted = vi.fn(async () => undefined);

    await expect(
      processProviderDataDeletionJob(makeJob(), {
        accountErasureAllowsWork: vi.fn(async () => true),
        clickHouseClient: { command, insert, query },
        enqueueAnalyticsRefresh,
        enqueueContinuation: vi.fn(async () => undefined),
        markCompleted,
      }),
    ).rejects.toThrow("ClickHouse batch failed");

    expect(command).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(enqueueAnalyticsRefresh).not.toHaveBeenCalled();
    expect(markCompleted).not.toHaveBeenCalled();
  });

  it("does not checkpoint a batch when account erasure blocks its tombstone insert", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        json: async () => [{ active_parts: 1, missing_projection_parts: 0 }],
      })
      .mockResolvedValueOnce({ json: async () => [{ generation: 0, id: firstId }] })
      .mockResolvedValueOnce({ json: async () => [tombstoneRow(firstId, 0)] });
    const accountErasureAllowsWork = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const job = makeJob();
    const enqueueContinuation = vi.fn(async () => undefined);

    await processProviderDataDeletionJob(job, {
      accountErasureAllowsWork,
      clickHouseClient: {
        command: vi.fn(async () => undefined),
        insert: vi.fn(async () => undefined),
        query,
      },
      enqueueAnalyticsRefresh: vi.fn(async () => undefined),
      enqueueContinuation,
      markCompleted: vi.fn(async () => undefined),
    });

    expect(job.updateData).not.toHaveBeenCalled();
    expect(enqueueContinuation).not.toHaveBeenCalled();
  });

  it("requires an insert-capable ClickHouse client before creating tombstones", async () => {
    const command = vi.fn(async () => undefined);
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        json: async () => [{ active_parts: 1, missing_projection_parts: 0 }],
      })
      .mockResolvedValueOnce({ json: async () => [{ generation: 0, id: firstId }] });

    await expect(
      processProviderDataDeletionJob(makeJob(), {
        accountErasureAllowsWork: vi.fn(async () => true),
        clickHouseClient: { command, query },
        enqueueAnalyticsRefresh: vi.fn(async () => undefined),
        enqueueContinuation: vi.fn(async () => undefined),
        markCompleted: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow("Provider data deletion requires an insert-capable ClickHouse client");

    expect(command).toHaveBeenCalledTimes(1);
  });

  it("resumes with keyset pagination over the provider-generation projection", async () => {
    const command = vi.fn(async () => undefined);
    const query = vi.fn().mockResolvedValueOnce({ json: async () => [] });
    const insert = vi.fn(async () => undefined);
    const checkpoint = {
      batches: 4,
      deletedRows: 4_000,
      lastGeneration: 1,
      lastId: firstId,
    };

    await processProviderDataDeletionJob(makeJob({ checkpoint }), {
      accountErasureAllowsWork: vi.fn(async () => true),
      clickHouseClient: { command, insert, query },
      enqueueAnalyticsRefresh: vi.fn(async () => undefined),
      enqueueContinuation: vi.fn(async () => undefined),
      markCompleted: vi.fn(async () => undefined),
    });

    expect(query.mock.calls[0]?.[0]).toEqual({
      query: expect.stringContaining(
        "OR (generation = {last_generation:UInt64} AND id > {last_id:UUID})",
      ),
      query_params: expect.objectContaining({
        last_generation: checkpoint.lastGeneration,
        last_id: checkpoint.lastId,
      }),
      format: "JSONEachRow",
    });
  });

  it("fails before scanning when historical parts lack the provider-generation projection", async () => {
    const command = vi.fn(async () => undefined);
    const query = vi.fn().mockResolvedValue({
      json: async () => [{ active_parts: 12, missing_projection_parts: 12 }],
    });
    const enqueueAnalyticsRefresh = vi.fn(async () => undefined);
    const markCompleted = vi.fn(async () => undefined);
    const insert = vi.fn(async () => undefined);

    await expect(
      processProviderDataDeletionJob(makeJob(), {
        accountErasureAllowsWork: vi.fn(async () => true),
        clickHouseClient: { command, insert, query },
        enqueueAnalyticsRefresh,
        enqueueContinuation: vi.fn(async () => undefined),
        markCompleted,
      }),
    ).rejects.toThrow(
      "Provider data deletion requires the by_provider_generation and by_provider_live_generation projections on all active ingest.metric_stream parts; 12 of 12 parts are missing at least one",
    );

    expect(command).toHaveBeenCalledTimes(1);
    expect(enqueueAnalyticsRefresh).not.toHaveBeenCalled();
    expect(markCompleted).not.toHaveBeenCalled();
  });

  it("reports progress update failures without aborting deletion", async () => {
    const progressError = new Error("Redis progress failed");
    const warn = vi.spyOn(logger, "warn").mockReturnValue(logger);
    const command = vi.fn(async () => undefined);
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        json: async () => [{ active_parts: 1, missing_projection_parts: 0 }],
      })
      .mockResolvedValue({ json: async () => [] });
    const enqueueAnalyticsRefresh = vi.fn(async () => undefined);
    const markCompleted = vi.fn(async () => undefined);
    const job = makeJob();
    job.updateProgress.mockRejectedValue(progressError);

    await processProviderDataDeletionJob(job, {
      accountErasureAllowsWork: vi.fn(async () => true),
      clickHouseClient: { command, query },
      enqueueAnalyticsRefresh,
      enqueueContinuation: vi.fn(async () => undefined),
      markCompleted,
    });

    expect(mockCaptureException).toHaveBeenCalledWith(progressError, {
      tags: { providerDataDeletionStep: "updateProgress" },
    });
    expect(warn).toHaveBeenCalledWith(
      "[provider-data-deletion] Failed to update progress: Error: Redis progress failed",
    );
    expect(markCompleted).toHaveBeenCalledWith(job.data.eventId);
  });
});
