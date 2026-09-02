import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SchemaExecutionDatabase } from "../db/typed-sql.ts";
import {
  buildProcessingAnalyticsEvents,
  recordAnalyticsRunForPendingProcessing,
} from "./analytics-processing.ts";

const processingEventStoreMocks = vi.hoisted(() => ({
  appendProcessingStageEvent: vi.fn(),
  listProcessingDatasetsAwaitingAnalytics: vi.fn(),
}));

vi.mock("./processing-event-store.ts", () => processingEventStoreMocks);

const operationId = "30000000-0000-4000-8000-000000000001";

const succeededProviderModels = [
  {
    name: "provider_metric_stream_daily",
    status: "succeeded" as const,
    errorCode: null,
    message: null,
  },
  {
    name: "provider_change_watermark",
    status: "succeeded" as const,
    errorCode: null,
    message: null,
  },
  {
    name: "provider_stats",
    status: "succeeded" as const,
    errorCode: null,
    message: null,
  },
];

describe("buildProcessingAnalyticsEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records the model result before the dataset aggregate", () => {
    expect(
      buildProcessingAnalyticsEvents({
        runId: "dbt-run-1",
        pendingDatasets: [{ operationId, datasetKey: "providers" }],
        modelResults: succeededProviderModels,
      }),
    ).toEqual([
      {
        operationId,
        datasetKey: "providers",
        modelName: "provider_metric_stream_daily",
        status: "succeeded",
        errorCode: null,
        errorMessage: null,
        message: "Analytics calculation completed",
        servingWatermark: "dbt-run-1",
        idempotencyKey: `dbt-run-1:${operationId}:providers:provider_metric_stream_daily:succeeded`,
      },
      {
        operationId,
        datasetKey: "providers",
        modelName: "provider_change_watermark",
        status: "succeeded",
        errorCode: null,
        errorMessage: null,
        message: "Analytics calculation completed",
        servingWatermark: "dbt-run-1",
        idempotencyKey: `dbt-run-1:${operationId}:providers:provider_change_watermark:succeeded`,
      },
      {
        operationId,
        datasetKey: "providers",
        modelName: "provider_stats",
        status: "succeeded",
        errorCode: null,
        errorMessage: null,
        message: "Analytics calculation completed",
        servingWatermark: "dbt-run-1",
        idempotencyKey: `dbt-run-1:${operationId}:providers:provider_stats:succeeded`,
      },
      {
        operationId,
        datasetKey: "providers",
        modelName: null,
        status: "succeeded",
        errorCode: null,
        errorMessage: null,
        message: "Analytics calculations completed",
        servingWatermark: "dbt-run-1",
        idempotencyKey: `dbt-run-1:${operationId}:providers:aggregate:succeeded`,
      },
    ]);
  });

  it("preserves skipped model results as incomplete analytics", () => {
    expect(
      buildProcessingAnalyticsEvents({
        runId: "dbt-run-1",
        pendingDatasets: [{ operationId, datasetKey: "providers" }],
        modelResults: [
          {
            name: "provider_metric_stream_daily",
            status: "succeeded",
            errorCode: null,
            message: null,
          },
          {
            name: "provider_change_watermark",
            status: "succeeded",
            errorCode: null,
            message: null,
          },
          {
            name: "provider_stats",
            status: "skipped",
            errorCode: "upstream_skipped",
            message: "upstream model did not run",
          },
        ],
      }),
    ).toEqual([
      {
        operationId,
        datasetKey: "providers",
        modelName: "provider_metric_stream_daily",
        status: "succeeded",
        errorCode: null,
        errorMessage: null,
        message: "Analytics calculation completed",
        servingWatermark: "dbt-run-1",
        idempotencyKey: `dbt-run-1:${operationId}:providers:provider_metric_stream_daily:succeeded`,
      },
      {
        operationId,
        datasetKey: "providers",
        modelName: "provider_change_watermark",
        status: "succeeded",
        errorCode: null,
        errorMessage: null,
        message: "Analytics calculation completed",
        servingWatermark: "dbt-run-1",
        idempotencyKey: `dbt-run-1:${operationId}:providers:provider_change_watermark:succeeded`,
      },
      {
        operationId,
        datasetKey: "providers",
        modelName: "provider_stats",
        status: "skipped",
        errorCode: "upstream_skipped",
        errorMessage: "upstream model did not run",
        message: "Analytics calculation did not complete",
        servingWatermark: "dbt-run-1",
        idempotencyKey: `dbt-run-1:${operationId}:providers:provider_stats:skipped`,
      },
      {
        operationId,
        datasetKey: "providers",
        modelName: null,
        status: "failed",
        errorCode: "upstream_skipped",
        errorMessage: "Some analytics calculations could not be completed. Try the update again.",
        message: "Some analytics calculations did not complete",
        servingWatermark: "dbt-run-1",
        idempotencyKey: `dbt-run-1:${operationId}:providers:aggregate:failed`,
      },
    ]);
  });

  it("fails the dataset when a required selected model has no result", () => {
    expect(
      buildProcessingAnalyticsEvents({
        runId: "dbt-run-1",
        pendingDatasets: [{ operationId, datasetKey: "providers" }],
        modelResults: [],
      }).at(-1),
    ).toMatchObject({
      status: "failed",
      errorCode: "required_model_unattempted",
    });
  });

  it("keeps event keys distinct when operations share a dataset", () => {
    const secondOperationId = "30000000-0000-4000-8000-000000000002";
    const events = buildProcessingAnalyticsEvents({
      runId: "dbt-run-shared",
      pendingDatasets: [
        { operationId, datasetKey: "providers" },
        { operationId: secondOperationId, datasetKey: "providers" },
      ],
      modelResults: succeededProviderModels,
    });

    expect(new Set(events.map((event) => event.idempotencyKey))).toHaveLength(events.length);
    expect(events.map((event) => event.idempotencyKey)).toEqual([
      `dbt-run-shared:${operationId}:providers:provider_metric_stream_daily:succeeded`,
      `dbt-run-shared:${operationId}:providers:provider_change_watermark:succeeded`,
      `dbt-run-shared:${operationId}:providers:provider_stats:succeeded`,
      `dbt-run-shared:${operationId}:providers:aggregate:succeeded`,
      `dbt-run-shared:${secondOperationId}:providers:provider_metric_stream_daily:succeeded`,
      `dbt-run-shared:${secondOperationId}:providers:provider_change_watermark:succeeded`,
      `dbt-run-shared:${secondOperationId}:providers:provider_stats:succeeded`,
      `dbt-run-shared:${secondOperationId}:providers:aggregate:succeeded`,
    ]);
  });

  it("skips analytics for a dataset with no analytics models", () => {
    expect(
      buildProcessingAnalyticsEvents({
        runId: "dbt-run-1",
        pendingDatasets: [{ operationId, datasetKey: "nutrition" }],
        modelResults: [],
      }),
    ).toEqual([
      expect.objectContaining({
        datasetKey: "nutrition",
        modelName: null,
        status: "skipped",
      }),
    ]);
  });

  it("rejects a pending dataset without a contract", () => {
    const pendingDatasetWithoutContract = {
      operationId,
      datasetKey: "providers",
    } as const;
    Reflect.set(pendingDatasetWithoutContract, "datasetKey", "missing");

    expect(() =>
      buildProcessingAnalyticsEvents({
        runId: "dbt-run-1",
        pendingDatasets: [pendingDatasetWithoutContract],
        modelResults: [],
      }),
    ).toThrow("Missing processing dataset contract for missing");
  });
});

