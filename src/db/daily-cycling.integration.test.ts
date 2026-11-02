import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClickHouseClientFromEnv } from "./clickhouse.ts";
import { readModelSql, renderDbtModelSql } from "./read-model-sql-test-helpers.ts";

describe("daily cycling activity projection", () => {
  const database = `daily_cycling_${randomUUID().replaceAll("-", "")}`;
  const client = createClickHouseClientFromEnv();
  const userId = randomUUID();
  const activityId = randomUUID();
  beforeAll(async () => {
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: `CREATE TABLE ${database}.cycling_activity (
        activity_id UUID,user_id UUID,started_at DateTime64(6,'UTC'),ended_at Nullable(DateTime64(6,'UTC')),
        elapsed_seconds Float64,average_heart_rate Nullable(Float64),max_heart_rate Nullable(Float64),
        average_power Nullable(Float64),power_samples UInt64,heart_rate_samples UInt64,
        activity_name Nullable(String),is_deleted UInt8,refresh_version UInt64,refreshed_at DateTime64(9,'UTC')
      ) ENGINE=ReplacingMergeTree(refresh_version) ORDER BY (user_id,activity_id)`,
    });
  });
  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await client.close?.();
  });
  it("preserves completed power-only rides with nullable heart rate and the activity name", async () => {
    await client.command({
      query: `INSERT INTO ${database}.cycling_activity VALUES ('${activityId}','${userId}','2026-01-01 12:00:00','2026-01-01 13:00:00',3600,NULL,NULL,220,3600,0,'Power ride',0,1,now64(9))`,
    });
    const modelSql = renderDbtModelSql(readModelSql("daily_cycling.sql"), {
      isIncremental: false,
    }).replaceAll("{{ ref('cycling_activity') }}", `${database}.cycling_activity`);
    const result = await client.query({
      query: `SELECT activities FROM (${modelSql})`,
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([
      {
        activities: [
          [activityId, "2026-01-01 12:00:00.000000", 60, null, null, 220, 3600, 0, "Power ride"],
        ],
      },
    ]);
  });
});
