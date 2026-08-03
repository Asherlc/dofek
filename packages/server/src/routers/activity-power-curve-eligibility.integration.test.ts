import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  extractCteSql,
  readModelSql,
} from "../../../../analytics/models/read_models/read-model-sql-test-helpers.ts";
import {
  type ClickHouseClient,
  createClickHouseClientFromEnv,
} from "../../../../src/db/clickhouse.ts";

const activityKeySchema = z.array(z.object({ activity_id: z.string() }));

function renderDirtyActivityKeysSql(analyticsDatabase: string, targetTable: string): string {
  const modelSql = readModelSql("activity_power_curve.sql");
  const cteNames = [
    "current_activity",
    "current_power_activity",
    "existing_activity_state",
    "source_dirty_activity_keys",
  ] as const;
  const commonTableExpressions = cteNames.map((name) => {
    const sql = extractCteSql(modelSql, name)
      .replace(
        /\{\{\s*ref\('activity_summary_rows'\)\s*\}\}/g,
        `${analyticsDatabase}.activity_summary_rows`,
      )
      .replace(/\{\{\s*this\s*\}\}/g, targetTable);
    return `${name} AS (${sql})`;
  });

  return `WITH ${commonTableExpressions.join(",\n")}
SELECT toString(activity_id) AS activity_id
FROM source_dirty_activity_keys
ORDER BY activity_id
SETTINGS join_use_nulls = 1`;
}

describe("activity power-curve eligibility", () => {
  const analyticsDatabase = `analytics_power_${randomUUID().replaceAll("-", "")}`;
  const targetTable = `${analyticsDatabase}.activity_power_curve`;
  let client: ClickHouseClient;

  beforeAll(async () => {
    client = createClickHouseClientFromEnv();
    await client.command({ query: `CREATE DATABASE ${analyticsDatabase}` });
    await client.command({
      query: `CREATE TABLE ${analyticsDatabase}.activity_summary_rows (
        activity_id UUID,
        user_id UUID,
        canonical_type String,
        started_at DateTime64(6, 'UTC'),
        ended_at Nullable(DateTime64(6, 'UTC')),
        is_deleted UInt8,
        power_sample_count Nullable(UInt64),
        refreshed_at DateTime64(9, 'UTC')
      ) ENGINE = ReplacingMergeTree(refreshed_at)
      ORDER BY (user_id, activity_id)`,
    });
    await client.command({
      query: `CREATE TABLE ${targetTable} (
        activity_id UUID,
        user_id UUID,
        is_deleted UInt8,
        refreshed_at DateTime64(9, 'UTC')
      ) ENGINE = ReplacingMergeTree(refreshed_at)
      ORDER BY (user_id, activity_id)`,
    });
  });

  beforeEach(async () => {
    await client.command({ query: `TRUNCATE TABLE ${analyticsDatabase}.activity_summary_rows` });
    await client.command({ query: `TRUNCATE TABLE ${targetTable}` });
  });

  afterAll(async () => {
    await client?.command({ query: `DROP DATABASE IF EXISTS ${analyticsDatabase}` });
  });

  it("schedules powered activities but not activities without valid power", async () => {
    const userId = randomUUID();
    const poweredActivityId = randomUUID();
    const noPowerActivityId = randomUUID();

    await client.command({
      query: `INSERT INTO ${analyticsDatabase}.activity_summary_rows VALUES
        (
          {poweredActivityId:UUID}, {userId:UUID}, 'cycling',
          now64(6) - INTERVAL 1 HOUR, now64(6), 0, 2, now64(9)
        ),
        (
          {noPowerActivityId:UUID}, {userId:UUID}, 'cycling',
          now64(6) - INTERVAL 2 HOUR, now64(6) - INTERVAL 1 HOUR, 0, 0, now64(9)
        )`,
      query_params: { noPowerActivityId, poweredActivityId, userId },
    });

    const result = await client.query({
      query: renderDirtyActivityKeysSql(analyticsDatabase, targetTable),
      format: "JSONEachRow",
    });

    expect(activityKeySchema.parse(await result.json())).toEqual([
      { activity_id: poweredActivityId },
    ]);
  });

  it("does not schedule an activity whose latest summary has no valid power", async () => {
    const userId = randomUUID();
    const activityId = randomUUID();

    await client.command({
      query: `INSERT INTO ${analyticsDatabase}.activity_summary_rows VALUES
        (
          {activityId:UUID}, {userId:UUID}, 'cycling',
          now64(6) - INTERVAL 1 HOUR, now64(6), 0, 2,
          toDateTime64('2026-07-25 00:00:00', 9, 'UTC')
        ),
        (
          {activityId:UUID}, {userId:UUID}, 'cycling',
          now64(6) - INTERVAL 1 HOUR, now64(6), 0, 0,
          toDateTime64('2026-07-25 00:01:00', 9, 'UTC')
        )`,
      query_params: { activityId, userId },
    });

    const result = await client.query({
      query: renderDirtyActivityKeysSql(analyticsDatabase, targetTable),
      format: "JSONEachRow",
    });

    expect(activityKeySchema.parse(await result.json())).not.toContainEqual({
      activity_id: activityId,
    });
  });
});
