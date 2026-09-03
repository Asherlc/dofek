import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ClickHouseClient,
  createClickHouseClientFromEnv,
} from "../../../../src/db/clickhouse.ts";
import {
  extractCteSql,
  readModelSql,
  renderDbtModelSql,
} from "../../../../src/db/read-model-sql-test-helpers.ts";
import {
  buildIngestMetricStreamCreateTableSql,
  METRIC_STREAM_PROVIDER_CURRENT_STATE_RECORDED_AT_PROJECTION,
} from "../../../../src/metric-stream/clickhouse-table.ts";

const dailyRowsSchema = z.array(
  z.object({
    metric_stream_count: z.coerce.number().int().nonnegative(),
    provider_id: z.string(),
    recorded_date: z.string(),
    refreshed_at: z.coerce.bigint(),
    source_changed_at: z.coerce.bigint(),
    user_id: z.string(),
  }),
);
const countSchema = z.array(z.object({ count: z.coerce.number().int().nonnegative() }));
const projectionPartSchema = z.array(
  z.object({
    active_parts: z.coerce.number().int().positive(),
    missing_projection_parts: z.coerce.number().int().nonnegative(),
  }),
);

interface MetricRow {
  id: string;
  recordedAt: string;
  ingestedAt: string;
  version: number;
  isDeleted: number;
}

function renderProviderMetricStreamDailySql(
  rawTable: string,
  markerTable: string,
  targetTable: string,
  isIncremental: boolean,
  batchSize: number,
): string {
  return renderDbtModelSql(readModelSql("provider_metric_stream_daily.sql"), {
    isIncremental,
  })
    .replaceAll("{{ provider_metric_stream_day_batch_size }}", String(batchSize))
    .replace(/\{\{\s*source\('analytics',\s*'metric_stream_day_change'\)\s*\}\}/g, markerTable)
    .replace(/\{\{\s*source\('ingest',\s*'metric_stream_current'\)\s*\}\}/g, rawTable)
    .replace(/\{\{\s*this\s*\}\}/g, targetTable);
}

async function insertMetricRow(
  client: ClickHouseClient,
  table: string,
  userId: string,
  providerId: string,
  row: MetricRow,
): Promise<void> {
  await client.command({
    query: `INSERT INTO ${table} (
      id,
      user_id,
      recorded_at,
      channel,
      provider_id,
      ingested_at,
      is_deleted,
      version
    ) VALUES (
      {id:UUID},
      {userId:UUID},
      {recordedAt:DateTime64(6, 'UTC')},
      'heart_rate',
      {providerId:String},
      {ingestedAt:DateTime64(9, 'UTC')},
      {isDeleted:Int8},
      {version:Int64}
    )`,
    query_params: { ...row, providerId, userId },
  });
}

async function insertDayMarker(
  client: ClickHouseClient,
  table: string,
  userId: string,
  providerId: string,
  recordedDate: string,
  changedAt: string,
): Promise<void> {
  await client.command({
    query: `INSERT INTO ${table} (
      user_id,
      provider_id,
      recorded_date,
      changed_at
    ) VALUES (
      {userId:UUID},
      {providerId:String},
      {recordedDate:Date},
      {changedAt:DateTime64(9, 'UTC')}
    )`,
    query_params: { changedAt, providerId, recordedDate, userId },
  });
}

