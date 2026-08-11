import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { readModelSql } from "../../../../analytics/models/read_models/read-model-sql-test-helpers.ts";
import {
  type ClickHouseClient,
  createClickHouseClientFromEnv,
} from "../../../../src/db/clickhouse.ts";

const resultSchema = z.array(
  z.object({
    provider_type: z.string().nullable(),
    modality: z.string().nullable(),
  }),
);

function renderCyclingActivitySql(database: string): string {
  return readModelSql("cycling_activity.sql")
    .replace(/\{\{\s*config\([\s\S]*?\)\s*\}\}\s*/g, "")
    .replace(/\{\{\s*ref\('activity_summary_rows'\)\s*\}\}/g, `${database}.activity_summary_rows`)
    .replace(/\{\{\s*ref\('deduped_activities'\)\s*\}\}/g, `${database}.deduped_activities`)
    .replace(
      /\{\{\s*ref\('activity_aerobic_efficiency'\)\s*\}\}/g,
      `${database}.activity_aerobic_efficiency`,
    )
    .replace(
      /\{%\s*if is_incremental\(\)\s*%\}([\s\S]*?)(?:\{%\s*else\s*%\}([\s\S]*?))?\{%\s*endif\s*%\}/g,
      (_, incrementalSql: string, nonIncrementalSql: string | undefined) =>
        nonIncrementalSql ?? incrementalSql,
    )
    .trim();
}

describe("cycling_activity read model", () => {
  const database = `cycling_activity_${randomUUID().replaceAll("-", "")}`;
  const activityId = "11111111-1111-4111-8111-111111111111";
  const userId = "22222222-2222-4222-8222-222222222222";
  let client: ClickHouseClient;

  beforeAll(async () => {
    client = createClickHouseClientFromEnv();
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: `CREATE TABLE ${database}.activity_summary_rows (
        activity_id UUID,
        user_id UUID,
        canonical_type Nullable(String),
        provider_type Nullable(String),
        modality Nullable(String),
        name Nullable(String),
        started_at Nullable(DateTime64(6, 'UTC')),
        ended_at Nullable(DateTime64(6, 'UTC')),
        total_distance Nullable(Float64),
        avg_hr Nullable(Float64),
        max_hr Nullable(Int16),
        avg_power Nullable(Float64),
        power_sample_count Nullable(UInt64),
        hr_sample_count Nullable(UInt64),
        normalized_power Nullable(Float64),
        best_twenty_minute_power Nullable(Float64),
        elevation_gain_m Nullable(Float64),
        refreshed_at DateTime64(9, 'UTC'),
        is_deleted UInt8
      ) ENGINE = MergeTree ORDER BY (user_id, activity_id)`,
    });
    await client.command({
      query: `CREATE TABLE ${database}.deduped_activities (
        activity_id UUID,
        user_id UUID,
        provider_id Nullable(String),
        source_providers Array(String),
        refreshed_at DateTime64(9, 'UTC'),
        is_deleted UInt8
      ) ENGINE = MergeTree ORDER BY (user_id, activity_id)`,
    });
    await client.command({
      query: `CREATE TABLE ${database}.activity_aerobic_efficiency (
        activity_id UUID,
        user_id UUID,
        max_hr Nullable(Float64),
        avg_power_z2 Nullable(Float64),
        avg_hr_z2 Nullable(Float64),
        efficiency_factor Nullable(Float64),
        z2_samples Nullable(UInt64),
        refreshed_at DateTime64(9, 'UTC'),
        is_deleted UInt8
      ) ENGINE = MergeTree ORDER BY (user_id, activity_id)`,
    });
    await client.command({
      query: `INSERT INTO ${database}.activity_summary_rows
        (activity_id, user_id, canonical_type, provider_type, modality, name, started_at,
         ended_at, refreshed_at, is_deleted)
        VALUES
        ('${activityId}', '${userId}', 'cycling', 'road_cycling', '', 'Outdoor Ride',
         '2026-08-10 10:00:00', '2026-08-10 11:00:00', now64(9, 'UTC'), 0)`,
    });
    await client.command({
      query: `INSERT INTO ${database}.deduped_activities
        (activity_id, user_id, provider_id, source_providers, refreshed_at, is_deleted)
        VALUES
        ('${activityId}', '${userId}', 'wahoo', ['wahoo'], now64(9, 'UTC'), 0)`,
    });
  });

  afterAll(async () => {
    await client?.command({ query: `DROP DATABASE IF EXISTS ${database}` });
  });

  it("serves empty source modalities as NULL", async () => {
    const result = await client.query({
      query: `SELECT provider_type, modality
        FROM (${renderCyclingActivitySql(database)})
        SETTINGS join_use_nulls = 1, max_threads = 1`,
      format: "JSONEachRow",
    });

    expect(resultSchema.parse(await result.json())).toEqual([
      { provider_type: "road_cycling", modality: null },
    ]);
  });
});
