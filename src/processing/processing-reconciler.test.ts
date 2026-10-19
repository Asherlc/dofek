import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SchemaExecutionDatabase } from "../db/typed-sql.ts";
import type { StoredProcessingStageEvent } from "./processing-event-store.ts";

const {
  mockAppendProcessingStageEvent,
  mockCreateDatabaseFromEnv,
  mockExecuteWithSchema,
  mockGetLatestProcessingEvents,
} = vi.hoisted(() => ({
  mockAppendProcessingStageEvent: vi.fn(
    async (_database: unknown, _event: { stage: string; idempotencyKey: string }) => undefined,
  ),
  mockCreateDatabaseFromEnv: vi.fn(),
  mockExecuteWithSchema: vi.fn(),
  mockGetLatestProcessingEvents: vi.fn(),
}));

vi.mock("../db/index.ts", () => ({
  createDatabaseFromEnv: mockCreateDatabaseFromEnv,
}));

vi.mock("../db/typed-sql.ts", () => ({
  executeWithSchema: mockExecuteWithSchema,
}));

vi.mock("./processing-event-store.ts", () => ({
  appendProcessingStageEvent: mockAppendProcessingStageEvent,
  getLatestProcessingEvents: mockGetLatestProcessingEvents,
}));

import {
  createProcessingReconciliationDatabaseFromEnv,
  type ReconcileProcessingEvidenceInput,
  reconcilePendingProcessingOperations,
  reconcileProcessingEvidence,
  STALE_OPERATION_THRESHOLD_MS,
} from "./processing-reconciler.ts";

const operationId = "30000000-0000-4000-8000-000000000001";
const recentOperationCreatedAt = new Date();
const staleOperationCreatedAt = new Date(Date.now() - STALE_OPERATION_THRESHOLD_MS - 60_000);

