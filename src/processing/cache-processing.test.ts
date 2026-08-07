import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SchemaExecutionDatabase } from "../db/typed-sql.ts";
import {
  buildProcessingCacheEvents,
  recordCacheRunForPendingProcessing,
} from "./cache-processing.ts";

const processingEventStoreMocks = vi.hoisted(() => ({
  appendProcessingStageEvent: vi.fn(),
  listProcessingDatasetsAwaitingCacheRefresh: vi.fn(),
}));

vi.mock("./processing-event-store.ts", () => processingEventStoreMocks);

const operationId = "30000000-0000-4000-8000-000000000001";
const target = { operationId, datasetKey: "activity" as const, userId: "user-1" };

describe("buildProcessingCacheEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses only registered query families belonging to the target dataset and user", () => {
    expect(
      buildProcessingCacheEvents({
        runId: "cache-run-1",
        targets: [target],
        outcomes: [
          {
            userId: "user-1",
            path: "activity.list",
            status: "succeeded",
            errorMessage: null,
          },
          {
            userId: "user-2",
            path: "activity.list",
            status: "failed",
            errorMessage: "other user failed",
          },
        ],
      }),
    ).toEqual([
      {
        operationId,
        datasetKey: "activity",
        status: "succeeded",
        errorMessage: null,
        message: "Cached views refreshed",
        servingWatermark: "cache-run-1",
        idempotencyKey: "cache-run-1:activity:succeeded",
      },
    ]);
  });

  it("matches exact query families without matching similarly prefixed paths", () => {
    expect(
      buildProcessingCacheEvents({
        runId: "cache-run-1",
        targets: [target],
        outcomes: [
          {
            userId: "user-1",
            path: "activity",
            status: "succeeded",
            errorMessage: null,
          },
          {
            userId: "user-1",
            path: "activityExtra",
            status: "failed",
            errorMessage: "unrelated path failed",
          },
        ],
      })[0]?.status,
    ).toBe("succeeded");
  });

  it("fails the dataset when one of its registered query families fails", () => {
    expect(
      buildProcessingCacheEvents({
        runId: "cache-run-1",
        targets: [target],
        outcomes: [
          {
            userId: "user-1",
            path: "dashboard.overview",
            status: "failed",
            errorMessage: "query failed",
          },
        ],
      })[0],
    ).toEqual({
      operationId,
      datasetKey: "activity",
      status: "failed",
      errorMessage: "Some screens could not be refreshed. Refresh the app and try again.",
      message: "A cached view could not be refreshed",
      servingWatermark: "cache-run-1",
      idempotencyKey: "cache-run-1:activity:failed",
    });
  });

  it("skips a dataset with no registered cache entries", () => {
    expect(
      buildProcessingCacheEvents({
        runId: "cache-run-1",
        targets: [target],
        outcomes: [],
      })[0],
    ).toEqual({
      operationId,
      datasetKey: "activity",
      status: "skipped",
      errorMessage: null,
      message: "No cached views required a refresh",
      servingWatermark: "cache-run-1",
      idempotencyKey: "cache-run-1:activity:skipped",
    });
  });

  it("rejects a target without a dataset contract", () => {
    const targetWithoutContract = { ...target };
    Reflect.set(targetWithoutContract, "datasetKey", "missing");

    expect(() =>
      buildProcessingCacheEvents({
        runId: "cache-run-1",
        targets: [targetWithoutContract],
        outcomes: [],
      }),
    ).toThrow("Missing processing dataset contract for missing");
  });
});

describe("recordCacheRunForPendingProcessing", () => {
  const database: SchemaExecutionDatabase = {
    execute: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records each pending dataset outcome and reports failed totals", async () => {
    processingEventStoreMocks.listProcessingDatasetsAwaitingCacheRefresh.mockResolvedValue([
      target,
      {
        operationId: "30000000-0000-4000-8000-000000000002",
        datasetKey: "nutrition",
        userId: "user-1",
      },
      {
        operationId: "30000000-0000-4000-8000-000000000003",
        datasetKey: "body",
        userId: "user-1",
      },
    ]);

    await expect(
      recordCacheRunForPendingProcessing(database, {
        runId: "cache-run-1",
        outcomes: [
          {
            userId: "user-1",
            path: "activity.list",
            status: "failed",
            errorMessage: "query failed",
          },
          {
            userId: "user-1",
            path: "body.overview",
            status: "succeeded",
            errorMessage: null,
          },
        ],
      }),
    ).resolves.toEqual({ datasets: 3, failed: 1 });
    expect(processingEventStoreMocks.appendProcessingStageEvent).toHaveBeenNthCalledWith(
      1,
      database,
      {
        operationId,
        stage: "cache_refresh",
        status: "failed",
        datasetKey: "activity",
        servingWatermark: "cache-run-1",
        message: "A cached view could not be refreshed",
        errorCode: "cache_refresh_failed",
        errorMessage: "Some screens could not be refreshed. Refresh the app and try again.",
        idempotencyKey: "cache-run-1:activity:failed",
      },
    );
    expect(processingEventStoreMocks.appendProcessingStageEvent).toHaveBeenNthCalledWith(
      2,
      database,
      {
        operationId: "30000000-0000-4000-8000-000000000002",
        stage: "cache_refresh",
        status: "skipped",
        datasetKey: "nutrition",
        servingWatermark: "cache-run-1",
        message: "No cached views required a refresh",
        errorCode: null,
        errorMessage: null,
        idempotencyKey: "cache-run-1:nutrition:skipped",
      },
    );
    expect(processingEventStoreMocks.appendProcessingStageEvent).toHaveBeenNthCalledWith(
      3,
      database,
      expect.objectContaining({
        operationId: "30000000-0000-4000-8000-000000000003",
        status: "succeeded",
        datasetKey: "body",
      }),
    );
  });
});
