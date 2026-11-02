import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ClickHouseClient,
  createClickHouseClientFromEnv,
} from "../../../../src/db/clickhouse.ts";
import { buildActivitySensorSummaryRowsTableSql } from "../../../../src/db/clickhouse-activity-sensor-summary.ts";
import { readModelSql, renderDbtModelSql } from "../../../../src/db/read-model-sql-test-helpers.ts";

const summaryRowSchema = z.object({
  activity_id: z.string(),
  elevation_gain_m: z.coerce.number().nullable(),
  elevation_loss_m: z.coerce.number().nullable(),
});

function renderActivitySensorSummarySql(targetTable: string, analyticsDatabase: string): string {
  return renderDbtModelSql(readModelSql("activity_sensor_summary_rows.sql"), {
    isIncremental: false,
    activityRefreshScoped: false,
  })
    .replaceAll("{{ this }}", targetTable)
    .replaceAll("{{ initial_lookback_days }}", "3650")
    .replace(
      /\{\{\s*ref\('deduped_activities'\)\s*\}\}/g,
      `${analyticsDatabase}.deduped_activities`,
    )
    .replace(
      /\{\{\s*ref\('activity_sensor_sample'\)\s*\}\}/g,
      `${analyticsDatabase}.activity_sensor_sample`,
    )
    .trimStart();
}

