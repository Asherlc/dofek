import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClickHouseClientFromEnv } from "./clickhouse.ts";
import {
  buildActivitySummaryRowsTableSql,
  buildActivitySummaryViewSql,
} from "./clickhouse-activity-summary.ts";

describe("activity summary canonical power serving", () => {
  const database = `summary_power_${randomUUID().replaceAll("-", "")}`;
  const client = createClickHouseClientFromEnv();
  const userId = randomUUID();
  const activityId = randomUUID();
  beforeAll(async () => {
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: buildActivitySummaryRowsTableSql().replaceAll("analytics.", `${database}.`),
    });
    await client.command({
      query: `CREATE TABLE ${database}.cycling_power_observation_rows (
      user_id UUID, activity_id UUID, normalized_power Nullable(Float64), source_refresh_version UInt64,
      is_deleted UInt8, refresh_version UInt64
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id)`,
    });
    await client.command({
      query: buildActivitySummaryViewSql().replaceAll("analytics.", `${database}.`),
    });
  });
  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close?.();
  });
  async function power(): Promise<number | null> {
    const result = await client.query<{ normalized_power: number | null }>({
      query: `SELECT normalized_power FROM ${database}.activity_summary WHERE activity_id = '${activityId}' AND user_id = '${userId}'`,
      format: "JSONEachRow",
    });
    const rows = await result.json();
    expect(rows).toHaveLength(1);
    return rows[0]?.normalized_power ?? null;
  }
  async function observation(
    normalized: number,
    sourceVersion: number,
    version: number,
    deleted = 0,
  ) {
    await client.command({
      query: `INSERT INTO ${database}.cycling_power_observation_rows VALUES ('${userId}', '${activityId}', ${normalized}, ${sourceVersion}, ${deleted}, ${version})`,
    });
  }
  it("serves current canonical NP for non-cycling activities and preserves missing and measured zero", async () => {
    await client.command({
      query: `INSERT INTO ${database}.activity_summary_rows (user_id,activity_id,canonical_type,started_at,ended_at,refresh_version,is_deleted,refreshed_at) VALUES ('${userId}','${activityId}','running','2026-01-01 12:00:00','2026-01-01 13:00:00',20,0,now64(9))`,
    });
    await observation(220, 20, 1);
    expect(await power()).toBe(220);
    await client.command({
      query: `INSERT INTO ${database}.activity_summary_rows SELECT * REPLACE(toUInt64(30) AS refresh_version) FROM ${database}.activity_summary_rows FINAL WHERE activity_id='${activityId}'`,
    });
    expect(await power()).toBeNull();
    await observation(0, 31, 2);
    expect(await power()).toBe(0);
    await observation(0, 31, 3, 1);
    expect(await power()).toBeNull();
  });
});
