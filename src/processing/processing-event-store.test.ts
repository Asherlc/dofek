import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../db/index.ts";
import {
  appendProcessingStageEvent,
  createProcessingOperation,
  getLatestProcessingEvents,
  getProcessingOutputManifest,
  listProcessingDatasetsAwaitingAnalytics,
  listProcessingDatasetsAwaitingCacheRefresh,
  listProcessingHistory,
  listScopedProcessingOperations,
  recordCanonicalCommit,
  recordMetricStreamBatchPublished,
  recordProcessingOutput,
  recordRelationalCanonicalCommits,
} from "./processing-event-store.ts";

const operationId = "10000000-0000-4000-8000-000000000001";
const userId = "10000000-0000-4000-8000-000000000002";
const occurredAt = new Date("2026-07-22T18:00:00.000Z");
const dialect = new PgDialect();

function operationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: operationId,
    user_id: userId,
    provider_id: "garmin",
    kind: "provider_sync",
    external_correlation_key: "sync-1",
    dataset_keys: ["activity"],
    created_at: occurredAt,
    ...overrides,
  };
}

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "20000000-0000-4000-8000-000000000001",
    sequence: 1,
    operation_id: operationId,
    stage: "ingest",
    status: "succeeded",
    dataset_key: "activity",
    output_path: null,
    model_name: null,
    occurred_at: occurredAt,
    progress_percentage: 100,
    source_watermark: null,
    serving_watermark: null,
    message: "Ingested",
    error_code: null,
    error_message: null,
    metadata_schema_version: 1,
    metadata: { records: 3 },
    idempotency_key: "event-1",
    ...overrides,
  };
}

function expectedOperation(overrides: Record<string, unknown> = {}) {
  return {
    id: operationId,
    userId,
    providerId: "garmin",
    kind: "provider_sync",
    externalCorrelationKey: "sync-1",
    datasetKeys: ["activity"],
    createdAt: occurredAt,
    ...overrides,
  };
}

function expectedEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "20000000-0000-4000-8000-000000000001",
    sequence: 1,
    operationId,
    stage: "ingest",
    status: "succeeded",
    datasetKey: "activity",
    outputPath: null,
    modelName: null,
    occurredAt,
    progressPercentage: 100,
    sourceWatermark: null,
    servingWatermark: null,
    message: "Ingested",
    errorCode: null,
    errorMessage: null,
    metadataSchemaVersion: 1,
    metadata: { records: 3 },
    idempotencyKey: "event-1",
    ...overrides,
  };
}

function makeDatabase(responses: unknown[][]) {
  const execute = vi.fn(async () => responses.shift() ?? []);
  const database: Database = Object.assign(Object.create(null), { execute });
  database.transaction = vi.fn(async (callback) => callback(database));
  return { database, execute };
}

function compiledCall(execute: ReturnType<typeof vi.fn>, callIndex: number) {
  return dialect.sqlToQuery(execute.mock.calls[callIndex]?.[0]);
}