function storedStageEvent(
  overrides: Partial<StoredProcessingStageEvent> = {},
): StoredProcessingStageEvent {
  return {
    id: "30000000-0000-4000-8000-000000000002",
    operationId,
    sequence: 1,
    stage: "ingest",
    status: "succeeded",
    datasetKey: null,
    outputPath: null,
    modelName: null,
    occurredAt: recentOperationCreatedAt,
    progressPercentage: 100,
    sourceWatermark: null,
    servingWatermark: null,
    message: null,
    errorCode: null,
    errorMessage: null,
    metadataSchemaVersion: 1,
    metadata: null,
    idempotencyKey: "ingest-succeeded",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetLatestProcessingEvents.mockReset().mockResolvedValue([storedStageEvent()]);
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
  const requestAnalyticsRefresh = vi.fn().mockResolvedValue(undefined);
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
      .mockResolvedValueOnce([
        { operation_id: operationId, operation_created_at: recentOperationCreatedAt },
      ])
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

  it.each([null, "queued", "running"] as const)(
    "retains reconciliation work while ingestion is %s despite complete CDC evidence",
    async (status) => {
      arrangeStoredExpectations();
      mockGetLatestProcessingEvents.mockResolvedValue(status ? [storedStageEvent({ status })] : []);
      const reconciliationDatabase = database();
      await expect(
        reconcilePendingProcessingOperations({
          requestAnalyticsRefresh,
          database: reconciliationDatabase,
          clickHouseClient: { query: clickHouseQueryWithEvidence(true) },
        }),
      ).resolves.toEqual({ checked: 1, completed: 0, abandoned: 0, waiting: 1 });
      expect(requestAnalyticsRefresh).not.toHaveBeenCalled();
      expect(reconciliationDatabase.execute).not.toHaveBeenCalled();
    },
  );

  it.each(["succeeded", "failed", "cancelled", "skipped"] as const)(
    "does not request another build for a dataset whose analytics already %s",
    async (status) => {
      arrangeStoredExpectations();
      mockGetLatestProcessingEvents.mockResolvedValue([
        storedStageEvent(),
        storedStageEvent({ sequence: 2, stage: "analytics", datasetKey: "activity", status }),
      ]);
      const reconciliationDatabase = database();
      await expect(
        reconcilePendingProcessingOperations({
          requestAnalyticsRefresh,
          database: reconciliationDatabase,
          clickHouseClient: { query: clickHouseQueryWithEvidence(true) },
        }),
      ).resolves.toEqual({ checked: 1, completed: 1, abandoned: 0, waiting: 0 });
      expect(requestAnalyticsRefresh).not.toHaveBeenCalled();
      expect(reconciliationDatabase.execute).toHaveBeenCalledOnce();
    },
  );

  it("retains work when ingestion finishes while replication evidence is being loaded", async () => {
    arrangeStoredExpectations();
    let ingestionFinished = false;
    mockGetLatestProcessingEvents.mockImplementation(async () => [
      storedStageEvent({ status: ingestionFinished ? "succeeded" : "running" }),
    ]);
    const evidenceQuery = clickHouseQueryWithEvidence(true);
    const reconciliationDatabase = database();
    await expect(
      reconcilePendingProcessingOperations({
        requestAnalyticsRefresh,
        database: reconciliationDatabase,
        clickHouseClient: {
          query: async () => {
            ingestionFinished = true;
            return evidenceQuery();
          },
        },
      }),
    ).resolves.toEqual({ checked: 1, completed: 0, abandoned: 0, waiting: 1 });
    expect(requestAnalyticsRefresh).not.toHaveBeenCalled();
    expect(reconciliationDatabase.execute).not.toHaveBeenCalled();
  });

  it("loads exact Postgres and ClickHouse evidence, advances analytics, and completes the outbox", async () => {
    arrangeStoredExpectations();
    const reconciliationDatabase = database();
    const query = clickHouseQueryWithEvidence(true);
    const requestAnalyticsRefresh = vi.fn().mockResolvedValue(undefined);

    await expect(
      reconcilePendingProcessingOperations({
        requestAnalyticsRefresh,
        database: reconciliationDatabase,
        clickHouseClient: { query },
        limit: 25,
      }),
    ).resolves.toEqual({ checked: 1, completed: 1, abandoned: 0, waiting: 0 });

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
    expect(requestAnalyticsRefresh).toHaveBeenCalledOnce();
    expect(requestAnalyticsRefresh.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(reconciliationDatabase.execute).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("queues distinct analytics events when datasets share a serving watermark", async () => {
    mockExecuteWithSchema
      .mockResolvedValueOnce([
        { operation_id: operationId, operation_created_at: recentOperationCreatedAt },
      ])
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
      requestAnalyticsRefresh,
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
        requestAnalyticsRefresh,
        database: reconciliationDatabase,
        clickHouseClient: { query: clickHouseQueryWithEvidence(false) },
      }),
    ).resolves.toEqual({ checked: 1, completed: 0, abandoned: 0, waiting: 1 });

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
    expect(requestAnalyticsRefresh).not.toHaveBeenCalled();
  });

  it("leaves reconciliation pending when the analytics queue rejects dispatch", async () => {
    arrangeStoredExpectations();
    const reconciliationDatabase = database();
    const failure = new Error("Redis dispatch unavailable");
    await expect(
      reconcilePendingProcessingOperations({
        database: reconciliationDatabase,
        clickHouseClient: { query: clickHouseQueryWithEvidence(true) },
        requestAnalyticsRefresh: vi.fn().mockRejectedValue(failure),
      }),
    ).rejects.toBe(failure);
    expect(reconciliationDatabase.execute).not.toHaveBeenCalled();
  });

  it("abandons an operation that has not reconciled within the staleness threshold", async () => {
    mockExecuteWithSchema
      .mockResolvedValueOnce([
        { operation_id: operationId, operation_created_at: staleOperationCreatedAt },
      ])
      .mockResolvedValueOnce([{ dataset_key: "activity", output_path: "metric_stream" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          batch_id: "metric-batch-1",
          dataset_keys: ["activity"],
          expected_event_count: 12,
        },
      ]);
    const reconciliationDatabase = database();
    const query = clickHouseQueryWithEvidence(false);

    await expect(
      reconcilePendingProcessingOperations({
        requestAnalyticsRefresh,
        database: reconciliationDatabase,
        clickHouseClient: { query },
      }),
    ).resolves.toEqual({ checked: 1, completed: 0, abandoned: 1, waiting: 0 });

    expect(mockAppendProcessingStageEvent).toHaveBeenCalledExactlyOnceWith(
      reconciliationDatabase,
      expect.objectContaining({
        operationId,
        stage: "cdc",
        status: "failed",
        datasetKey: "activity",
        outputPath: "metric_stream",
        errorCode: "processing_stalled",
        idempotencyKey: "stalled:activity:metric_stream",
      }),
    );
    expect(reconciliationDatabase.execute).toHaveBeenCalledOnce();
  });

  it.each([0, 1_001, 1.5])("rejects an invalid reconciliation limit of %s", async (limit) => {
    await expect(
      reconcilePendingProcessingOperations({
        requestAnalyticsRefresh,
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
