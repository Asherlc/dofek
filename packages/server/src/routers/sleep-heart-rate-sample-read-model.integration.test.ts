import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { readModelSql } from "../../../../src/db/read-model-sql-test-helpers.ts";
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

function renderSleepHeartRateSampleSql(
  targetTable: string,
  analyticsDatabase: string,
  postgresDatabase: string,
  isIncremental: boolean,
  batchSize = 2,
): string {
  return readModelSql("sleep_heart_rate_sample.sql")
    .replace(/\{%\s*set[\s\S]*?%\}\s*/g, "")
    .replace(/\{\{\s*config\([\s\S]*?\)\s*\}\}\s*/g, "")
    .replaceAll("{{ sleep_dirty_key_batch_size }}", String(batchSize))
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

describe("sleep heart-rate sample read model", () => {
  const analyticsDatabase = `analytics_sleep_sample_${randomUUID().replaceAll("-", "")}`;
  const postgresDatabase = `postgres_sleep_sample_${randomUUID().replaceAll("-", "")}`;
  let client: ClickHouseClient;

  beforeAll(async () => {
    client = createClickHouseClientFromEnv();
    await client.command({ query: `CREATE DATABASE ${analyticsDatabase}` });
    await client.command({ query: `CREATE DATABASE ${postgresDatabase}` });
    await client.command({
      query: `CREATE TABLE ${analyticsDatabase}.sleep_heart_rate_window (
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
      query: `CREATE TABLE ${postgresDatabase}.activity (
        id UUID,
        user_id UUID,
        started_at DateTime64(6, 'UTC'),
        ended_at Nullable(DateTime64(6, 'UTC')),
        _peerdb_is_deleted Int8,
        provider_absent_at Nullable(DateTime64(6, 'UTC')),
        deleted_at Nullable(DateTime64(6, 'UTC'))
      ) ENGINE = ReplacingMergeTree
      ORDER BY (user_id, started_at, id)`,
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
        recorded_at DateTime64(6, 'UTC'),
        recorded_date Date,
        heart_rate Nullable(Float32),
        refresh_version UInt64,
        is_deleted UInt8,
        refreshed_at DateTime64(9, 'UTC')
      ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, sleep_id, recorded_date, recorded_at)`,
    });
  }

  it("projects no more than the configured number of changed windows", async () => {
    const userId = randomUUID();
    const sleepIds = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
    ];
    const targetTable = `${analyticsDatabase}.test_bounded_sleep_samples`;

    await createTargetTable(targetTable);

    try {
      for (const [index, sleepId] of sleepIds.entries()) {
        const day = 20 + index;
        await client.command({
          query: `INSERT INTO ${analyticsDatabase}.sleep_heart_rate_window VALUES (
            {sleepId:UUID}, {userId:UUID},
            {startedAt:DateTime64(6, 'UTC')}, {endedAt:DateTime64(6, 'UTC')}, 28800,
            1,
            {refreshedAt:DateTime64(9, 'UTC')}, {refreshVersion:UInt64}, 0,
            {refreshedAt:DateTime64(9, 'UTC')}
          )`,
          query_params: {
            endedAt: `2026-07-${day} 08:00:00`,
            index,
            recordedAt: `2026-07-${day} 01:00:00`,
            refreshedAt: `2026-07-${day} 09:00:00`,
            refreshVersion: index + 1,
            sleepId,
            startedAt: `2026-07-${day} 00:00:00`,
            userId,
          },
        });
        await client.command({
          query: `INSERT INTO ${analyticsDatabase}.deduped_sensor VALUES (
            {userId:UUID}, {recordedAt:DateTime64(6, 'UTC')}, toDate({recordedAt:String}),
            'heart_rate', 60 + {index:Int32}, 0, {refreshVersion:UInt64},
            {refreshedAt:DateTime64(9, 'UTC')}
          )`,
          query_params: {
            index,
            recordedAt: `2026-07-${day} 01:00:00`,
            refreshedAt: `2026-07-${day} 09:00:00`,
            refreshVersion: index + 1,
            userId,
          },
        });
      }

      const result = await client.query({
        query: `SELECT uniqExact(sleep_id) AS count
          FROM (${renderSleepHeartRateSampleSql(
            targetTable,
            analyticsDatabase,
            postgresDatabase,
            true,
          )})
          SETTINGS join_use_nulls = 1, enable_materialized_cte = 1`,
        format: "JSONEachRow",
      });

      expect(countSchema.parse(await result.json())).toEqual([{ count: 2 }]);
    } finally {
      await client.command({ query: `DROP TABLE IF EXISTS ${targetTable}` });
      await client.command({
        query: `TRUNCATE TABLE ${analyticsDatabase}.sleep_heart_rate_window`,
      });
      await client.command({ query: `TRUNCATE TABLE ${analyticsDatabase}.deduped_sensor` });
    }
  });

  it("skips processed-empty windows without blocking a later populated window", async () => {
    const userId = randomUUID();
    const emptySleepId = "00000000-0000-4000-8000-000000000001";
    const populatedSleepId = "00000000-0000-4000-8000-000000000002";
    const targetTable = `${analyticsDatabase}.test_empty_window_projection`;

    await createTargetTable(targetTable);

    try {
      await client.command({
        query: `INSERT INTO ${analyticsDatabase}.sleep_heart_rate_window VALUES
          ({emptySleepId:UUID}, {userId:UUID},
            '2026-07-25 00:00:00', '2026-07-25 08:00:00', 28800, 0,
            '2026-07-25 09:00:00', 1, 0, '2026-07-25 09:00:00'),
          ({populatedSleepId:UUID}, {userId:UUID},
            '2026-07-26 00:00:00', '2026-07-26 08:00:00', 28800, 1,
            '2026-07-26 09:00:00', 2, 0, '2026-07-26 09:00:00')`,
        query_params: { emptySleepId, populatedSleepId, userId },
      });
      await client.command({
        query: `INSERT INTO ${analyticsDatabase}.deduped_sensor VALUES (
          {userId:UUID}, '2026-07-26 01:00:00', '2026-07-26',
          'heart_rate', 61, 0, 2, '2026-07-26 09:00:00'
        )`,
        query_params: { userId },
      });

      const result = await client.query({
        query: `SELECT toString(sleep_id) AS sleep_id
          FROM (${renderSleepHeartRateSampleSql(
            targetTable,
            analyticsDatabase,
            postgresDatabase,
            true,
            1,
          )})
          SETTINGS join_use_nulls = 1, enable_materialized_cte = 1`,
        format: "JSONEachRow",
      });

      expect(z.array(z.object({ sleep_id: z.string() })).parse(await result.json())).toEqual([
        { sleep_id: populatedSleepId },
      ]);
    } finally {
      await client.command({ query: `DROP TABLE IF EXISTS ${targetTable}` });
      await client.command({
        query: `TRUNCATE TABLE ${analyticsDatabase}.sleep_heart_rate_window`,
      });
      await client.command({ query: `TRUNCATE TABLE ${analyticsDatabase}.deduped_sensor` });
    }
  });

  it("tombstones existing samples when the exact window becomes empty", async () => {
    const userId = randomUUID();
    const sleepId = randomUUID();
    const targetTable = `${analyticsDatabase}.test_stale_sleep_samples`;

    await createTargetTable(targetTable);

    try {
      await client.command({
        query: `INSERT INTO ${targetTable} VALUES (
          {sleepId:UUID}, {userId:UUID},
          '2026-07-20 00:00:00', '2026-07-20 08:00:00', 28800,
          '2026-07-20 01:00:00', '2026-07-20', 60, 1, 0,
          '2026-07-20 09:00:00'
        )`,
        query_params: { sleepId, userId },
      });
      await client.command({
        query: `INSERT INTO ${analyticsDatabase}.sleep_heart_rate_window VALUES (
          {sleepId:UUID}, {userId:UUID},
          '2026-07-20 00:00:00', '2026-07-20 08:00:00', 28800, 0,
          '2026-07-21 09:00:00', 2, 0, '2026-07-21 09:00:00'
        )`,
        query_params: { sleepId, userId },
      });

      const result = await client.query({
        query: `SELECT toString(sleep_id) AS sleep_id, is_deleted
          FROM (${renderSleepHeartRateSampleSql(
            targetTable,
            analyticsDatabase,
            postgresDatabase,
            true,
          )})
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
      await client.command({
        query: `TRUNCATE TABLE ${analyticsDatabase}.sleep_heart_rate_window`,
      });
    }
  });
});