describe("processing event store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates and maps a new processing operation", async () => {
    const { database, execute } = makeDatabase([[operationRow()]]);

    await expect(
      createProcessingOperation(database, {
        userId,
        providerId: "garmin",
        kind: "provider_sync",
        externalCorrelationKey: "sync-1",
        datasetKeys: ["activity"],
      }),
    ).resolves.toEqual(expectedOperation());
    expect(compiledCall(execute, 0).params).toEqual([
      userId,
      "garmin",
      "provider_sync",
      "sync-1",
      "activity",
    ]);
  });

  it("resolves an idempotent operation conflict and rejects unresolved inserts", async () => {
    const existing = makeDatabase([[], [operationRow()]]);

    await expect(
      createProcessingOperation(existing.database, {
        userId,
        kind: "provider_sync",
        externalCorrelationKey: "sync-1",
        datasetKeys: ["activity"],
      }),
    ).resolves.toEqual(expectedOperation());
    expect(compiledCall(existing.execute, 1).params).toEqual([userId, "provider_sync", "sync-1"]);

    const withoutCorrelation = makeDatabase([[]]);
    await expect(
      createProcessingOperation(withoutCorrelation.database, {
        userId,
        kind: "provider_sync",
        datasetKeys: ["activity"],
      }),
    ).rejects.toThrow("Processing operation insert failed without an external correlation key");

    const unresolved = makeDatabase([[], []]);
    await expect(
      createProcessingOperation(unresolved.database, {
        userId,
        kind: "provider_sync",
        externalCorrelationKey: "sync-missing",
        datasetKeys: ["activity"],
      }),
    ).rejects.toThrow("Processing operation conflict could not be resolved");
  });

  it("appends and maps a complete processing event", async () => {
    const { database, execute } = makeDatabase([[eventRow()]]);

    await expect(
      appendProcessingStageEvent(database, {
        operationId,
        stage: "ingest",
        status: "succeeded",
        datasetKey: "activity",
        occurredAt,
        progressPercentage: 100,
        message: "Ingested",
        metadata: { records: 3 },
        idempotencyKey: "event-1",
      }),
    ).resolves.toEqual(expectedEvent());
    expect(compiledCall(execute, 0).params).toEqual([
      operationId,
      "ingest",
      "succeeded",
      "activity",
      null,
      null,
      occurredAt,
      100,
      null,
      null,
      "Ingested",
      null,
      null,
      1,
      '{"records":3}',
      "event-1",
    ]);
  });

  it("returns an existing idempotent event and rejects an unresolved event conflict", async () => {
    const existing = makeDatabase([[], [eventRow()]]);
    await expect(
      appendProcessingStageEvent(existing.database, {
        operationId,
        stage: "ingest",
        status: "succeeded",
        datasetKey: "activity",
        idempotencyKey: "event-1",
      }),
    ).resolves.toEqual(expectedEvent());
    expect(compiledCall(existing.execute, 1).params).toEqual([
      operationId,
      "ingest",
      "activity",
      null,
      null,
      "succeeded",
      "event-1",
    ]);

    const unresolved = makeDatabase([[], []]);
    await expect(
      appendProcessingStageEvent(unresolved.database, {
        operationId,
        stage: "ingest",
        status: "succeeded",
        idempotencyKey: "missing-event",
      }),
    ).rejects.toThrow("Processing event conflict could not be resolved");
  });

  it("maps and sorts the latest event facts by sequence", async () => {
    const { database } = makeDatabase([
      [
        eventRow({
          id: "20000000-0000-4000-8000-000000000003",
          sequence: 3,
          stage: "cdc",
          output_path: "relational",
          idempotency_key: "event-3",
        }),
        eventRow(),
      ],
    ]);

    await expect(getLatestProcessingEvents(database, operationId)).resolves.toEqual([
      expectedEvent(),
      expectedEvent({
        id: "20000000-0000-4000-8000-000000000003",
        sequence: 3,
        stage: "cdc",
        outputPath: "relational",
        idempotencyKey: "event-3",
      }),
    ]);
  });

  it("records and groups the output manifest in canonical path order", async () => {
    const output = makeDatabase([[]]);
    await recordProcessingOutput(output.database, {
      operationId,
      datasetKey: "activity",
      outputPath: "metric_stream",
    });
    expect(compiledCall(output.execute, 0).params).toEqual([
      operationId,
      "activity",
      "metric_stream",
    ]);

    const manifest = makeDatabase([
      [
        { dataset_key: "activity", output_path: "metric_stream" },
        { dataset_key: "nutrition", output_path: "relational" },
        { dataset_key: "activity", output_path: "relational" },
      ],
    ]);
    await expect(getProcessingOutputManifest(manifest.database, operationId)).resolves.toEqual({
      activity: ["relational", "metric_stream"],
      nutrition: ["relational"],
    });
  });

  it("maps datasets awaiting analytics and cache refresh", async () => {
    const analytics = makeDatabase([
      [
        { operation_id: operationId, dataset_key: "activity" },
        {
          operation_id: "10000000-0000-4000-8000-000000000003",
          dataset_key: "sleep",
        },
      ],
    ]);
    await expect(listProcessingDatasetsAwaitingAnalytics(analytics.database)).resolves.toEqual([
      { operationId, datasetKey: "activity" },
      { operationId: "10000000-0000-4000-8000-000000000003", datasetKey: "sleep" },
    ]);

    const cache = makeDatabase([
      [{ operation_id: operationId, dataset_key: "activity", user_id: userId }],
    ]);
    await expect(listProcessingDatasetsAwaitingCacheRefresh(cache.database)).resolves.toEqual([
      { operationId, datasetKey: "activity", userId },
    ]);
  });

  it("records relational canonical evidence and queue reconciliation in one transaction", async () => {
    const commit = eventRow({
      stage: "canonical_commit",
      output_path: "relational",
      source_watermark: "0/16B6C50",
      idempotency_key: "commit-1",
    });
    const queued = eventRow({
      id: "20000000-0000-4000-8000-000000000002",
      sequence: 2,
      stage: "cdc",
      status: "queued",
      output_path: "relational",
      source_watermark: "0/16B6C50",
      idempotency_key: "cdc:commit-1",
    });
    const { database, execute } = makeDatabase([[], [commit], [queued], [], [], []]);

    await expect(
      recordCanonicalCommit(database, {
        operationId,
        datasetKey: "activity",
        sourceWatermark: "0/16B6C50",
        flowNames: ["flow-a", "flow-b"],
        idempotencyKey: "commit-1",
      }),
    ).resolves.toEqual(
      expectedEvent({
        stage: "canonical_commit",
        outputPath: "relational",
        sourceWatermark: "0/16B6C50",
        idempotencyKey: "commit-1",
      }),
    );
    expect(database.transaction).toHaveBeenCalledOnce();
    expect(compiledCall(execute, 3).params).toEqual([
      operationId,
      "activity",
      "flow-a",
      "commit-1",
      "0/16B6C50",
    ]);
    expect(compiledCall(execute, 4).params).toEqual([
      operationId,
      "activity",
      "flow-b",
      "commit-1",
      "0/16B6C50",
    ]);
    expect(compiledCall(execute, 5).params).toEqual([operationId, `${operationId}:commit-1`]);
  });

  it("records relational dataset commits from a shared Postgres watermark", async () => {
    const commit = eventRow({
      stage: "canonical_commit",
      output_path: "relational",
      source_watermark: "0/16B6C51",
      idempotency_key: "sync-1:activity",
    });
    const queued = eventRow({
      sequence: 2,
      stage: "cdc",
      status: "queued",
      output_path: "relational",
      source_watermark: "0/16B6C51",
      idempotency_key: "cdc:sync-1:activity",
    });
    const { database, execute } = makeDatabase([
      [{ source_watermark: "0/16B6C51" }],
      [],
      [commit],
      [queued],
      [],
      [],
    ]);

    await recordRelationalCanonicalCommits(database, {
      operationId,
      datasetKeys: ["activity"],
      idempotencyKey: "sync-1",
    });

    expect(compiledCall(execute, 4).params).toEqual([
      operationId,
      "activity",
      "dofek_fitness_raw_analytics",
      "sync-1:activity",
      "0/16B6C51",
    ]);

    const missingWatermark = makeDatabase([[]]);
    await expect(
      recordRelationalCanonicalCommits(missingWatermark.database, {
        operationId,
        datasetKeys: ["nutrition"],
        idempotencyKey: "sync-2",
      }),
    ).rejects.toThrow("Postgres did not return a write watermark");

    const metricOnlyDataset = makeDatabase([[{ source_watermark: "0/16B6C52" }]]);
    await expect(
      recordRelationalCanonicalCommits(metricOnlyDataset.database, {
        operationId,
        datasetKeys: ["body"],
        idempotencyKey: "sync-3",
      }),
    ).rejects.toThrow("Dataset body does not define relational output");
  });

  it("records metric batch evidence for every emitted dataset", async () => {
    const activityCommit = eventRow({
      stage: "canonical_commit",
      output_path: "metric_stream",
      source_watermark: "batch-1",
      idempotency_key: "batch-1",
    });
    const activityQueued = eventRow({
      sequence: 2,
      stage: "cdc",
      status: "queued",
      output_path: "metric_stream",
      source_watermark: "batch-1",
      idempotency_key: "cdc:batch-1",
    });
    const { database, execute } = makeDatabase([[], [], [activityCommit], [activityQueued], []]);

    await recordMetricStreamBatchPublished(database, {
      operationId,
      batchId: "batch-1",
      datasetKeys: ["activity"],
      expectedEventCount: 4,
    });

    expect(compiledCall(execute, 0).params).toEqual([operationId, "batch-1", "activity", 4]);
    expect(compiledCall(execute, 4).params).toEqual([operationId, `${operationId}:batch-1`]);
  });

  it("lists scoped operations with latest events and output manifests", async () => {
    const { database, execute } = makeDatabase([
      [
        {
          ...operationRow(),
          events: [eventRow()],
          output_manifest: [{ dataset_key: "activity", output_path: "relational" }],
        },
      ],
    ]);

    await expect(
      listScopedProcessingOperations(database, {
        userId,
        providerId: "garmin",
        datasetKeys: ["activity"],
        limit: 5,
      }),
    ).resolves.toEqual([
      {
        ...expectedOperation(),
        events: [expectedEvent()],
        outputManifest: { activity: ["relational"] },
      },
    ]);
    expect(execute).toHaveBeenCalledOnce();
    expect(compiledCall(execute, 0).params).toEqual([userId, "garmin", "garmin", "activity", 5]);
  });

  it("paginates processing history by operation cursor", async () => {
    const olderId = "10000000-0000-4000-8000-000000000003";
    const oldestId = "10000000-0000-4000-8000-000000000004";
    const { database, execute } = makeDatabase([
      [
        operationRow(),
        operationRow({ id: olderId, external_correlation_key: "sync-older" }),
        operationRow({ id: oldestId, external_correlation_key: "sync-oldest" }),
      ],
    ]);

    await expect(
      listProcessingHistory(database, { userId, cursor: operationId, limit: 3 }),
    ).resolves.toEqual({
      operations: [
        expectedOperation(),
        expectedOperation({ id: olderId, externalCorrelationKey: "sync-older" }),
        expectedOperation({ id: oldestId, externalCorrelationKey: "sync-oldest" }),
      ],
      nextCursor: oldestId,
    });
    expect(compiledCall(execute, 0).params).toEqual([userId, operationId, operationId, userId, 3]);

    const lastPage = makeDatabase([[operationRow()]]);
    await expect(listProcessingHistory(lastPage.database, { userId, limit: 2 })).resolves.toEqual({
      operations: [expectedOperation()],
      nextCursor: null,
    });
  });
});