describe("recordAnalyticsRunForPendingProcessing", () => {
  const database: SchemaExecutionDatabase = {
    execute: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records model and aggregate outcomes and queues cache refresh only after success", async () => {
    processingEventStoreMocks.listProcessingDatasetsAwaitingAnalytics.mockResolvedValue([
      { operationId, datasetKey: "providers" },
    ]);

    await expect(
      recordAnalyticsRunForPendingProcessing(database, {
        runId: "dbt-run-1",
        modelResults: succeededProviderModels,
      }),
    ).resolves.toEqual({ datasets: 1, failed: 0 });
    expect(processingEventStoreMocks.appendProcessingStageEvent).toHaveBeenCalledTimes(5);
    expect(processingEventStoreMocks.appendProcessingStageEvent).toHaveBeenNthCalledWith(
      1,
      database,
      {
        operationId,
        stage: "analytics",
        status: "succeeded",
        datasetKey: "providers",
        modelName: "provider_metric_stream_daily",
        servingWatermark: "dbt-run-1",
        message: "Analytics calculation completed",
        errorCode: null,
        errorMessage: null,
        idempotencyKey: `dbt-run-1:${operationId}:providers:provider_metric_stream_daily:succeeded`,
      },
    );
    expect(processingEventStoreMocks.appendProcessingStageEvent).toHaveBeenNthCalledWith(
      5,
      database,
      {
        operationId,
        stage: "cache_refresh",
        status: "queued",
        datasetKey: "providers",
        servingWatermark: "dbt-run-1",
        message: "Waiting for cached views to refresh",
        idempotencyKey: `cache:dbt-run-1:${operationId}:providers:aggregate:succeeded`,
      },
    );
  });

  it("reports failed aggregates without queueing cache refresh", async () => {
    processingEventStoreMocks.listProcessingDatasetsAwaitingAnalytics.mockResolvedValue([
      { operationId, datasetKey: "providers" },
    ]);

    await expect(
      recordAnalyticsRunForPendingProcessing(database, {
        runId: "dbt-run-2",
        modelResults: [],
      }),
    ).resolves.toEqual({ datasets: 1, failed: 1 });
    expect(processingEventStoreMocks.appendProcessingStageEvent).toHaveBeenCalledTimes(4);
    expect(processingEventStoreMocks.appendProcessingStageEvent).not.toHaveBeenCalledWith(
      database,
      expect.objectContaining({ stage: "cache_refresh" }),
    );
  });

  it("queues cache refresh after an analytics-free dataset is skipped", async () => {
    processingEventStoreMocks.listProcessingDatasetsAwaitingAnalytics.mockResolvedValue([
      { operationId, datasetKey: "nutrition" },
    ]);

    await expect(
      recordAnalyticsRunForPendingProcessing(database, {
        runId: "dbt-run-3",
        modelResults: [],
      }),
    ).resolves.toEqual({ datasets: 1, failed: 0 });
    expect(processingEventStoreMocks.appendProcessingStageEvent).toHaveBeenNthCalledWith(
      2,
      database,
      {
        operationId,
        stage: "cache_refresh",
        status: "queued",
        datasetKey: "nutrition",
        servingWatermark: "dbt-run-3",
        message: "Waiting for cached views to refresh",
        idempotencyKey: `cache:dbt-run-3:${operationId}:nutrition:skipped`,
      },
    );
  });
});
