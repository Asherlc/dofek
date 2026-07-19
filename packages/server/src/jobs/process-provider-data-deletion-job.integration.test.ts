import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import {
  type ProviderDataDeletionClickHouseClient,
  processProviderDataDeletionJob,
} from "../../../../src/jobs/process-provider-data-deletion-job.ts";
import type { ProviderDataDeletionJobData } from "../../../../src/jobs/queues.ts";
import { applyMetricStreamEventsToClickHouse } from "../../../../src/metric-stream/clickhouse-sink.ts";
import { createMetricStreamEvent } from "../../../../src/metric-stream/events.ts";
import {
  createClickHouseTestActivitySensorStore,
  getClickHouseTestClient,
  insertClickHouseMetricStreamRows,
} from "../routers/clickhouse-integration-test-helpers.ts";

const userId = "10000000-0000-4000-8000-000000000001";
const eventId = "20000000-0000-4000-8000-000000000002";
const oldGenerationId = "30000000-0000-4000-8000-000000000003";
const activeGenerationId = "40000000-0000-4000-8000-000000000004";
const reusedGenerationId = "50000000-0000-4000-8000-000000000005";
const operationRevision = "1000000000000000";
const generationAggregateRowsSchema = z.array(
  z.object({ generation: z.coerce.number().int().nonnegative() }),
);
const acknowledgementAggregateRowsSchema = z.array(
  z.object({ acknowledgement_count: z.coerce.number().int().nonnegative() }),
);

