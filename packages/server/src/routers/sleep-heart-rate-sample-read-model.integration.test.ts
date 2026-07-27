import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { readModelSql } from "../../../../analytics/models/read_models/read-model-sql-test-helpers.ts";
import {
  type ClickHouseClient,
  createClickHouseClientFromEnv,
} from "../../../../src/db/clickhouse.ts";

const countSchema = z.array(z.object({ count: z.coerce.number().int() }));
const lifecycleSchema = z.array(
  z.object({
    is_deleted: z.coerce.number().int(),
    sleep_id: z.string(),
  }),
);

function renderSleepHeartRateSql(
  targetTable: string,
  analyticsDatabase: string,
  postgresDatabase: string,
  isIncremental: boolean,
): string {
  return readModelSql("sleep_heart_rate_sample.sql")
    .replace(/^\{\{ config\([\s\S]*?\n\) \}\}\s*/, "")
    .replace(/^\{%\s*set [^\n]+\n/gm, "")
    .replaceAll("{{ initial_lookback_days }}", "120")
    .replaceAll("{{ sleep_dirty_key_batch_size }}", "2")
    .replace(/\{\{\s*source\('postgres_fitness',\s*'([^']+)'\)\s*\}\}/g, `${postgresDatabase}.$1`)
    .replace(/\{\{\s*ref\('([^']+)'\)\s*\}\}/g, `${analyticsDatabase}.$1`)
    .replace(
      /\{%\s*if is_incremental\(\)\s*%\}([\s\S]*?)(?:\{%\s*else\s*%\}([\s\S]*?))?\{%\s*endif\s*%\}/g,
      (_, incrementalSql: string, nonIncrementalSql: string | undefined) =>
        isIncremental ? incrementalSql : (nonIncrementalSql ?? ""),
    )
    .replace(/\{\{\s*this\s*\}\}/g, targetTable);
}

describe("sleep heart-rate sample read model", () => {
  const analyticsDatabase = `analytics_sleep_${randomUUID().replaceAll("-", "")}`;
  const postgresDatabase = `postgres_sleep_${randomUUID().replaceAll("-", "")}`;
  let client: ClickHouseClient;

  beforeAll(async () => {
    client = createClickHouseClientFromEnv();
    await client.command({ query: `CREATE DATABASE ${analyticsDatabase}` });
    await client.command({ query: `CREATE DATABASE ${postgresDatabase}` });
    await client.command({
      query: `CREATE TABLE ${postgresDatabase}.sleep_session (
        id UUID,
        user_id UUID,
        started_at DateTime64(6, 'UTC'),
        ended_at Nullable(DateTime64(6, 'UTC')),
        duration_minutes Nullable(Int32),
        sleep_type Nullable(String),
        _peerdb_synced_at DateTime64(9, 'UTC'),
        _peerdb_is_deleted Int8
      ) ENGINE = ReplacingMergeTree(_peerdb_synced_at)
      ORDER BY (user_id, started_at, id)`,
    });
    await client.command({
      query: `CREATE TABLE ${postgresDatabase}.activity (
        id UUID,
        user_id UUID,
        started_at DateTime64(6, 'UTC'),
        ended_at Nullable(DateTime64(6, 'UTC')),
        _peerdb_synced_at DateTime64(9, 'UTC'),
        _peerdb_is_deleted Int8,
        provider_absent_at Nullable(DateTime64(6, 'UTC')),
        deleted_at Nullable(DateTime64(6, 'UTC'))
      ) ENGINE = ReplacingMergeTree(_peerdb_synced_at)
      ORDER BY (user_id, started_at, id)`,
    });
    await client.command({
      query: `CREATE TABLE ${analyticsDatabase}.deduped_sensor (
        user_id UUID,
        recorded_at DateTime64(6, 'UTC'),
        recorded_date Date,
        channel String,
        scalar Nullable(Float32),
        is_deleted UInt8,
        refresh_version UInt64,
        refreshed_at DateTime64(9, 'UTC')
      ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, recorded_date, channel, recorded_at)`,
    });
  });

  afterAll(async () => {
    await client?.command({ query: `DROP DATABASE IF EXISTS ${analyticsDatabase}` });
    await client?.command({ query: `DROP DATABASE IF EXISTS ${postgresDatabase}` });
  });

  it("processes no more than the configured number of dirty sleep keys", async () => {
    const userId = randomUUID();
    const sleepIds = [randomUUID(), randomUUID(), randomUUID()];
    const targetTable = `${analyticsDatabase}.test_sleep_heart_rate`;

    await client.command({
      query: `CREATE TABLE ${targetTable} (
        sleep_id UUID,
        user_id UUID,
        started_at DateTime64(6, 'UTC'),
        ended_at DateTime64(6, 'UTC'),
        duration_seconds Int64,
        recorded_at DateTime64(6, 'UTC'),
        recorded_date Date,
        heart_rate Nullable(Float32),
        refresh_version UInt64,
        is_deleted UInt8,
        refreshed_at DateTime64(9, 'UTC')
      ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, sleep_id, recorded_date, recorded_at)`,
    });

    try {
      for (const [index, sleepId] of sleepIds.entries()) {
        const day = 20 + index;
        const startedAt = `2026-07-${day} 00:00:00`;
        const recordedAt = `2026-07-${day} 00:01:00`;
        const endedAt = `2026-07-${day} 08:00:00`;

        await client.command({
          query: `INSERT INTO ${postgresDatabase}.sleep_session (
            id, user_id, started_at, ended_at, duration_minutes, sleep_type,
            _peerdb_synced_at, _peerdb_is_deleted
          ) VALUES (
            {sleepId:UUID}, {userId:UUID},
            {startedAt:DateTime64(6, 'UTC')}, {endedAt:DateTime64(6, 'UTC')},
            480, 'sleep', now64(9), 0
          )`,
          query_params: {
            endedAt,
            sleepId,
            startedAt,
            userId,
          },
        });
        await client.command({
          query: `INSERT INTO ${analyticsDatabase}.deduped_sensor (
            user_id, recorded_at, recorded_date, channel, scalar,
            is_deleted, refresh_version, refreshed_at
          ) VALUES (
            {userId:UUID}, {recordedAt:DateTime64(6, 'UTC')}, toDate({recordedAt:String}),
            'heart_rate', 60, 0, 1, now64(9)
          )`,
          query_params: { recordedAt, userId },
        });
      }

      const result = await client.query({
        query: `SELECT uniqExact(sleep_id) AS count
          FROM (${renderSleepHeartRateSql(targetTable, analyticsDatabase, postgresDatabase, true)})
          SETTINGS join_use_nulls = 1, enable_materialized_cte = 1`,
        format: "JSONEachRow",
      });

      expect(countSchema.parse(await result.json())).toEqual([{ count: 2 }]);
    } finally {
      await client.command({ query: `DROP TABLE IF EXISTS ${targetTable}` });
      await client.command({ query: `TRUNCATE TABLE ${postgresDatabase}.sleep_session` });
      await client.command({ query: `TRUNCATE TABLE ${analyticsDatabase}.deduped_sensor` });
    }
  });

  it("processes every eligible sleep key during a full refresh", async () => {
    const userId = randomUUID();
    const sleepIds = [randomUUID(), randomUUID(), randomUUID()];
    const targetTable = `${analyticsDatabase}.test_full_refresh_sleep_heart_rate`;

    try {
      for (const [index, sleepId] of sleepIds.entries()) {
        const day = 20 + index;
        const startedAt = `2026-07-${day} 00:00:00`;
        const recordedAt = `2026-07-${day} 00:01:00`;
        const endedAt = `2026-07-${day} 08:00:00`;

        await client.command({
          query: `INSERT INTO ${postgresDatabase}.sleep_session (
            id, user_id, started_at, ended_at, duration_minutes, sleep_type,
            _peerdb_synced_at, _peerdb_is_deleted
          ) VALUES (
            {sleepId:UUID}, {userId:UUID},
            {startedAt:DateTime64(6, 'UTC')}, {endedAt:DateTime64(6, 'UTC')},
            480, 'sleep', now64(9), 0
          )`,
          query_params: {
            endedAt,
            sleepId,
            startedAt,
            userId,
          },
        });
        await client.command({
          query: `INSERT INTO ${analyticsDatabase}.deduped_sensor (
            user_id, recorded_at, recorded_date, channel, scalar,
            is_deleted, refresh_version, refreshed_at
          ) VALUES (
            {userId:UUID}, {recordedAt:DateTime64(6, 'UTC')}, toDate({recordedAt:String}),
            'heart_rate', 60, 0, 1, now64(9)
          )`,
          query_params: { recordedAt, userId },
        });
      }

      const result = await client.query({
        query: `SELECT uniqExact(sleep_id) AS count
          FROM (${renderSleepHeartRateSql(targetTable, analyticsDatabase, postgresDatabase, false)})
          SETTINGS join_use_nulls = 1, enable_materialized_cte = 1`,
        format: "JSONEachRow",
      });

      expect(countSchema.parse(await result.json())).toEqual([{ count: 3 }]);
    } finally {
      await client.command({ query: `TRUNCATE TABLE ${postgresDatabase}.sleep_session` });
      await client.command({ query: `TRUNCATE TABLE ${analyticsDatabase}.deduped_sensor` });
    }
  });

  it("tombstones samples whose sleep is no longer eligible", async () => {
    const userId = randomUUID();
    const sleepId = randomUUID();
    const targetTable = `${analyticsDatabase}.test_stale_sleep_heart_rate`;

    await client.command({
      query: `CREATE TABLE ${targetTable} (
        sleep_id UUID,
        user_id UUID,
        started_at DateTime64(6, 'UTC'),
        ended_at DateTime64(6, 'UTC'),
        duration_seconds Int64,
        recorded_at DateTime64(6, 'UTC'),
        recorded_date Date,
        heart_rate Nullable(Float32),
        refresh_version UInt64,
        is_deleted UInt8,
        refreshed_at DateTime64(9, 'UTC')
      ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, sleep_id, recorded_date, recorded_at)`,
    });

    try {
      await client.command({
        query: `INSERT INTO ${targetTable} VALUES (
          {sleepId:UUID}, {userId:UUID}, '2026-07-20 00:00:00', '2026-07-20 08:00:00',
          28800, '2026-07-20 00:01:00', '2026-07-20', 60, 1, 0, now64(9)
        )`,
        query_params: { sleepId, userId },
      });

      const result = await client.query({
        query: `SELECT toString(sleep_id) AS sleep_id, is_deleted
          FROM (${renderSleepHeartRateSql(targetTable, analyticsDatabase, postgresDatabase, true)})
          WHERE toString(sleep_id) = {sleepId:String}
          SETTINGS join_use_nulls = 1, enable_materialized_cte = 1`,
        query_params: { sleepId },
        format: "JSONEachRow",
      });

      expect(lifecycleSchema.parse(await result.json())).toEqual([
        { is_deleted: 1, sleep_id: sleepId },
      ]);
    } finally {
      await client.command({ query: `DROP TABLE IF EXISTS ${targetTable}` });
    }
  });
});