describe("activity_sensor_summary_rows read model", () => {
  const analyticsDatabase = `analytics_activity_sensor_${randomUUID().replaceAll("-", "")}`;
  const targetTable = `${analyticsDatabase}.activity_sensor_summary_rows`;
  let client: ClickHouseClient | undefined;

  beforeAll(async () => {
    client = createClickHouseClientFromEnv();
    await client.command({ query: `CREATE DATABASE ${analyticsDatabase}` });
    await client.command({
      query: `CREATE TABLE ${analyticsDatabase}.deduped_activities (
        activity_id UUID,
        user_id UUID,
        started_at DateTime64(6, 'UTC'),
        is_deleted UInt8
      ) ENGINE = ReplacingMergeTree()
      ORDER BY (user_id, activity_id)`,
    });
    await client.command({
      query: `CREATE TABLE ${analyticsDatabase}.activity_sensor_sample (
        activity_id UUID,
        user_id UUID,
        recorded_at DateTime64(6, 'UTC'),
        channel String,
        scalar Nullable(Float64),
        refresh_version UInt64,
        is_deleted UInt8,
        provider_id Nullable(String),
        member_activity_id Nullable(UUID),
        device_id Nullable(String)
      ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, activity_id, channel, recorded_at)`,
    });
    await client.command({
      query: buildActivitySensorSummaryRowsTableSql().replace(
        "analytics.activity_sensor_summary_rows",
        targetTable,
      ),
    });
  }, 120_000);

  afterAll(async () => {
    await client?.command({ query: `DROP DATABASE IF EXISTS ${analyticsDatabase} SYNC` });
    await client?.close?.();
  });

  beforeEach(async () => {
    if (!client) throw new Error("ClickHouse client was not initialized");
    for (const table of [
      "deduped_activities",
      "activity_sensor_sample",
      "activity_sensor_summary_rows",
    ])
      await client.command({ query: `TRUNCATE TABLE ${analyticsDatabase}.${table}` });
  });

  it("includes measured coasting in average power and preserves an observed zero-power ride", async () => {
    if (!client) throw new Error("ClickHouse client was not initialized");
    const userId = randomUUID();
    const mixedId = randomUUID();
    const zeroId = randomUUID();
    for (const activityId of [mixedId, zeroId]) {
      await client.command({
        query: `INSERT INTO ${analyticsDatabase}.deduped_activities VALUES ('${activityId}','${userId}',now64(6)-INTERVAL 1 DAY,0)`,
      });
      await client.command({
        query: `INSERT INTO ${analyticsDatabase}.activity_sensor_sample (activity_id,user_id,recorded_at,channel,scalar,refresh_version,is_deleted)
          SELECT toUUID('${activityId}'),toUUID('${userId}'),now64(6)-INTERVAL 1 DAY+toIntervalSecond(number),'power',
            if('${activityId}'='${zeroId}',0,if(number%2=0,240,0)),1,0 FROM numbers(60)`,
      });
    }
    await client.command({
      query: `INSERT INTO ${targetTable} ${renderActivitySensorSummarySql(targetTable, analyticsDatabase)}`,
    });
    const result = await client.query({
      query: `SELECT toString(summary.activity_id) AS activity_id,avg_power,smoothed_avg_power FROM ${targetTable} AS summary FINAL WHERE summary.activity_id IN {ids:Array(UUID)}`,
      query_params: { ids: [mixedId, zeroId] },
      format: "JSONEachRow",
    });
    const rows = await result.json<{
      activity_id: string;
      avg_power: number | null;
      smoothed_avg_power: number | null;
    }>();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.activity_id === mixedId)?.avg_power).toBe(120);
    expect(rows.find((row) => row.activity_id === zeroId)).toMatchObject({
      avg_power: 0,
      smoothed_avg_power: 0,
    });
  });

  it("preserves unavailable elevation separately from measured ascent and descent", async () => {
    if (!client) throw new Error("ClickHouse client was not initialized");

    const userId = randomUUID();
    const noAltitudeActivityId = randomUUID();
    const singleAltitudeActivityId = randomUUID();
    const ascentActivityId = randomUUID();
    const descentActivityId = randomUUID();

    await client.command({ query: `TRUNCATE TABLE ${targetTable}` });
    await client.command({
      query: `INSERT INTO ${analyticsDatabase}.deduped_activities (
        activity_id, user_id, started_at, is_deleted
      ) VALUES
        ({noAltitudeActivityId:UUID}, {userId:UUID}, now64(6, 'UTC') - INTERVAL 1 DAY, 0),
        ({singleAltitudeActivityId:UUID}, {userId:UUID}, now64(6, 'UTC') - INTERVAL 1 DAY, 0),
        ({ascentActivityId:UUID}, {userId:UUID}, now64(6, 'UTC') - INTERVAL 1 DAY, 0),
        ({descentActivityId:UUID}, {userId:UUID}, now64(6, 'UTC') - INTERVAL 1 DAY, 0)`,
      query_params: {
        noAltitudeActivityId,
        singleAltitudeActivityId,
        ascentActivityId,
        descentActivityId,
        userId,
      },
    });
    await client.command({
      query: `INSERT INTO ${analyticsDatabase}.activity_sensor_sample (
        activity_id, user_id, recorded_at, channel, scalar, refresh_version, is_deleted
      ) VALUES
        ({singleAltitudeActivityId:UUID}, {userId:UUID}, now64(6, 'UTC') - INTERVAL 1 DAY + INTERVAL 1 HOUR, 'altitude', 100, 1, 0),
        ({ascentActivityId:UUID}, {userId:UUID}, now64(6, 'UTC') - INTERVAL 1 DAY + INTERVAL 1 HOUR, 'altitude', 100, 1, 0),
        ({ascentActivityId:UUID}, {userId:UUID}, now64(6, 'UTC') - INTERVAL 1 DAY + INTERVAL 2 HOUR, 'altitude', 110, 1, 0),
        ({descentActivityId:UUID}, {userId:UUID}, now64(6, 'UTC') - INTERVAL 1 DAY + INTERVAL 1 HOUR, 'altitude', 100, 1, 0),
        ({descentActivityId:UUID}, {userId:UUID}, now64(6, 'UTC') - INTERVAL 1 DAY + INTERVAL 2 HOUR, 'altitude', 95, 1, 0)`,
      query_params: { singleAltitudeActivityId, ascentActivityId, descentActivityId, userId },
    });

    await client.command({
      query: `INSERT INTO ${targetTable}
        ${renderActivitySensorSummarySql(targetTable, analyticsDatabase)}
        SETTINGS join_use_nulls = 1, enable_materialized_cte = 1`,
    });

    const result = await client.query({
      query: `SELECT toString(activity_id) AS activity_id, elevation_gain_m, elevation_loss_m
        FROM ${targetTable} FINAL
        ORDER BY activity_id`,
      format: "JSONEachRow",
    });
    const rows = z.array(summaryRowSchema).parse(await result.json());

    expect(
      new Map(
        rows.map((row) => [
          row.activity_id,
          { elevation_gain_m: row.elevation_gain_m, elevation_loss_m: row.elevation_loss_m },
        ]),
      ),
    ).toEqual(
      new Map([
        [noAltitudeActivityId, { elevation_gain_m: null, elevation_loss_m: null }],
        [singleAltitudeActivityId, { elevation_gain_m: null, elevation_loss_m: null }],
        [ascentActivityId, { elevation_gain_m: 10, elevation_loss_m: 0 }],
        [descentActivityId, { elevation_gain_m: 0, elevation_loss_m: 5 }],
      ]),
    );
  });
});