describe("provider_metric_stream_daily read model", () => {
  const database = `provider_metric_stream_daily_${randomUUID().replaceAll("-", "")}`;
  const rawTable = `${database}.metric_stream`;
  const markerTable = `${database}.metric_stream_day_change`;
  const targetTable = `${database}.provider_metric_stream_daily`;
  let client: ClickHouseClient;

  beforeAll(async () => {
    client = createClickHouseClientFromEnv();
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: buildIngestMetricStreamCreateTableSql().replace("ingest.metric_stream", rawTable),
    });
    await client.command({
      query: `CREATE TABLE ${markerTable} (
        user_id UUID,
        provider_id String,
        recorded_date Date,
        changed_at SimpleAggregateFunction(max, DateTime64(9, 'UTC'))
      )
      ENGINE = AggregatingMergeTree
      ORDER BY (user_id, provider_id, recorded_date)`,
    });
    await client.command({
      query: `CREATE TABLE ${targetTable} (
        user_id UUID,
        provider_id String,
        recorded_date Date,
        metric_stream_count UInt64,
        source_changed_at DateTime64(9, 'UTC'),
        refresh_version UInt64,
        refreshed_at DateTime64(9, 'UTC')
      )
      ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, provider_id, recorded_date)`,
    });
  });

  afterAll(async () => {
    await client?.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await client?.close?.();
  });

  it("converges bounded day batches across replacement, tombstone, resurrection, and late rows", async () => {
    const userId = randomUUID();
    const providerId = "test_provider";
    const replacedId = randomUUID();
    const deletedId = randomUUID();
    const resurrectedId = randomUUID();
    const dayOne = "2026-08-01";
    const dayTwo = "2026-08-02";

    await insertMetricRow(client, rawTable, userId, providerId, {
      id: replacedId,
      recordedAt: `${dayOne} 08:00:00`,
      ingestedAt: `${dayOne} 08:01:00`,
      version: 1,
      isDeleted: 0,
    });
    await insertMetricRow(client, rawTable, userId, providerId, {
      id: replacedId,
      recordedAt: `${dayOne} 08:00:00`,
      ingestedAt: `${dayOne} 08:02:00`,
      version: 2,
      isDeleted: 0,
    });
    await insertMetricRow(client, rawTable, userId, providerId, {
      id: deletedId,
      recordedAt: `${dayOne} 09:00:00`,
      ingestedAt: `${dayOne} 09:01:00`,
      version: 1,
      isDeleted: 0,
    });
    await insertMetricRow(client, rawTable, userId, providerId, {
      id: deletedId,
      recordedAt: `${dayOne} 09:00:00`,
      ingestedAt: `${dayOne} 09:02:00`,
      version: 2,
      isDeleted: 1,
    });
    await insertMetricRow(client, rawTable, userId, providerId, {
      id: resurrectedId,
      recordedAt: `${dayOne} 10:00:00`,
      ingestedAt: `${dayOne} 10:01:00`,
      version: 1,
      isDeleted: 0,
    });
    await insertMetricRow(client, rawTable, userId, providerId, {
      id: resurrectedId,
      recordedAt: `${dayOne} 10:00:00`,
      ingestedAt: `${dayOne} 10:02:00`,
      version: 2,
      isDeleted: 1,
    });
    await insertMetricRow(client, rawTable, userId, providerId, {
      id: resurrectedId,
      recordedAt: `${dayOne} 10:00:00`,
      ingestedAt: `${dayOne} 10:03:00`,
      version: 3,
      isDeleted: 0,
    });

    const fullyDeletedDayId = randomUUID();
    await insertMetricRow(client, rawTable, userId, providerId, {
      id: fullyDeletedDayId,
      recordedAt: `${dayTwo} 08:00:00`,
      ingestedAt: `${dayTwo} 08:01:00`,
      version: 1,
      isDeleted: 0,
    });
    await insertMetricRow(client, rawTable, userId, providerId, {
      id: fullyDeletedDayId,
      recordedAt: `${dayTwo} 08:00:00`,
      ingestedAt: `${dayTwo} 08:02:00`,
      version: 2,
      isDeleted: 1,
    });

    await insertDayMarker(client, markerTable, userId, providerId, dayOne, `${dayOne} 12:00:00`);
    await insertDayMarker(client, markerTable, userId, providerId, dayTwo, `${dayOne} 13:00:00`);

    const runModel = async (isIncremental: boolean): Promise<void> => {
      await client.command({
        query: `INSERT INTO ${targetTable} (
          user_id,
          provider_id,
          recorded_date,
          metric_stream_count,
          source_changed_at,
          refresh_version,
          refreshed_at
        )
        ${renderProviderMetricStreamDailySql(
          rawTable,
          markerTable,
          targetTable,
          isIncremental,
          1,
        )}`,
      });
    };

    const readRows = async () => {
      const result = await client.query({
        query: `SELECT
          toString(user_id) AS user_id,
          provider_id,
          toString(recorded_date) AS recorded_date,
          metric_stream_count,
          toUnixTimestamp64Nano(source_changed_at) AS source_changed_at,
          toUnixTimestamp64Nano(refreshed_at) AS refreshed_at
        FROM ${targetTable} FINAL
        WHERE ${targetTable}.user_id = {userId:UUID}
        ORDER BY recorded_date`,
        query_params: { userId },
        format: "JSONEachRow",
      });
      return dailyRowsSchema.parse(await result.json());
    };

    const readDirtyDayCount = async () => {
      const modelSql = renderProviderMetricStreamDailySql(
        rawTable,
        markerTable,
        targetTable,
        true,
        100,
      );
      const sourceDayChangesSql = extractCteSql(modelSql, "source_day_changes");
      const existingDailyStateSql = extractCteSql(modelSql, "existing_daily_state");
      const dirtyDaysSql = extractCteSql(modelSql, "dirty_days");
      const result = await client.query({
        query: `WITH source_day_changes AS (
          ${sourceDayChangesSql}
        ), existing_daily_state AS (
          ${existingDailyStateSql}
        ), dirty_days AS (
          ${dirtyDaysSql}
        )
        SELECT count() AS count
        FROM dirty_days
        WHERE dirty_days.user_id = {userId:UUID}`,
        query_params: { userId },
        format: "JSONEachRow",
      });
      return countSchema.parse(await result.json())[0]?.count ?? 0;
    };

    await runModel(false);
    expect(await readRows()).toEqual([
      expect.objectContaining({
        metric_stream_count: 2,
        provider_id: providerId,
        recorded_date: dayOne,
        source_changed_at: 1_785_585_600_000_000_000n,
        user_id: userId,
      }),
    ]);
    expect(await readDirtyDayCount()).toBe(1);

    await runModel(true);
    const afterSecondBatch = await readRows();
    expect(afterSecondBatch).toHaveLength(2);
    expect(afterSecondBatch).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metric_stream_count: 2, recorded_date: dayOne }),
        expect.objectContaining({ metric_stream_count: 0, recorded_date: dayTwo }),
      ]),
    );
    expect(await readDirtyDayCount()).toBe(0);

    const lateId = randomUUID();
    await insertMetricRow(client, rawTable, userId, providerId, {
      id: lateId,
      recordedAt: `${dayOne} 11:00:00`,
      ingestedAt: `${dayTwo} 09:00:00`,
      version: 1,
      isDeleted: 0,
    });
    await insertDayMarker(client, markerTable, userId, providerId, dayOne, `${dayTwo} 09:01:00`);
    const dayTwoRefreshBeforeLateRow = afterSecondBatch.find(
      (row) => row.recorded_date === dayTwo,
    )?.refreshed_at;

    await runModel(true);
    const afterLateRow = await readRows();
    expect(afterLateRow).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metric_stream_count: 3, recorded_date: dayOne }),
        expect.objectContaining({
          metric_stream_count: 0,
          recorded_date: dayTwo,
          refreshed_at: dayTwoRefreshBeforeLateRow,
        }),
      ]),
    );
    expect(await readDirtyDayCount()).toBe(0);

    await insertMetricRow(client, rawTable, userId, providerId, {
      id: replacedId,
      recordedAt: `${dayOne} 08:00:00`,
      ingestedAt: `${dayTwo} 10:00:00`,
      version: 3,
      isDeleted: 1,
    });
    await insertDayMarker(client, markerTable, userId, providerId, dayOne, `${dayTwo} 10:01:00`);
    await runModel(true);
    expect(
      (await readRows()).find((row) => row.recorded_date === dayOne)?.metric_stream_count,
    ).toBe(2);

    await insertMetricRow(client, rawTable, userId, providerId, {
      id: replacedId,
      recordedAt: `${dayOne} 08:00:00`,
      ingestedAt: `${dayTwo} 11:00:00`,
      version: 4,
      isDeleted: 0,
    });
    await insertDayMarker(client, markerTable, userId, providerId, dayOne, `${dayTwo} 11:01:00`);
    await runModel(true);
    expect(
      (await readRows()).find((row) => row.recorded_date === dayOne)?.metric_stream_count,
    ).toBe(3);
  });

  it("keeps the recorded-at projection available for selected-day scans", async () => {
    const result = await client.query({
      query: `SELECT
          count() AS active_parts,
          countIf(NOT has(
          projections,
          {projectionName:String}
        )) AS missing_projection_parts
        FROM system.parts
        WHERE active
          AND database = {database:String}
          AND table = 'metric_stream'`,
      query_params: {
        database,
        projectionName: METRIC_STREAM_PROVIDER_CURRENT_STATE_RECORDED_AT_PROJECTION,
      },
      format: "JSONEachRow",
    });
    expect(projectionPartSchema.parse(await result.json())).toEqual([
      { active_parts: expect.any(Number), missing_projection_parts: 0 },
    ]);
  });
});
