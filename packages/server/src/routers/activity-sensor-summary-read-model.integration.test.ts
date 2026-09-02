import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { readModelSql } from "../../../../analytics/models/read_models/read-model-sql-test-helpers.ts";
import {
  type ClickHouseClient,
  createClickHouseClientFromEnv,
} from "../../../../src/db/clickhouse.ts";
import { buildActivitySensorSummaryRowsTableSql } from "../../../../src/db/clickhouse-activity-sensor-summary.ts";

const summaryRowSchema = z.object({
  activity_id: z.string(),
  elevation_gain_m: z.coerce.number().nullable(),
  elevation_loss_m: z.coerce.number().nullable(),
});

function renderActivitySensorSummarySql(
  targetTable: string,
  analyticsDatabase: string,
  postgresDatabase: string,
): string {
  return readModelSql("activity_sensor_summary_rows.sql")
    .replace(/\{\{\s*config\([\s\S]*?\)\s*\}\}\s*/, "")
    .replace(/\{%\s*set initial_lookback_days[\s\S]*?%\}\s*/, "")
    .replace(
      /\{%\s*if is_incremental\(\)\s*%\}\s*target_state AS \([\s\S]*?\{%\s*endif\s*%\}\s*/,
      "",
    )
    .replace(
      /\{%\s*if is_incremental\(\)\s*%\}([\s\S]*?)\{%\s*else\s*%\}([\s\S]*?)\{%\s*endif\s*%\}/g,
      (_match, _incrementalSql: string, nonIncrementalSql: string) => nonIncrementalSql,
    )
    .replace(/\{%\s*if is_incremental\(\)\s*%\}[\s\S]*?\{%\s*endif\s*%\}/g, "")
    .replaceAll("{{ this }}", targetTable)
    .replaceAll("{{ initial_lookback_days }}", "3650")
    .replace(
      /\{\{\s*source\('postgres_fitness',\s*'activity'\)\s*\}\}/g,
      `${postgresDatabase}.activity`,
    )
    .replace(
      /\{\{\s*ref\('activity_sensor_sample'\)\s*\}\}/g,
      `${analyticsDatabase}.activity_sensor_sample`,
    )
    .trimStart();
}

describe("activity_sensor_summary_rows read model", () => {
  const analyticsDatabase = `analytics_activity_sensor_${randomUUID().replaceAll("-", "")}`;
  const postgresDatabase = `postgres_activity_sensor_${randomUUID().replaceAll("-", "")}`;
  const targetTable = `${analyticsDatabase}.activity_sensor_summary_rows`;
  let client: ClickHouseClient | undefined;

  beforeAll(async () => {
    client = createClickHouseClientFromEnv();
    await client.command({ query: `CREATE DATABASE ${analyticsDatabase}` });
    await client.command({ query: `CREATE DATABASE ${postgresDatabase}` });
    await client.command({
      query: `CREATE TABLE ${postgresDatabase}.activity (
        id UUID,
        user_id UUID,
        started_at DateTime64(6, 'UTC'),
        provider_absent_at Nullable(DateTime64(6, 'UTC')),
        deleted_at Nullable(DateTime64(6, 'UTC')),
        _peerdb_is_deleted UInt8,
        _peerdb_synced_at DateTime64(9, 'UTC')
      ) ENGINE = ReplacingMergeTree(_peerdb_synced_at)
      ORDER BY (user_id, id)`,
    });
    await client.command({
      query: `CREATE TABLE ${analyticsDatabase}.activity_sensor_sample (
        activity_id UUID,
        user_id UUID,
        recorded_at DateTime64(6, 'UTC'),
        channel String,
        scalar Nullable(Float64),
        refresh_version UInt64,
        is_deleted UInt8
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
    await client?.command({ query: `DROP DATABASE IF EXISTS ${postgresDatabase} SYNC` });
    await client?.close?.();
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
      query: `INSERT INTO ${postgresDatabase}.activity (
        id, user_id, started_at, provider_absent_at, deleted_at,
        _peerdb_is_deleted, _peerdb_synced_at
      ) VALUES
        ({noAltitudeActivityId:UUID}, {userId:UUID}, now64(6, 'UTC') - INTERVAL 1 DAY, NULL, NULL, 0, now64(9, 'UTC')),
        ({singleAltitudeActivityId:UUID}, {userId:UUID}, now64(6, 'UTC') - INTERVAL 1 DAY, NULL, NULL, 0, now64(9, 'UTC')),
        ({ascentActivityId:UUID}, {userId:UUID}, now64(6, 'UTC') - INTERVAL 1 DAY, NULL, NULL, 0, now64(9, 'UTC')),
        ({descentActivityId:UUID}, {userId:UUID}, now64(6, 'UTC') - INTERVAL 1 DAY, NULL, NULL, 0, now64(9, 'UTC'))`,
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
        ${renderActivitySensorSummarySql(targetTable, analyticsDatabase, postgresDatabase)}
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
