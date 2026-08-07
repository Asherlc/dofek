import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SchemaExecutionDatabase } from "../db/typed-sql.ts";

const { mockAppendProcessingStageEvent, mockCreateDatabaseFromEnv, mockExecuteWithSchema } =
  vi.hoisted(() => ({
    mockAppendProcessingStageEvent: vi.fn(
      async (_database: unknown, _event: { stage: string; idempotencyKey: string }) => undefined,
    ),
    mockCreateDatabaseFromEnv: vi.fn(),
    mockExecuteWithSchema: vi.fn(),
  }));

vi.mock("../db/index.ts", () => ({
  createDatabaseFromEnv: mockCreateDatabaseFromEnv,
}));

vi.mock("../db/typed-sql.ts", () => ({
  executeWithSchema: mockExecuteWithSchema,
}));

vi.mock("./processing-event-store.ts", () => ({
  appendProcessingStageEvent: mockAppendProcessingStageEvent,
}));

import {
  createProcessingReconciliationDatabaseFromEnv,
  type ReconcileProcessingEvidenceInput,
  reconcilePendingProcessingOperations,
  reconcileProcessingEvidence,
} from "./processing-reconciler.ts";

const operationId = "30000000-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reconcileProcessingEvidence", () => {
  it("keeps relational CDC running until the exact PeerDB marker is visible", () => {
    const input: ReconcileProcessingEvidenceInput = {
      operationId,
      outputs: [{ datasetKey: "activity", outputPath: "relational" }] as const,
      relationalMarkers: [
        {
          datasetKey: "activity",
          flowName: "dofek_fitness_raw_analytics",
          batchKey: "activity-batch-1",
          sourceWatermark: "commit-1",
        },
      ],
      metricBatches: [],
      observedRelationalMarkers: [],
      observedMetricBatches: [],
    };

    expect(reconcileProcessingEvidence(input)).toEqual([
      expect.objectContaining({
        datasetKey: "activity",
        outputPath: "relational",
        status: "running",
      }),
    ]);
    expect(
      reconcileProcessingEvidence({
        ...input,
        observedRelationalMarkers: [
          {
            operationId,
            datasetKey: "activity",
            flowName: "dofek_fitness_raw_analytics",
            batchKey: "activity-batch-1",
            sourceWatermark: "commit-1",
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        datasetKey: "activity",
        outputPath: "relational",
        status: "succeeded",
        sourceWatermark: "commit-1",
      }),
    ]);
  });

  it("keeps relational CDC running when the observed source watermark differs", () => {
    expect(
      reconcileProcessingEvidence({
        operationId,
        outputs: [{ datasetKey: "activity", outputPath: "relational" }],
        relationalMarkers: [
          {
            datasetKey: "activity",
            flowName: "dofek_fitness_raw_analytics",
            batchKey: "activity-batch-1",
            sourceWatermark: "commit-expected",
          },
        ],
        metricBatches: [],
        observedRelationalMarkers: [
          {
            operationId,
            datasetKey: "activity",
            flowName: "dofek_fitness_raw_analytics",
            batchKey: "activity-batch-1",
            sourceWatermark: "commit-stale",
          },
        ],
        observedMetricBatches: [],
      })[0]?.status,
    ).toBe("running");
  });

  it("requires every metric batch and ignores unrelated acknowledgements", () => {
    const baseInput: ReconcileProcessingEvidenceInput = {
      operationId,
      outputs: [{ datasetKey: "recovery", outputPath: "metric_stream" }] as const,
      relationalMarkers: [],
      metricBatches: [
        { batchId: "metric-1", datasetKeys: ["recovery"], expectedEventCount: 10 },
        { batchId: "metric-2", datasetKeys: ["recovery"], expectedEventCount: 20 },
      ],
      observedRelationalMarkers: [],
      observedMetricBatches: [
        { operationId, batchId: "metric-1", expectedEventCount: 10 },
        {
          operationId: "30000000-0000-4000-8000-000000000099",
          batchId: "metric-2",
          expectedEventCount: 20,
        },
      ],
    };

    expect(reconcileProcessingEvidence(baseInput)[0]?.status).toBe("running");
    expect(
      reconcileProcessingEvidence({
        ...baseInput,
        observedMetricBatches: [
          { operationId, batchId: "metric-1", expectedEventCount: 10 },
          { operationId, batchId: "metric-2", expectedEventCount: 20 },
        ],
      })[0],
    ).toMatchObject({
      datasetKey: "recovery",
      outputPath: "metric_stream",
      status: "succeeded",
      sourceWatermark: "metric-2",
    });
  });

  it("does not fabricate dependencies between independent output paths", () => {
    expect(
      reconcileProcessingEvidence({
        operationId,
        outputs: [{ datasetKey: "recovery", outputPath: "metric_stream" }],
        relationalMarkers: [],
        metricBatches: [{ batchId: "metric-1", datasetKeys: ["recovery"], expectedEventCount: 10 }],
        observedRelationalMarkers: [],
        observedMetricBatches: [{ operationId, batchId: "metric-1", expectedEventCount: 10 }],
      }),
    ).toEqual([
      expect.objectContaining({
        datasetKey: "recovery",
        outputPath: "metric_stream",
        status: "succeeded",
      }),
    ]);
  });

  it("rejects a metric acknowledgement with a mismatched event count", () => {
    expect(
      reconcileProcessingEvidence({
        operationId,
        outputs: [{ datasetKey: "recovery", outputPath: "metric_stream" }],
        relationalMarkers: [],
        metricBatches: [{ batchId: "metric-1", datasetKeys: ["recovery"], expectedEventCount: 10 }],
        observedRelationalMarkers: [],
        observedMetricBatches: [{ operationId, batchId: "metric-1", expectedEventCount: 9 }],
      })[0]?.status,
    ).toBe("running");
  });

  it("completes output paths whose contract requires no CDC transport", () => {
    expect(
      reconcileProcessingEvidence({
        operationId,
        outputs: [{ datasetKey: "nutrition", outputPath: "relational" }],
        relationalMarkers: [],
        metricBatches: [],
        observedRelationalMarkers: [],
        observedMetricBatches: [],
      }),
    ).toEqual([
      expect.objectContaining({
        datasetKey: "nutrition",
        outputPath: "relational",
        status: "succeeded",
      }),
    ]);
  });

  it("rejects an output path absent from the dataset contract", () => {
    expect(() =>
      reconcileProcessingEvidence({
        operationId,
        outputs: [{ datasetKey: "body", outputPath: "relational" }],
        relationalMarkers: [],
        metricBatches: [],
        observedRelationalMarkers: [],
        observedMetricBatches: [],
      }),
    ).toThrow("Dataset body does not define output path relational");
  });
});

