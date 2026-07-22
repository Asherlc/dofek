import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
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

describe("processing event store (integration)", () => {
  const userId = "00000000-0000-4000-8000-000000001852";
  const otherUserId = "00000000-0000-4000-8000-000000001853";
  const historyUserId = "00000000-0000-4000-8000-000000001854";
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    await testContext.db.execute(sql`INSERT INTO fitness.user_profile (id, name)
      VALUES (${userId}, 'Processing User'),
             (${otherUserId}, 'Other Processing User'),
             (${historyUserId}, 'History Processing User')`);
  }, 120_000);

  afterAll(async () => {
    await testContext?.cleanup();
  });

  async function createOperation(ownerId = userId, correlationKey = randomUUID()) {
    return createProcessingOperation(testContext.db, {
      userId: ownerId,
      providerId: "kaya",
      kind: "provider_sync",
      externalCorrelationKey: correlationKey,
      datasetKeys: ["activity", "hiking"],
    });
  }

  it("reuses an operation for the same external correlation key", async () => {
    const correlationKey = randomUUID();
    const first = await createOperation(userId, correlationKey);
    const repeated = await createOperation(userId, correlationKey);

    expect(repeated).toEqual(first);
  });

  it("inserts stage facts idempotently and orders them by a monotonic sequence", async () => {
    const operation = await createOperation();
    const input: Parameters<typeof appendProcessingStageEvent>[1] = {
      operationId: operation.id,
      stage: "ingest" as const,
      status: "running" as const,
      datasetKey: "activity",
      idempotencyKey: "worker-started",
      progressPercentage: 10,
    };

    const first = await appendProcessingStageEvent(testContext.db, input);
    const repeated = await appendProcessingStageEvent(testContext.db, input);
    const completed = await appendProcessingStageEvent(testContext.db, {
      ...input,
      status: "succeeded",
      idempotencyKey: "worker-completed",
      progressPercentage: 100,
    });

    expect(repeated).toEqual(first);
    expect(completed.sequence).toBeGreaterThan(first.sequence);
    expect(await getLatestProcessingEvents(testContext.db, operation.id)).toEqual([completed]);
  });

  it("records emitted output paths idempotently without storing their payloads", async () => {
    const operation = await createOperation();
    await recordProcessingOutput(testContext.db, {
      operationId: operation.id,
      datasetKey: "activity",
      outputPath: "relational",
    });
    await recordProcessingOutput(testContext.db, {
      operationId: operation.id,
      datasetKey: "activity",
      outputPath: "relational",
    });
    await recordProcessingOutput(testContext.db, {
      operationId: operation.id,
      datasetKey: "activity",
      outputPath: "metric_stream",
    });

    expect(await getProcessingOutputManifest(testContext.db, operation.id)).toEqual({
      activity: ["relational", "metric_stream"],
    });
  });

  it("loads scoped operations with their latest events and output manifests", async () => {
    const operation = await createOperation();
    await recordProcessingOutput(testContext.db, {
      operationId: operation.id,
      datasetKey: "activity",
      outputPath: "relational",
    });
    const event = await appendProcessingStageEvent(testContext.db, {
      operationId: operation.id,
      stage: "ingest",
      status: "succeeded",
      datasetKey: "activity",
      idempotencyKey: `scoped:${operation.id}`,
    });

    await expect(
      listScopedProcessingOperations(testContext.db, {
        userId,
        providerId: "kaya",
        datasetKeys: ["activity"],
        limit: 100,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: operation.id,
          events: [event],
          outputManifest: { activity: ["relational"] },
        }),
      ]),
    );
  });

  it("keeps relational and metric-stream stage facts independent", async () => {
    const operation = await createOperation();
    const commonInput = {
      operationId: operation.id,
      stage: "canonical_commit" as const,
      status: "succeeded" as const,
      datasetKey: "activity" as const,
      idempotencyKey: "batch-1",
    };
    await appendProcessingStageEvent(testContext.db, {
      ...commonInput,
      outputPath: "relational",
    });
    await appendProcessingStageEvent(testContext.db, {
      ...commonInput,
      outputPath: "metric_stream",
    });

    expect(await getLatestProcessingEvents(testContext.db, operation.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outputPath: "relational" }),
        expect.objectContaining({ outputPath: "metric_stream" }),
      ]),
    );
  });

  it("prevents stage-event mutation and deletion", async () => {
    const operation = await createOperation();
    const stageEvent = await appendProcessingStageEvent(testContext.db, {
      operationId: operation.id,
      stage: "ingest",
      status: "running",
      datasetKey: "activity",
      idempotencyKey: "immutable-event",
    });

    await expect(
      testContext.db.execute(
        sql`UPDATE fitness.processing_stage_event SET status = 'succeeded'
            WHERE id = ${stageEvent.id}::uuid`,
      ),
    ).rejects.toThrow();
    await expect(
      testContext.db.execute(
        sql`DELETE FROM fitness.processing_stage_event WHERE id = ${stageEvent.id}::uuid`,
      ),
    ).rejects.toThrow();
    expect(await getLatestProcessingEvents(testContext.db, operation.id)).toEqual([stageEvent]);
  });

  it("prevents relational evidence marker mutation", async () => {
    const operation = await createOperation();
    await recordCanonicalCommit(testContext.db, {
      operationId: operation.id,
      datasetKey: "activity",
      sourceWatermark: "immutable-watermark",
      flowNames: ["dofek_fitness_raw_analytics"],
      idempotencyKey: "immutable-marker",
    });

    await expect(
      testContext.db.execute(
        sql`UPDATE fitness.processing_flow_marker SET source_watermark = 'changed'
            WHERE operation_id = ${operation.id}::uuid`,
      ),
    ).rejects.toThrow();
  });

  it("records commit evidence, flow markers, and reconciliation dispatch atomically", async () => {
    const operation = await createOperation();
    await recordCanonicalCommit(testContext.db, {
      operationId: operation.id,
      datasetKey: "activity",
      sourceWatermark: randomUUID(),
      flowNames: ["dofek_fitness_raw_analytics"],
      idempotencyKey: "canonical-commit-1",
    });
    await recordCanonicalCommit(testContext.db, {
      operationId: operation.id,
      datasetKey: "activity",
      sourceWatermark: randomUUID(),
      flowNames: ["dofek_fitness_raw_analytics"],
      idempotencyKey: "canonical-commit-1",
    });

    const counts = await testContext.db.execute(
      sql`SELECT
            (SELECT count(*)::integer FROM fitness.processing_stage_event
              WHERE operation_id = ${operation.id}::uuid AND stage = 'canonical_commit') AS events,
            (SELECT count(*)::integer FROM fitness.processing_flow_marker
              WHERE operation_id = ${operation.id}::uuid) AS markers,
            (SELECT count(*)::integer FROM fitness.processing_stage_event
              WHERE operation_id = ${operation.id}::uuid
                AND stage = 'cdc' AND status = 'queued') AS cdc_events,
            (SELECT count(*)::integer FROM fitness.processing_queue_outbox
              WHERE operation_id = ${operation.id}::uuid) AS outbox`,
    );
    expect(counts[0]).toEqual({ events: 1, markers: 1, cdc_events: 1, outbox: 1 });
  });

  it("records metric-stream batch expectations without storing metric payloads", async () => {
    const operation = await createOperation();
    await recordMetricStreamBatchPublished(testContext.db, {
      operationId: operation.id,
      batchId: "metric-batch-1",
      datasetKeys: ["activity", "hiking"],
      expectedEventCount: 63,
    });
    await recordMetricStreamBatchPublished(testContext.db, {
      operationId: operation.id,
      batchId: "metric-batch-1",
      datasetKeys: ["activity", "hiking"],
      expectedEventCount: 63,
    });

    const counts = await testContext.db.execute(sql`SELECT
      (SELECT count(*)::integer FROM fitness.processing_metric_stream_batch
        WHERE operation_id = ${operation.id}::uuid) AS batches,
      (SELECT count(*)::integer FROM fitness.processing_operation_output
        WHERE operation_id = ${operation.id}::uuid AND output_path = 'metric_stream') AS outputs,
      (SELECT count(*)::integer FROM fitness.processing_stage_event
        WHERE operation_id = ${operation.id}::uuid
          AND stage = 'canonical_commit'
          AND output_path = 'metric_stream') AS events,
      (SELECT count(*)::integer FROM fitness.processing_stage_event
        WHERE operation_id = ${operation.id}::uuid
          AND stage = 'cdc'
          AND status = 'queued'
          AND output_path = 'metric_stream') AS cdc_events,
      (SELECT count(*)::integer FROM fitness.processing_queue_outbox
        WHERE operation_id = ${operation.id}::uuid) AS outbox`);

    expect(counts[0]).toEqual({ batches: 1, outputs: 2, events: 2, cdc_events: 2, outbox: 1 });
    expect(await getProcessingOutputManifest(testContext.db, operation.id)).toEqual({
      activity: ["metric_stream"],
      hiking: ["metric_stream"],
    });
  });

  it("enqueues every distinct relational batch for a long-running operation", async () => {
    const operation = await createOperation();
    for (const batchKey of ["relational-batch-1", "relational-batch-2"]) {
      await recordCanonicalCommit(testContext.db, {
        operationId: operation.id,
        datasetKey: "activity",
        sourceWatermark: batchKey,
        flowNames: ["dofek_fitness_raw_analytics"],
        idempotencyKey: batchKey,
      });
    }

    const counts = await testContext.db.execute(sql`SELECT
      (SELECT count(*)::integer FROM fitness.processing_flow_marker
        WHERE operation_id = ${operation.id}::uuid) AS markers,
      (SELECT count(*)::integer FROM fitness.processing_queue_outbox
        WHERE operation_id = ${operation.id}::uuid) AS outbox`);

    expect(counts[0]).toEqual({ markers: 2, outbox: 2 });
  });

  it("records one relational fence for every emitted dataset in one transaction", async () => {
    const operation = await createOperation();

    await recordRelationalCanonicalCommits(testContext.db, {
      operationId: operation.id,
      datasetKeys: ["activity", "nutrition"],
      idempotencyKey: "provider-write-batch-1",
    });

    const evidence = await testContext.db.execute(sql`SELECT
      (SELECT count(*)::integer FROM fitness.processing_operation_output
        WHERE operation_id = ${operation.id}::uuid AND output_path = 'relational') AS outputs,
      (SELECT count(*)::integer FROM fitness.processing_flow_marker
        WHERE operation_id = ${operation.id}::uuid) AS markers,
      (SELECT count(*)::integer FROM fitness.processing_stage_event
        WHERE operation_id = ${operation.id}::uuid
          AND stage = 'canonical_commit'
          AND output_path = 'relational') AS events`);

    expect(evidence[0]).toEqual({ outputs: 2, markers: 1, events: 2 });
  });

  it("keeps history tenant-scoped and cursor-paginated", async () => {
    const ownedFirst = await createOperation(historyUserId);
    const ownedSecond = await createOperation(historyUserId);
    await createOperation(otherUserId);

    const firstPage = await listProcessingHistory(testContext.db, {
      userId: historyUserId,
      limit: 1,
    });
    const secondPage = await listProcessingHistory(testContext.db, {
      userId: historyUserId,
      limit: 10,
      cursor: firstPage.nextCursor,
    });

    expect(firstPage.operations).toHaveLength(1);
    expect(secondPage.operations.map(({ id }) => id)).toEqual(
      expect.arrayContaining(
        [ownedFirst.id, ownedSecond.id].filter((id) => id !== firstPage.operations[0]?.id),
      ),
    );
    expect([...firstPage.operations, ...secondPage.operations]).toHaveLength(2);
  });

  it("selects datasets only when their durable prerequisite stage completed", async () => {
    const operation = await createOperation();
    await recordProcessingOutput(testContext.db, {
      operationId: operation.id,
      datasetKey: "activity",
      outputPath: "relational",
    });
    for (const eventInput of [
      { stage: "ingest", status: "succeeded", outputPath: null },
      { stage: "canonical_commit", status: "succeeded", outputPath: "relational" },
      { stage: "cdc", status: "succeeded", outputPath: "relational" },
    ] as const) {
      await appendProcessingStageEvent(testContext.db, {
        operationId: operation.id,
        datasetKey: "activity",
        ...eventInput,
        idempotencyKey: `awaiting-${eventInput.stage}`,
      });
    }

    expect(await listProcessingDatasetsAwaitingAnalytics(testContext.db)).toContainEqual({
      operationId: operation.id,
      datasetKey: "activity",
    });
    expect(await listProcessingDatasetsAwaitingCacheRefresh(testContext.db)).not.toContainEqual({
      operationId: operation.id,
      datasetKey: "activity",
    });

    await appendProcessingStageEvent(testContext.db, {
      operationId: operation.id,
      datasetKey: "activity",
      stage: "analytics",
      status: "succeeded",
      idempotencyKey: "awaiting-analytics",
    });

    expect(await listProcessingDatasetsAwaitingCacheRefresh(testContext.db)).toContainEqual({
      operationId: operation.id,
      datasetKey: "activity",
      userId,
    });
  });
});
