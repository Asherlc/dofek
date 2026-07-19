import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.ts";
import {
  type ProviderDataDeletionJob,
  processProviderDataDeletionJob,
} from "./process-provider-data-deletion-job.ts";
import type { ProviderDataDeletionJobData } from "./queues.ts";

const mockCaptureException = vi.hoisted(() => vi.fn());

vi.mock("@sentry/node", () => ({ captureException: mockCaptureException }));

const firstId = "10000000-0000-4000-8000-000000000001";
const secondId = "20000000-0000-4000-8000-000000000002";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

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
  it("advances the ClickHouse generation fence, checkpoints bounded batches, then acknowledges", async () => {
    const command = vi.fn(
      async (_options: { query: string; query_params?: Record<string, unknown> }) => undefined,
    );
    const query = vi
      .fn()
      .mockResolvedValueOnce({ json: async () => [{ id: firstId }, { id: secondId }] })
      .mockResolvedValueOnce({ json: async () => [] });
    const enqueueAnalyticsRefresh = vi.fn(async () => undefined);
    const markCompleted = vi.fn(async () => undefined);
    const job = makeJob();

    await processProviderDataDeletionJob(job, {
      clickHouseClient: { command, query },
      enqueueAnalyticsRefresh,
      markCompleted,
    });

    expect(command).toHaveBeenCalledTimes(3);
    expect(command.mock.calls[0]?.[0]).toEqual({
      query: expect.stringContaining("INSERT INTO ingest.provider_data_generation"),
      query_params: expect.objectContaining({ generation: 2 }),
    });
    expect(command.mock.calls[1]?.[0]).toEqual({
      query: expect.stringContaining("INSERT INTO ingest.metric_stream"),
      query_params: expect.objectContaining({ row_ids: [firstId, secondId] }),
    });
    expect(command.mock.calls[2]?.[0]).toEqual({
      query: expect.stringContaining("ingest.metric_stream_delete_acknowledgement"),
      query_params: { event_id: job.data.eventId },
    });
    expect(job.updateData).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpoint: { batches: 1, deletedRows: 2, lastId: secondId },
      }),
    );
    expect(job.updateProgress).toHaveBeenCalledWith({
      checkpoint: undefined,
      message: "Advancing provider generation fence...",
      percentage: 0,
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      checkpoint: { batches: 1, deletedRows: 2, lastId: secondId },
      message: "Tombstoned 2 metric stream rows...",
    });
    expect(job.updateProgress.mock.calls[1]?.[0]).not.toHaveProperty("percentage");
    expect(job.updateProgress).toHaveBeenCalledWith({
      checkpoint: { batches: 1, deletedRows: 2, lastId: secondId },
      message: "Provider data deletion complete.",
      percentage: 100,
    });
    expect(enqueueAnalyticsRefresh).toHaveBeenCalledWith(
      job.data.userId,
      job.data.providerId,
      job.data.eventId,
    );
    expect(markCompleted).toHaveBeenCalledWith(job.data.eventId);
    expect(command.mock.invocationCallOrder[2]).toBeLessThan(
      enqueueAnalyticsRefresh.mock.invocationCallOrder[0] ?? 0,
    );
    expect(enqueueAnalyticsRefresh.mock.invocationCallOrder[0]).toBeLessThan(
      markCompleted.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("does not acknowledge or enqueue analytics when a tombstone batch fails", async () => {
    const command = vi
      .fn((_options: { query: string; query_params?: Record<string, unknown> }) =>
        Promise.resolve(),
      )
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("ClickHouse batch failed"));
    const query = vi.fn().mockResolvedValue({ json: async () => [{ id: firstId }] });
    const enqueueAnalyticsRefresh = vi.fn(async () => undefined);
    const markCompleted = vi.fn(async () => undefined);

    await expect(
      processProviderDataDeletionJob(makeJob(), {
        clickHouseClient: { command, query },
        enqueueAnalyticsRefresh,
        markCompleted,
      }),
    ).rejects.toThrow("ClickHouse batch failed");

    expect(command).toHaveBeenCalledTimes(2);
    expect(enqueueAnalyticsRefresh).not.toHaveBeenCalled();
    expect(markCompleted).not.toHaveBeenCalled();
  });

  it("reports progress update failures without aborting deletion", async () => {
    const progressError = new Error("Redis progress failed");
    const warn = vi.spyOn(logger, "warn").mockReturnValue(logger);
    const command = vi.fn(async () => undefined);
    const query = vi.fn().mockResolvedValue({ json: async () => [] });
    const enqueueAnalyticsRefresh = vi.fn(async () => undefined);
    const markCompleted = vi.fn(async () => undefined);
    const job = makeJob();
    job.updateProgress.mockRejectedValue(progressError);

    await processProviderDataDeletionJob(job, {
      clickHouseClient: { command, query },
      enqueueAnalyticsRefresh,
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