describe("reconcilePendingProcessingOperations", () => {
  function database(): SchemaExecutionDatabase {
    return { execute: vi.fn(async () => []) };
  }

  function clickHouseQueryWithEvidence(includeEvidence: boolean) {
    return vi
      .fn()
      .mockResolvedValueOnce({
        json: async () =>
          includeEvidence
            ? [
                {
                  operation_id: operationId,
                  dataset_key: "activity",
                  flow_name: "dofek_fitness_raw_analytics",
                  batch_key: "activity-batch-1",
                  source_watermark: "commit-1",
                },
              ]
            : [],
      })
      .mockResolvedValueOnce({
        json: async () =>
          includeEvidence
            ? [
                {
                  operation_id: operationId,
                  batch_id: "metric-batch-1",
                  expected_event_count: 12,
                },
              ]
            : [],
      });
  }

  function arrangeStoredExpectations() {
    mockExecuteWithSchema
      .mockResolvedValueOnce([{ operation_id: operationId }])
      .mockResolvedValueOnce([
        { dataset_key: "activity", output_path: "metric_stream" },
        { dataset_key: "activity", output_path: "relational" },
      ])
      .mockResolvedValueOnce([
        {
          dataset_key: "activity",
          flow_name: "dofek_fitness_raw_analytics",
          batch_key: "activity-batch-1",
          source_watermark: "commit-1",
        },
      ])
      .mockResolvedValueOnce([
        {
          batch_id: "metric-batch-1",
          dataset_keys: ["activity"],
          expected_event_count: 12,
        },
      ]);
  }

  it("loads exact Postgres and ClickHouse evidence, advances analytics, and completes the outbox", async () => {
    arrangeStoredExpectations();
    const reconciliationDatabase = database();
    const query = clickHouseQueryWithEvidence(true);

    await expect(
      reconcilePendingProcessingOperations({
        database: reconciliationDatabase,
        clickHouseClient: { query },
        limit: 25,
      }),
    ).resolves.toEqual({ checked: 1, completed: 1, waiting: 0 });

    expect(query).toHaveBeenNthCalledWith(1, {
      query: expect.stringContaining("postgres_fitness.processing_flow_marker"),
      query_params: { operation_id: operationId },
      format: "JSONEachRow",
    });
    expect(query).toHaveBeenNthCalledWith(2, {
      query: expect.stringContaining("ingest.metric_stream_processing_acknowledgement"),
      query_params: { operation_id: operationId },
      format: "JSONEachRow",
    });
    expect(mockAppendProcessingStageEvent.mock.calls).toEqual([
      [
        reconciliationDatabase,
        {
          operationId,
          stage: "cdc",
          status: "succeeded",
          datasetKey: "activity",
          outputPath: "metric_stream",
          sourceWatermark: "metric-batch-1",
          servingWatermark: "metric-batch-1",
          message: "Stored data is available for analysis",
          idempotencyKey: `cdc:${operationId}:activity:metric_stream:succeeded:metric-batch-1`,
        },
      ],
      [
        reconciliationDatabase,
        {
          operationId,
          stage: "cdc",
          status: "succeeded",
          datasetKey: "activity",
          outputPath: "relational",
          sourceWatermark: "commit-1",
          servingWatermark: "commit-1",
          message: "Stored data is available for analysis",
          idempotencyKey: `cdc:${operationId}:activity:relational:succeeded:commit-1`,
        },
      ],
      [
        reconciliationDatabase,
        {
          operationId,
          stage: "analytics",
          status: "queued",
          datasetKey: "activity",
          servingWatermark: "metric-batch-1:commit-1",
          message: "Waiting for analytics calculations",
          idempotencyKey: "analytics:activity:metric-batch-1:commit-1",
        },
      ],
    ]);
    expect(reconciliationDatabase.execute).toHaveBeenCalledOnce();
  });

  it("queues distinct analytics events when datasets share a serving watermark", async () => {
    mockExecuteWithSchema
      .mockResolvedValueOnce([{ operation_id: operationId }])
      .mockResolvedValueOnce([
        { dataset_key: "activity", output_path: "relational" },
        { dataset_key: "hiking", output_path: "relational" },
      ])
      .mockResolvedValueOnce([
        {
          dataset_key: "activity",
          flow_name: "dofek_fitness_raw_analytics",
          batch_key: "activity-batch-1",
          source_watermark: "commit-1",
        },
        {
          dataset_key: "hiking",
          flow_name: "dofek_fitness_raw_analytics",
          batch_key: "hiking-batch-1",
          source_watermark: "commit-1",
        },
      ])
      .mockResolvedValueOnce([]);
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        json: async () => [
          {
            operation_id: operationId,
            dataset_key: "activity",
            flow_name: "dofek_fitness_raw_analytics",
            batch_key: "activity-batch-1",
            source_watermark: "commit-1",
          },
          {
            operation_id: operationId,
            dataset_key: "hiking",
            flow_name: "dofek_fitness_raw_analytics",
            batch_key: "hiking-batch-1",
            source_watermark: "commit-1",
          },
        ],
      })
      .mockResolvedValueOnce({ json: async () => [] });

    await reconcilePendingProcessingOperations({
      database: database(),
      clickHouseClient: { query },
    });

    expect(
      mockAppendProcessingStageEvent.mock.calls
        .map(([, event]) => event)
        .filter((event) => event.stage === "analytics")
        .map((event) => event.idempotencyKey),
    ).toEqual(["analytics:activity:commit-1", "analytics:hiking:commit-1"]);
  });

  it("persists running evidence without advancing analytics or completing the outbox", async () => {
    arrangeStoredExpectations();
    const reconciliationDatabase = database();

    await expect(
      reconcilePendingProcessingOperations({
        database: reconciliationDatabase,
        clickHouseClient: { query: clickHouseQueryWithEvidence(false) },
      }),
    ).resolves.toEqual({ checked: 1, completed: 0, waiting: 1 });

    expect(mockAppendProcessingStageEvent).toHaveBeenCalledTimes(2);
    expect(mockAppendProcessingStageEvent).toHaveBeenNthCalledWith(
      1,
      reconciliationDatabase,
      expect.objectContaining({
        stage: "cdc",
        status: "running",
        message: "Waiting for stored data to become available for analysis",
      }),
    );
    expect(reconciliationDatabase.execute).not.toHaveBeenCalled();
  });

  it.each([0, 1_001, 1.5])("rejects an invalid reconciliation limit of %s", async (limit) => {
    await expect(
      reconcilePendingProcessingOperations({
        database: database(),
        clickHouseClient: { query: vi.fn() },
        limit,
      }),
    ).rejects.toThrow();
    expect(mockExecuteWithSchema).not.toHaveBeenCalled();
  });
});

describe("createProcessingReconciliationDatabaseFromEnv", () => {
  it("returns the environment database", () => {
    const reconciliationDatabase: SchemaExecutionDatabase = { execute: vi.fn(async () => []) };
    mockCreateDatabaseFromEnv.mockReturnValue(reconciliationDatabase);

    expect(createProcessingReconciliationDatabaseFromEnv()).toBe(reconciliationDatabase);
  });
});
