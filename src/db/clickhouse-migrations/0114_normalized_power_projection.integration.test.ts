import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ANALYTICS_PUBLICATION_RESOURCE,
  withAnalyticsQueryOwner,
} from "../../analytics/analytics-query-owner.ts";
import { cyclingPowerPolicy } from "../../analytics/cycling-power-policy.ts";
import { projectCyclingPower } from "../../analytics/cycling-power-projector.ts";
import { buildAccountErasureFenceTableSql } from "../../metric-stream/clickhouse-table.ts";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../clickhouse.ts";
import { setupTestDatabase, type TestContext } from "../test-helpers.ts";
import { createMigration } from "./0114_normalized_power_projection.ts";
import { cyclingPowerSchemaStatementsBefore0114 } from "./cycling-power-schema-before-0114.ts";

describe("normalized-power projection migration", () => {
  let context: TestContext;
  const real = createClickHouseClientFromEnv();
  const database = `cycling_projection_cutover_${randomUUID().replaceAll("-", "")}`;
  const rewrite = (query: string) =>
    query
      .replaceAll("analytics.", `${database}.`)
      .replaceAll("ingest.account_erasure_fence", `${database}.account_erasure_fence`);
  const insert = real.insert;
  if (!insert) throw new Error("Test client requires insert support");
  const client = {
    exec: (options) => real.exec({ ...options, query: rewrite(options.query) }),
    command: (options) => real.command({ ...options, query: rewrite(options.query) }),
    query: (options) => real.query({ ...options, query: rewrite(options.query) }),
    insert: (options) => insert.call(real, { ...options, table: rewrite(options.table) }),
  } satisfies ClickHouseClient;
  const userId = randomUUID();
  const activityId = randomUUID();
  const asOf = new Date("2026-11-01T12:00:00Z");

  beforeAll(async () => {
    context = await setupTestDatabase();
    await real.command({ query: `CREATE DATABASE ${database}` });
    await client.command({ query: buildAccountErasureFenceTableSql() });
    await client.command({
      query: `CREATE TABLE analytics.activity_summary_rows
      (user_id UUID,activity_id UUID,started_at DateTime64(6,'UTC'),ended_at Nullable(DateTime64(6,'UTC')),
       canonical_type Nullable(String),power_sample_count Nullable(UInt64),refresh_version UInt64,is_deleted UInt8)
      ENGINE=ReplacingMergeTree(refresh_version) ORDER BY (user_id,activity_id)`,
    });
    await client.command({
      query: `CREATE TABLE analytics.activity_sensor_sample
      (user_id UUID,activity_id UUID,recorded_at DateTime64(6,'UTC'),channel String,scalar Nullable(Float64),
       refresh_version UInt64,is_deleted UInt8)
      ENGINE=ReplacingMergeTree(refresh_version) ORDER BY (user_id,activity_id,channel,recorded_at)`,
    });
    await client.command({
      query: `CREATE TABLE analytics.activity_power_curve
      (user_id UUID,activity_id UUID,duration_seconds UInt32,best_power Float64,refresh_version UInt64,is_deleted UInt8)
      ENGINE=ReplacingMergeTree(refresh_version) ORDER BY (user_id,activity_id,duration_seconds)`,
    });
    for (const statement of cyclingPowerSchemaStatementsBefore0114())
      await client.command({ query: statement });
    await client.insert({
      table: "analytics.activity_summary_rows",
      format: "JSONEachRow",
      values: [
        {
          user_id: userId,
          activity_id: activityId,
          started_at: "2026-10-31 10:00:00",
          ended_at: "2026-10-31 10:01:00",
          canonical_type: "cycling",
          power_sample_count: 60,
          refresh_version: 100,
          is_deleted: 0,
        },
      ],
    });
    await client.insert({
      table: "analytics.activity_sensor_sample",
      format: "JSONEachRow",
      values: Array.from({ length: 60 }, (_, second) => ({
        user_id: userId,
        activity_id: activityId,
        recorded_at: `2026-10-31 10:00:${String(second).padStart(2, "0")}`,
        channel: "power",
        scalar: 250,
        refresh_version: 100,
        is_deleted: 0,
      })),
    });
    await client.insert({
      table: "analytics.activity_power_curve",
      format: "JSONEachRow",
      values: [
        {
          user_id: userId,
          activity_id: activityId,
          duration_seconds: 60,
          best_power: 250,
          refresh_version: 100,
          is_deleted: 0,
        },
      ],
    });
    await client.insert({
      table: "analytics.cycling_power_observation_rows",
      format: "JSONEachRow",
      values: [
        {
          user_id: userId,
          activity_id: activityId,
          normalized_power: 250,
          source_refresh_version: 100,
          model_version: "elapsed-power-full-30s-v1:10:5:2:10",
          is_deleted: 0,
          refresh_version: 200,
          refreshed_at: "2026-11-01 12:00:00",
        },
      ],
    });
  });

  afterAll(async () => {
    await real.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await real.close?.();
    await context?.cleanup();
  });

  it("replaces history serving and reuses current observations without raw-sensor replay", async () => {
    const statements = createMigration().statements;
    for (const statement of statements) await client.command({ query: statement });
    for (const statement of statements) await client.command({ query: statement });

    const servingRows = await client
      .query<{ normalized_power: number; activity_id: string; canonical_type: string }>({
        query: `SELECT normalized_power,activity_id,canonical_type
          FROM analytics.cycling_activity_power_metrics WHERE user_id={userId:UUID}`,
        format: "JSONEachRow",
        query_params: { userId },
      })
      .then((result) => result.json());
    expect(servingRows).toEqual([
      { normalized_power: 250, activity_id: activityId, canonical_type: "cycling" },
    ]);

    let rawSampleReads = 0;
    let observationWrites = 0;
    const measuredClient: typeof client = {
      ...client,
      query: (options) => {
        if (options.query.startsWith("SELECT toFloat64(toUnixTimestamp64Milli(recorded_at))"))
          rawSampleReads += 1;
        return client.query(options);
      },
      exec: (options) => {
        if (options.query.startsWith("INSERT INTO analytics.cycling_power_observation_rows"))
          observationWrites += 1;
        return client.exec(options);
      },
    };
    const projection = await withAnalyticsQueryOwner(
      context.db,
      measuredClient,
      { resourceId: ANALYTICS_PUBLICATION_RESOURCE, intentId: `cutover-fixture:${database}` },
      (owner) => projectCyclingPower(owner, cyclingPowerPolicy, asOf),
    );
    expect(projection).toEqual({ pendingActivities: 0 });
    expect(rawSampleReads).toBe(0);
    expect(observationWrites).toBe(0);
  });
});