describe("processProviderDataDeletionJob ClickHouse integration", () => {
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    await createClickHouseTestActivitySensorStore(testContext);
  });

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("tombstones older generations while preserving the active generation", async () => {
    await insertClickHouseMetricStreamRows(testContext, [
      {
        id: oldGenerationId,
        userId,
        recordedAt: "2026-07-18T12:00:00.000Z",
        channel: "heart_rate",
        providerId: "garmin",
        scalar: 140,
        generation: 0,
      },
      {
        id: activeGenerationId,
        userId,
        recordedAt: "2026-07-18T12:00:01.000Z",
        channel: "heart_rate",
        providerId: "garmin",
        scalar: 141,
        generation: 1,
      },
    ]);

    const data: ProviderDataDeletionJobData = {
      type: "provider-data-deletion",
      eventId,
      generation: 1,
      providerId: "garmin",
      userId,
    };
    const job = {
      data,
      updateData: vi.fn(async (nextData: ProviderDataDeletionJobData) => {
        Object.assign(data, nextData);
      }),
      updateProgress: vi.fn(async () => undefined),
    };
    const enqueueAnalyticsRefresh = vi.fn(async () => undefined);
    const markCompleted = vi.fn(async () => undefined);
    const clickHouseClient = getClickHouseTestClient(testContext);
    await clickHouseClient.command({
      query: `INSERT INTO ingest.metric_stream (
          id, activity_id, user_id, recorded_at, channel, provider_id, external_id,
          device_id, source_type, scalar, vector, point, metadata, ingested_at,
          is_deleted, version, generation
        )
        SELECT
          generateUUIDv4(),
          NULL,
          {user_id:UUID},
          addMicroseconds(toDateTime64('2026-01-01 00:00:00', 6, 'UTC'), number),
          'noise',
          'unrelated-provider',
          NULL,
          NULL,
          'integration-test',
          toFloat32(number),
          [],
          'null',
          '{}',
          now64(9),
          0,
          1,
          0
        FROM numbers(20_000)`,
      query_params: { user_id: userId },
    });

    await processProviderDataDeletionJob(job, {
      clickHouseClient,
      enqueueAnalyticsRefresh,
      markCompleted,
    });

    const metricStreamResult = await clickHouseClient.query<{
      generation: string;
      id: string;
      is_deleted: number;
    }>({
      query: `SELECT
        id,
        any(generation) AS generation,
        argMax(is_deleted, tuple(version, ingested_at)) AS is_deleted
      FROM ingest.metric_stream
      WHERE id IN ({old_id:UUID}, {active_id:UUID})
      GROUP BY id
      ORDER BY id`,
      query_params: { active_id: activeGenerationId, old_id: oldGenerationId },
      format: "JSONEachRow",
    });
    const metricStreamRows = await metricStreamResult.json();

    expect(
      metricStreamRows.map((row) => ({
        generation: Number(row.generation),
        id: row.id,
        isDeleted: Number(row.is_deleted),
      })),
    ).toEqual([
      { generation: 0, id: oldGenerationId, isDeleted: 1 },
      { generation: 1, id: activeGenerationId, isDeleted: 0 },
    ]);

    const generationResult = await clickHouseClient.query({
      query: `SELECT max(generation) AS generation
        FROM ingest.provider_data_generation
        WHERE user_id = {user_id:UUID} AND provider_id = {provider_id:String}`,
      query_params: { provider_id: "garmin", user_id: userId },
      format: "JSONEachRow",
    });
    expect(generationAggregateRowsSchema.parse(await generationResult.json())).toEqual([
      { generation: 1 },
    ]);

    const acknowledgementResult = await clickHouseClient.query({
      query: `SELECT count() AS acknowledgement_count
        FROM ingest.metric_stream_delete_acknowledgement
        WHERE event_id = {event_id:UUID}`,
      query_params: { event_id: eventId },
      format: "JSONEachRow",
    });
    expect(acknowledgementAggregateRowsSchema.parse(await acknowledgementResult.json())).toEqual([
      { acknowledgement_count: 1 },
    ]);
    expect(enqueueAnalyticsRefresh).toHaveBeenCalledWith(userId, "garmin", eventId);
    expect(markCompleted).toHaveBeenCalledWith(eventId);
  });

  it("tombstones a stale event when the generation fence advances during insertion", async () => {
    const clickHouseClient = getClickHouseTestClient(testContext);
    const insert = clickHouseClient.insert;
    if (!insert) {
      throw new Error("ClickHouse integration test client does not support inserts");
    }
    const staleEvent = createMetricStreamEvent(
      {
        channel: "heart_rate",
        externalId: "late-event",
        generation: 0,
        providerId: "race-provider",
        recordedAt: "2026-07-18T12:30:00.000Z",
        scalar: 142,
        sourceType: "integration-test",
        userId,
      },
      operationRevision,
    );

    const applied = await applyMetricStreamEventsToClickHouse(
      {
        command: (options) => clickHouseClient.command(options),
        query: (options) => clickHouseClient.query(options),
        insert: async (options) => {
          const result = await insert(options);
          await clickHouseClient.command({
            query: `INSERT INTO ingest.provider_data_generation (
                user_id, provider_id, generation, updated_at
              ) VALUES ({user_id:UUID}, {provider_id:String}, 1, now64(9))`,
            query_params: { provider_id: staleEvent.providerId, user_id: staleEvent.userId },
          });
          return result;
        },
      },
      [staleEvent],
    );

    expect(applied).toBe(0);
    const result = await clickHouseClient.query<{ id: string; is_deleted: number }>({
      query: `SELECT id, argMax(is_deleted, tuple(version, ingested_at)) AS is_deleted
        FROM ingest.metric_stream
        WHERE id = {id:UUID}
        GROUP BY id`,
      query_params: { id: staleEvent.id },
      format: "JSONEachRow",
    });
    await expect(result.json()).resolves.toEqual([{ id: staleEvent.id, is_deleted: 1 }]);
  });

  it("keeps each tombstone insert bounded to its selected generation and ID keys", async () => {
    const providerId = "reused-id-provider";
    const clickHouseClient = getClickHouseTestClient(testContext);
    await clickHouseClient.command({
      query: `INSERT INTO ingest.metric_stream (
          id, activity_id, user_id, recorded_at, channel, provider_id, external_id,
          device_id, source_type, scalar, vector, point, metadata, ingested_at,
          is_deleted, version, generation
        )
        SELECT
          generateUUIDv4(),
          NULL,
          {user_id:UUID},
          addMicroseconds(toDateTime64('2026-02-01 00:00:00', 6, 'UTC'), number),
          'heart_rate',
          {provider_id:String},
          NULL,
          NULL,
          'integration-test',
          toFloat32(number),
          [],
          'null',
          '{}',
          now64(9),
          0,
          1,
          0
        FROM numbers(999)`,
      query_params: { provider_id: providerId, user_id: userId },
    });
    await insertClickHouseMetricStreamRows(testContext, [
      {
        id: reusedGenerationId,
        userId,
        recordedAt: "2026-02-02T00:00:00.000Z",
        channel: "heart_rate",
        providerId,
        scalar: 140,
        generation: 0,
      },
      {
        id: reusedGenerationId,
        userId,
        recordedAt: "2026-02-03T00:00:00.000Z",
        channel: "heart_rate",
        providerId,
        scalar: 141,
        generation: 1,
      },
    ]);

    const insertedBatchKeys: Array<Array<{ generation: number; id: string }>> = [];
    const deletionClient: ProviderDataDeletionClickHouseClient = {
      command: (options) => clickHouseClient.command(options),
      query: async (options) => {
        const result = await clickHouseClient.query(options);
        return { json: () => result.json() };
      },
      insert: async (options) => {
        insertedBatchKeys.push(
          z
            .array(
              z.object({
                generation: z.coerce.number().int().nonnegative(),
                id: z.uuid(),
              }),
            )
            .parse(options.values),
        );
        return clickHouseClient.insert(options);
      },
    };
    const data: ProviderDataDeletionJobData = {
      type: "provider-data-deletion",
      eventId: "60000000-0000-4000-8000-000000000006",
      generation: 2,
      providerId,
      userId,
    };
    const job = {
      data,
      updateData: vi.fn(async (nextData: ProviderDataDeletionJobData) => {
        Object.assign(data, nextData);
      }),
      updateProgress: vi.fn(async () => undefined),
    };

    await processProviderDataDeletionJob(job, {
      clickHouseClient: deletionClient,
      enqueueAnalyticsRefresh: vi.fn(async () => undefined),
      markCompleted: vi.fn(async () => undefined),
    });

    expect(insertedBatchKeys).toHaveLength(2);
    expect(insertedBatchKeys[0]).toHaveLength(1_000);
    expect(insertedBatchKeys[0]).toContainEqual({ generation: 0, id: reusedGenerationId });
    expect(insertedBatchKeys[0]).not.toContainEqual({ generation: 1, id: reusedGenerationId });
    expect(insertedBatchKeys[1]).toEqual([{ generation: 1, id: reusedGenerationId }]);
  });
});
