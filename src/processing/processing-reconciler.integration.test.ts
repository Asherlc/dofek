import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import { buildPostgresFitnessRawTableStatements } from "../db/clickhouse-raw-tables.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { buildMetricStreamProcessingAcknowledgementTableSql } from "../metric-stream/clickhouse-table.ts";
import {
  createProcessingOperation,
  getLatestProcessingEvents,
  recordCanonicalCommit,
  recordMetricStreamBatchPublished,
} from "./processing-event-store.ts";
import { reconcilePendingProcessingOperations } from "./processing-reconciler.ts";

describe("processing reconciler (integration)", () => {
  let testContext: TestContext;
  let clickHouseClient: ClickHouseClient;
  const operationIds: string[] = [];

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    clickHouseClient = createClickHouseClientFromEnv();
    await clickHouseClient.command({ query: "CREATE DATABASE IF NOT EXISTS postgres_fitness" });
    await clickHouseClient.command({ query: "CREATE DATABASE IF NOT EXISTS ingest" });
    const markerTableStatement = buildPostgresFitnessRawTableStatements().find((statement) =>
      statement.includes("postgres_fitness.processing_flow_marker ("),
    );
    if (!markerTableStatement) throw new Error("Missing processing flow marker table statement");
    await clickHouseClient.command({ query: markerTableStatement });
    const providerInventoryMarkerTableStatement = buildPostgresFitnessRawTableStatements().find(
      (statement) =>
        statement.includes("postgres_fitness.processing_flow_marker_provider_inventory ("),
    );
    if (!providerInventoryMarkerTableStatement) {
      throw new Error("Missing provider inventory processing flow marker table statement");
    }
    await clickHouseClient.command({ query: providerInventoryMarkerTableStatement });
    await clickHouseClient.command({
      query: buildMetricStreamProcessingAcknowledgementTableSql(),
    });
  }, 120_000);

  afterAll(async () => {
    if (operationIds.length > 0) {
      const queryParameters = { operation_ids: operationIds };
      await clickHouseClient.command({
        query: `ALTER TABLE postgres_fitness.processing_flow_marker
          DELETE WHERE operation_id IN {operation_ids:Array(UUID)}
          SETTINGS mutations_sync = 1`,
        query_params: queryParameters,
      });
      await clickHouseClient.command({
        query: `ALTER TABLE postgres_fitness.processing_flow_marker_provider_inventory
          DELETE WHERE operation_id IN {operation_ids:Array(UUID)}
          SETTINGS mutations_sync = 1`,
        query_params: queryParameters,
      });
      await clickHouseClient.command({
        query: `ALTER TABLE ingest.metric_stream_processing_acknowledgement
          DELETE WHERE operation_id IN {operation_ids:Array(UUID)}
          SETTINGS mutations_sync = 1`,
        query_params: queryParameters,
      });
    }
    await clickHouseClient?.close?.();
    await testContext?.cleanup();
  });

  it("advances relational CDC only after ClickHouse contains the exact PeerDB marker", async () => {
    const operation = await createProcessingOperation(testContext.db, {
      userId: null,
      providerId: "kaya-export",
      kind: "file_import",
      externalCorrelationKey: "reconciler-relational",
      datasetKeys: ["activity"],
    });
    operationIds.push(operation.id);
    await recordCanonicalCommit(testContext.db, {
      operationId: operation.id,
      datasetKey: "activity",
      sourceWatermark: "0/1852",
      flowNames: ["dofek_fitness_raw_analytics"],
      idempotencyKey: "relational-batch-1",
    });

    await expect(
      reconcilePendingProcessingOperations({
        database: testContext.db,
        clickHouseClient,
      }),
    ).resolves.toMatchObject({ completed: 0, waiting: 1 });

    await clickHouseClient.command({
      query: `INSERT INTO postgres_fitness.processing_flow_marker (
          id, operation_id, dataset_key, flow_name, batch_key, source_watermark,
          created_at, _peerdb_version
        ) VALUES (
          generateUUIDv4(), {operation_id:UUID}, 'activity',
          'dofek_fitness_raw_analytics', 'relational-batch-1', '0/1852', now64(6), 1
        )`,
      query_params: { operation_id: operation.id },
    });

    await expect(
      reconcilePendingProcessingOperations({
        database: testContext.db,
        clickHouseClient,
      }),
    ).resolves.toMatchObject({ completed: 1, waiting: 0 });
    const events = await getLatestProcessingEvents(testContext.db, operation.id);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "cdc",
          status: "succeeded",
          datasetKey: "activity",
          outputPath: "relational",
        }),
        expect.objectContaining({
          stage: "analytics",
          status: "queued",
          datasetKey: "activity",
        }),
      ]),
    );
  });

  it("advances metric CDC only after ClickHouse contains the exact sink batch receipt", async () => {
    const operation = await createProcessingOperation(testContext.db, {
      userId: null,
      providerId: "fit-file",
      kind: "file_import",
      externalCorrelationKey: "reconciler-metric",
      datasetKeys: ["recovery"],
    });
    operationIds.push(operation.id);
    await recordMetricStreamBatchPublished(testContext.db, {
      operationId: operation.id,
      batchId: "metric-batch-1",
      datasetKeys: ["recovery"],
      expectedEventCount: 2,
    });

    await expect(
      reconcilePendingProcessingOperations({
        database: testContext.db,
        clickHouseClient,
      }),
    ).resolves.toMatchObject({ completed: 0, waiting: 1 });

    await clickHouseClient.command({
      query: `INSERT INTO ingest.metric_stream_processing_acknowledgement (
          operation_id, batch_id, dataset_keys, expected_event_count,
          topic, topic_partition, marker_offset
        ) VALUES (
          {operation_id:UUID}, 'metric-batch-1', ['recovery'], 2,
          'metric-stream-v1', 0, 12
        )`,
      query_params: { operation_id: operation.id },
    });

    await expect(
      reconcilePendingProcessingOperations({
        database: testContext.db,
        clickHouseClient,
      }),
    ).resolves.toMatchObject({ completed: 1, waiting: 0 });
  });

  it("waits for each applicable PeerDB flow before provider analytics", async () => {
    const operation = await createProcessingOperation(testContext.db, {
      userId: null,
      providerId: "cronometer-csv",
      kind: "file_import",
      externalCorrelationKey: "reconciler-provider-flows",
      datasetKeys: ["providers"],
    });
    operationIds.push(operation.id);
    await recordCanonicalCommit(testContext.db, {
      operationId: operation.id,
      datasetKey: "providers",
      sourceWatermark: "0/1853",
      flowNames: ["dofek_fitness_raw_analytics", "dofek_provider_inventory_raw_analytics"],
      idempotencyKey: "provider-relational-batch-1",
    });

    await clickHouseClient.command({
      query: `INSERT INTO postgres_fitness.processing_flow_marker (
          id, operation_id, dataset_key, flow_name, batch_key, source_watermark,
          created_at, _peerdb_version
        ) VALUES
        (
          generateUUIDv4(), {operation_id:UUID}, 'providers',
          'dofek_fitness_raw_analytics', 'provider-relational-batch-1',
          '0/1853', now64(6), 1
        ),
        (
          generateUUIDv4(), {operation_id:UUID}, 'providers',
          'dofek_provider_inventory_raw_analytics', 'provider-relational-batch-1',
          '0/1853', now64(6), 1
        )`,
      query_params: { operation_id: operation.id },
    });

    await expect(
      reconcilePendingProcessingOperations({
        database: testContext.db,
        clickHouseClient,
      }),
    ).resolves.toMatchObject({ completed: 0, waiting: 1 });

    await clickHouseClient.command({
      query: `INSERT INTO postgres_fitness.processing_flow_marker_provider_inventory (
          id, operation_id, dataset_key, flow_name, batch_key, source_watermark,
          created_at, _peerdb_version
        ) VALUES (
          generateUUIDv4(), {operation_id:UUID}, 'providers',
          'dofek_provider_inventory_raw_analytics', 'provider-relational-batch-1',
          '0/1853', now64(6), 1
        )`,
      query_params: { operation_id: operation.id },
    });

    await expect(
      reconcilePendingProcessingOperations({
        database: testContext.db,
        clickHouseClient,
      }),
    ).resolves.toMatchObject({ completed: 1, waiting: 0 });
  });
});
