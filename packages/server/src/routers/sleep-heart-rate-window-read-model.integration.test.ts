import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ClickHouseClient,
  createClickHouseClientFromEnv,
} from "../../../../src/db/clickhouse.ts";
import { readModelSql } from "../../../../src/db/read-model-sql-test-helpers.ts";

const windowStateSchema = z.array(
  z.object({
    eligible_sample_count: z.coerce.number().int(),
    is_deleted: z.coerce.number().int(),
    sleep_id: z.string(),
  }),
);

function renderSleepHeartRateWindowSql(
  targetTable: string,
  analyticsDatabase: string,
  postgresDatabase: string,
  isIncremental: boolean,
  batchSize = 1,
): string {
  return readModelSql("sleep_heart_rate_window.sql")
    .replace(/\{%\s*set[\s\S]*?%\}\s*/g, "")
    .replace(/\{\{\s*config\([\s\S]*?\)\s*\}\}\s*/g, "")
    .replaceAll("{{ initial_lookback_days }}", "120")
    .replaceAll("{{ sleep_dirty_key_batch_size }}", String(batchSize))
    .replace(/\{\{\s*source\('analytics',\s*'([^']+)'\)\s*\}\}/g, `${analyticsDatabase}.$1`)
    .replace(/\{\{\s*source\('postgres_fitness',\s*'([^']+)'\)\s*\}\}/g, `${postgresDatabase}.$1`)
    .replace(/\{\{\s*ref\('([^']+)'\)\s*\}\}/g, `${analyticsDatabase}.$1`)
    .replace(
      /\{%\s*if is_incremental\(\)\s*%\}([\s\S]*?)(?:\{%\s*else\s*%\}([\s\S]*?))?\{%\s*endif\s*%\}/g,
      (_, incrementalSql: string, nonIncrementalSql: string | undefined) =>
        isIncremental ? incrementalSql : (nonIncrementalSql ?? ""),
    )
    .replace(/\{\{\s*this\s*\}\}/g, targetTable)
    .trimStart();
}

describe("sleep heart-rate window read model", () => {
  const analyticsDatabase = `analytics_sleep_window_${randomUUID().replaceAll("-", "")}`;
  const postgresDatabase = `postgres_sleep_window_${randomUUID().replaceAll("-", "")}`;
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
      ORDER BY (user_id, channel, recorded_date, recorded_at)`,
    });
    await client.command({
      query: `CREATE TABLE ${analyticsDatabase}.heart_rate_day_change (
        user_id UUID,
        recorded_date Date,
        changed_at SimpleAggregateFunction(max, DateTime64(9, 'UTC'))
      ) ENGINE = AggregatingMergeTree
      ORDER BY (user_id, recorded_date)`,
    });
    await client.command({
      query: `CREATE TABLE ${analyticsDatabase}.sleep_heart_rate_cutover (
        cutover_at DateTime64(9, 'UTC')
      ) ENGINE = TinyLog`,
    });
    await client.command({
      query: `INSERT INTO ${analyticsDatabase}.sleep_heart_rate_cutover VALUES (now64(9))`,
    });
  });

  afterAll(async () => {
    await client?.command({ query: `DROP DATABASE IF EXISTS ${analyticsDatabase}` });
    await client?.command({ query: `DROP DATABASE IF EXISTS ${postgresDatabase}` });
  });

  async function createTargetTable(targetTable: string): Promise<void> {
    await client.command({
      query: `CREATE TABLE ${targetTable} (
        sleep_id UUID,
        user_id UUID,
        started_at DateTime64(6, 'UTC'),
        ended_at DateTime64(6, 'UTC'),
        duration_seconds Int64,
        eligible_sample_count UInt64,
        source_changed_at DateTime64(9, 'UTC'),
        refresh_version UInt64,
        is_deleted UInt8,
        refreshed_at DateTime64(9, 'UTC')
      ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, sleep_id)`,
    });
  }

  async function insertWindowBatch(targetTable: string, batchSize = 1): Promise<void> {
    await client.command({
      query: `INSERT INTO ${targetTable}
        ${renderSleepHeartRateWindowSql(
          targetTable,
          analyticsDatabase,
          postgresDatabase,
          true,
          batchSize,
        )}
        SETTINGS join_use_nulls = 1, enable_materialized_cte = 1`,
    });
  }

  it("records an empty exact window so a later dirty sleep converges with batch size one", async () => {
    const userId = randomUUID();
    const emptySleepId = "00000000-0000-4000-8000-000000000001";
    const populatedSleepId = "00000000-0000-4000-8000-000000000002";
    const targetTable = `${analyticsDatabase}.test_empty_window_convergence`;

    await createTargetTable(targetTable);

    try {
      await client.command({
        query: `INSERT INTO ${postgresDatabase}.sleep_session (
          id, user_id, started_at, ended_at, duration_minutes, sleep_type,
          _peerdb_synced_at, _peerdb_is_deleted
        ) VALUES
          ({emptySleepId:UUID}, {userId:UUID}, now64(6) - INTERVAL 2 DAY,
            now64(6) - INTERVAL 2 DAY + INTERVAL 8 HOUR,
            480, 'sleep', now64(9) - INTERVAL 2 DAY, 0),
          ({populatedSleepId:UUID}, {userId:UUID}, now64(6) - INTERVAL 1 DAY,
            now64(6) - INTERVAL 1 DAY + INTERVAL 8 HOUR,
            480, 'sleep', now64(9) - INTERVAL 1 DAY, 0)`,
        query_params: { emptySleepId, populatedSleepId, userId },
      });
      await client.command({
        query: `INSERT INTO ${analyticsDatabase}.heart_rate_day_change VALUES
          ({userId:UUID}, toDate(now()) - 2, now64(9) - INTERVAL 2 DAY),
          ({userId:UUID}, toDate(now()) - 1, now64(9) - INTERVAL 1 DAY)`,
        query_params: { userId },
      });
      await client.command({
        query: `INSERT INTO ${analyticsDatabase}.deduped_sensor VALUES
          ({userId:UUID}, now64(6) - INTERVAL 2 DAY + INTERVAL 10 HOUR,
            toDate(now()) - 2, 'heart_rate', 59, 0, 1, now64(9) - INTERVAL 2 DAY),
          ({userId:UUID}, now64(6) - INTERVAL 1 DAY + INTERVAL 1 HOUR,
            toDate(now()) - 1, 'heart_rate', 61, 0, 1, now64(9) - INTERVAL 1 DAY)`,
        query_params: { userId },
      });

      await insertWindowBatch(targetTable);

      const firstBatchResult = await client.query({
        query: `SELECT
          toString(sleep_id) AS sleep_id,
          eligible_sample_count,
          is_deleted
        FROM ${targetTable} FINAL`,
        format: "JSONEachRow",
      });
      expect(windowStateSchema.parse(await firstBatchResult.json())).toEqual([
        {
          eligible_sample_count: 0,
          is_deleted: 0,
          sleep_id: emptySleepId,
        },
      ]);

      await insertWindowBatch(targetTable);

      const convergedResult = await client.query({
        query: `SELECT
          toString(sleep_id) AS sleep_id,
          eligible_sample_count,
          is_deleted
        FROM ${targetTable} FINAL
        ORDER BY sleep_id`,
        format: "JSONEachRow",
      });
      expect(windowStateSchema.parse(await convergedResult.json())).toEqual([
        {
          eligible_sample_count: 0,
          is_deleted: 0,
          sleep_id: emptySleepId,
        },
        {
          eligible_sample_count: 1,
          is_deleted: 0,
          sleep_id: populatedSleepId,
        },
      ]);
    } finally {
      await client.command({ query: `DROP TABLE IF EXISTS ${targetTable}` });
      await client.command({ query: `TRUNCATE TABLE ${postgresDatabase}.sleep_session` });
      await client.command({ query: `TRUNCATE TABLE ${analyticsDatabase}.deduped_sensor` });
      await client.command({ query: `TRUNCATE TABLE ${analyticsDatabase}.heart_rate_day_change` });
    }
  });

  it("keeps existing historical rows while a bounded bootstrap adds recent sleeps", async () => {
    const userId = randomUUID();
    const historicalSleepId = randomUUID();
    const recentSleepId = randomUUID();
    const targetTable = `${analyticsDatabase}.test_partial_bootstrap_preserves_history`;

    await createTargetTable(targetTable);

    try {
      await client.command({
        query: `INSERT INTO ${targetTable} VALUES (
          {historicalSleepId:UUID}, {userId:UUID},
          '2020-01-01 00:00:00', '2020-01-01 08:00:00', 28800, 0,
          '2020-01-01 09:00:00', 1, 0, '2020-01-01 09:00:00'
        )`,
        query_params: { historicalSleepId, userId },
      });
      await client.command({
        query: `INSERT INTO ${postgresDatabase}.sleep_session (
          id, user_id, started_at, ended_at, duration_minutes, sleep_type,
          _peerdb_synced_at, _peerdb_is_deleted
        ) VALUES
          ({historicalSleepId:UUID}, {userId:UUID},
            '2020-01-01 00:00:00', '2020-01-01 08:00:00',
            480, 'sleep', '2020-01-01 09:00:00', 0),
          ({recentSleepId:UUID}, {userId:UUID},
            now64(6) - INTERVAL 1 DAY, now64(6) - INTERVAL 16 HOUR,
            480, 'sleep', now64(9), 0)`,
        query_params: { historicalSleepId, recentSleepId, userId },
      });

      await insertWindowBatch(targetTable);

      const result = await client.query({
        query: `SELECT count() AS count FROM ${targetTable} FINAL`,
        format: "JSONEachRow",
      });
      expect(
        z.array(z.object({ count: z.coerce.number().int() })).parse(await result.json()),
      ).toEqual([{ count: 2 }]);
    } finally {
      await client.command({ query: `DROP TABLE IF EXISTS ${targetTable}` });
      await client.command({ query: `TRUNCATE TABLE ${postgresDatabase}.sleep_session` });
    }
  });

  it("emits a tombstone only for a previously live sleep that left the source lifecycle", async () => {
    const userId = randomUUID();
    const sleepId = randomUUID();
    const targetTable = `${analyticsDatabase}.test_window_tombstone`;

    await createTargetTable(targetTable);

    try {
      await client.command({
        query: `INSERT INTO ${targetTable} VALUES (
          {sleepId:UUID}, {userId:UUID},
          '2026-07-20 00:00:00', '2026-07-20 08:00:00', 28800, 0,
          '2026-07-20 09:00:00', 1, 0, '2026-07-20 09:00:00'
        )`,
        query_params: { sleepId, userId },
      });
      await client.command({
        query: `INSERT INTO ${postgresDatabase}.sleep_session (
          id, user_id, started_at, ended_at, duration_minutes, sleep_type,
          _peerdb_synced_at, _peerdb_is_deleted
        ) VALUES (
          {sleepId:UUID}, {userId:UUID},
          '2026-07-20 00:00:00', '2026-07-20 08:00:00',
          480, 'sleep', now64(9), 1
        )`,
        query_params: { sleepId, userId },
      });

      await insertWindowBatch(targetTable);

      const result = await client.query({
        query: `SELECT
          toString(sleep_id) AS sleep_id,
          eligible_sample_count,
          is_deleted
        FROM ${targetTable} FINAL`,
        format: "JSONEachRow",
      });
      expect(windowStateSchema.parse(await result.json())).toEqual([
        {
          eligible_sample_count: 0,
          is_deleted: 1,
          sleep_id: sleepId,
        },
      ]);
    } finally {
      await client.command({ query: `DROP TABLE IF EXISTS ${targetTable}` });
      await client.command({ query: `TRUNCATE TABLE ${postgresDatabase}.sleep_session` });
    }
  });

  it("admits an old completed sleep deleted after cutover without prior window state", async () => {
    const userId = randomUUID();
    const sleepId = randomUUID();
    const targetTable = `${analyticsDatabase}.test_old_post_cutover_deletion`;

    await createTargetTable(targetTable);

    try {
      await client.command({
        query: `INSERT INTO ${postgresDatabase}.sleep_session (
          id, user_id, started_at, ended_at, duration_minutes, sleep_type,
          _peerdb_synced_at, _peerdb_is_deleted
        ) VALUES (
          {sleepId:UUID}, {userId:UUID},
          now64(6) - INTERVAL 200 DAY,
          now64(6) - INTERVAL 200 DAY + INTERVAL 8 HOUR,
          480, 'sleep', now64(9), 1
        )`,
        query_params: { sleepId, userId },
      });

      await insertWindowBatch(targetTable);

      const result = await client.query({
        query: `SELECT toString(sleep_id) AS sleep_id, eligible_sample_count, is_deleted
        FROM ${targetTable} FINAL`,
        format: "JSONEachRow",
      });
      expect(windowStateSchema.parse(await result.json())).toEqual([
        { eligible_sample_count: 0, is_deleted: 1, sleep_id: sleepId },
      ]);
    } finally {
      await client.command({ query: `DROP TABLE IF EXISTS ${targetTable}` });
      await client.command({ query: `TRUNCATE TABLE ${postgresDatabase}.sleep_session` });
    }
  });
});
