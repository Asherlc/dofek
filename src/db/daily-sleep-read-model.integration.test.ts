import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { timestampStringSchema } from "./typed-sql.ts";

const testUserId = "00000000-0000-4000-8000-000000001770";
const selectedSleepId = "00000000-0000-4000-8000-000000001771";
const fallbackSleepId = "00000000-0000-4000-8000-000000001772";
const recentSleepId = "00000000-0000-4000-8000-000000001773";
const conflictSelectedSleepId = "00000000-0000-4000-8000-000000001774";
const conflictOverlapSleepId = "00000000-0000-4000-8000-000000001775";
const conflictSplitSleepId = "00000000-0000-4000-8000-000000001776";
const historicalSleepDate = "2026-01-01";
const conflictSleepDate = "2026-02-01";

type ClickHouseClient = ReturnType<typeof createClient>;

const liveDailySleepRowSchema = z.object({
  date: z.string(),
  deep_minutes: z.coerce.number().nullable(),
  rem_minutes: z.coerce.number().nullable(),
  duration_minutes: z.coerce.number(),
  staging_available: z.boolean(),
  end_utc_offset_minutes: z.coerce.number().nullable(),
  is_deleted: z.coerce.number(),
  local_time_source: z.string(),
  start_utc_offset_minutes: z.coerce.number().nullable(),
  timezone: z.string().nullable(),
});

const overlapEvidenceRowSchema = z.object({
  selected_session_id: z.string(),
  overlapping_sessions: z.array(
    z.object({
      session_id: z.string(),
      provider_id: z.string(),
      source_name: z.string().nullable(),
      source_providers: z.array(z.string()),
      timezone: z.string().nullable(),
      start_utc_offset_minutes: z.coerce.number().nullable(),
      end_utc_offset_minutes: z.coerce.number().nullable(),
      local_time_source: z.string(),
      started_at: timestampStringSchema,
      ended_at: timestampStringSchema.nullable(),
      duration_minutes: z.coerce.number().nullable(),
    }),
  ),
});

describe("daily_sleep read-model lifecycle", () => {
  let client: ClickHouseClient | undefined;
  const targetSchema = `analytics_daily_sleep_test_${randomBytes(6).toString("hex")}`;

  beforeAll(async () => {
    client = createClient({
      url: requireClickHouseUrl(),
      request_timeout: 120_000,
    });
    await waitForClickHouse(client);
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${targetSchema} SYNC` });
      await client.close();
    }
  });

  it("selects a fallback and then tombstones an older night as source sessions are deleted", async () => {
    const activeClient = requireClient(client);
    await seedDailySleepFixture(activeClient, targetSchema);
    await materializeDailySleep(activeClient, targetSchema, false);

    await expect(readLiveHistoricalNight(activeClient, targetSchema)).resolves.toEqual([
      {
        date: historicalSleepDate,
        deep_minutes: 90,
        rem_minutes: 100,
        duration_minutes: 480,
        staging_available: true,
        end_utc_offset_minutes: -420,
        is_deleted: 0,
        local_time_source: "provider_timezone",
        start_utc_offset_minutes: -480,
        timezone: "America/Los_Angeles",
      },
    ]);

    await tombstoneSourceSleep(activeClient, targetSchema, selectedSleepId, 480);
    await materializeDailySleep(activeClient, targetSchema, true);

    await expect(readLiveHistoricalNight(activeClient, targetSchema)).resolves.toEqual([
      {
        date: historicalSleepDate,
        deep_minutes: null,
        rem_minutes: null,
        duration_minutes: 420,
        staging_available: false,
        end_utc_offset_minutes: 600,
        is_deleted: 0,
        local_time_source: "provider_offset",
        start_utc_offset_minutes: 600,
        timezone: null,
      },
    ]);

    await tombstoneSourceSleep(activeClient, targetSchema, fallbackSleepId, 420);
    await expect(countLiveHistoricalSourceRows(activeClient, targetSchema)).resolves.toBe(0);
    await materializeDailySleep(activeClient, targetSchema, true);

    await expect(readLiveHistoricalNight(activeClient, targetSchema)).resolves.toEqual([]);

    const tombstoneResult = await activeClient.query({
      query: `SELECT is_deleted
        FROM ${targetSchema}.daily_sleep FINAL
        WHERE user_id = {userId:UUID}
          AND date = toDate({date:String})`,
      query_params: {
        date: historicalSleepDate,
        userId: testUserId,
      },
      format: "JSONEachRow",
    });
    const tombstoneRows = await tombstoneResult.json<unknown>();

    expect(z.array(z.object({ is_deleted: z.coerce.number() })).parse(tombstoneRows)).toEqual([
      { is_deleted: 1 },
    ]);
  }, 180_000);

  it("retains only canonical sessions whose time windows overlap the nightly winner", async () => {
    const activeClient = requireClient(client);
    await seedDailySleepFixture(activeClient, targetSchema);
    await materializeDailySleep(activeClient, targetSchema, false);

    await expect(readConflictEvidence(activeClient, targetSchema)).resolves.toEqual([
      {
        selected_session_id: conflictSelectedSleepId,
        overlapping_sessions: [
          {
            session_id: conflictOverlapSleepId,
            provider_id: "overlap-provider",
            source_name: "Overlap Device",
            source_providers: ["overlap-provider"],
            timezone: null,
            start_utc_offset_minutes: 0,
            end_utc_offset_minutes: 0,
            local_time_source: "provider_offset",
            started_at: "2026-02-01T23:30:00.000Z",
            ended_at: "2026-02-02T05:00:00.000Z",
            duration_minutes: 330,
          },
        ],
      },
    ]);

    await tombstoneSourceSleep(activeClient, targetSchema, conflictOverlapSleepId, 330);
    await materializeDailySleep(activeClient, targetSchema, true);

    await expect(readConflictEvidence(activeClient, targetSchema)).resolves.toEqual([
      {
        selected_session_id: conflictSelectedSleepId,
        overlapping_sessions: [],
      },
    ]);
  }, 180_000);
});

function requireClickHouseUrl(): string {
  const url = process.env.CLICKHOUSE_URL?.trim();
  if (!url) {
    throw new Error("CLICKHOUSE_URL is required for daily sleep integration tests");
  }
  return url;
}

function requireClient(client: ClickHouseClient | undefined): ClickHouseClient {
  if (!client) {
    throw new Error("ClickHouse client was not initialized");
  }
  return client;
}

async function waitForClickHouse(client: ClickHouseClient): Promise<void> {
  let lastError: unknown;
  for (let attemptIndex = 0; attemptIndex < 60; attemptIndex += 1) {
    try {
      await client.query({ query: "SELECT 1", format: "JSONEachRow" });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveAfterDelay) => setTimeout(resolveAfterDelay, 1_000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("ClickHouse did not become ready");
}

function readDailySleepModelSql(): string {
  return readFileSync(
    new URL("../../analytics/models/read_models/daily_sleep.sql", import.meta.url),
    "utf8",
  );
}

function renderDailySleepSelectSql(targetSchema: string, isIncremental: boolean): string {
  return readDailySleepModelSql()
    .replace(/{{ config\([\s\S]*?\) }}\s*/, "")
    .replace(
      /{% if is_incremental\(\) %}([\s\S]*?)(?:{% else %}([\s\S]*?))?{% endif %}/g,
      (_, incrementalSql: string, initialSql: string | undefined) =>
        isIncremental ? incrementalSql : (initialSql ?? ""),
    )
    .replaceAll("{{ this }}", `${targetSchema}.daily_sleep`)
    .replaceAll(
      "{{ source('postgres_fitness', 'sleep_session') }}",
      `${targetSchema}.sleep_session`,
    )
    .replaceAll("analytics.v_sleep", `${targetSchema}.v_sleep`)
    .concat("\nSETTINGS join_use_nulls = 1, max_threads = 1");
}

async function materializeDailySleep(
  client: ClickHouseClient,
  targetSchema: string,
  isIncremental: boolean,
): Promise<void> {
  const selectSql = renderDailySleepSelectSql(targetSchema, isIncremental);
  const outputColumns = [
    "user_id",
    "date",
    "provider_id",
    "source_name",
    "source_providers",
    "selected_session_id",
    "overlapping_sessions",
    "timezone",
    "start_utc_offset_minutes",
    "end_utc_offset_minutes",
    "local_time_source",
    "started_at",
    "ended_at",
    "duration_minutes",
    "deep_minutes",
    "rem_minutes",
    "light_minutes",
    "awake_minutes",
    "efficiency_pct",
    "staging_available",
    "refresh_version",
    ...(selectSql.includes(" AS is_deleted") ? ["is_deleted"] : []),
    "refreshed_at",
  ];

  await client.command({
    query: `INSERT INTO ${targetSchema}.daily_sleep (${outputColumns.join(", ")})
${selectSql}`,
  });
}

async function readLiveHistoricalNight(
  client: ClickHouseClient,
  targetSchema: string,
): Promise<z.infer<typeof liveDailySleepRowSchema>[]> {
  const result = await client.query({
    query: `SELECT
        toString(date) AS date,
        deep_minutes,
        rem_minutes,
        duration_minutes,
        staging_available,
        end_utc_offset_minutes,
        local_time_source,
        start_utc_offset_minutes,
        timezone,
        is_deleted
      FROM ${targetSchema}.daily_sleep AS daily_sleep FINAL
      WHERE daily_sleep.user_id = {userId:UUID}
        AND daily_sleep.date = toDate({date:String})
        AND daily_sleep.is_deleted = 0`,
    query_params: {
      date: historicalSleepDate,
      userId: testUserId,
    },
    format: "JSONEachRow",
  });
  const rows = await result.json<unknown>();
  return z.array(liveDailySleepRowSchema).parse(rows);
}

async function readConflictEvidence(
  client: ClickHouseClient,
  targetSchema: string,
): Promise<z.infer<typeof overlapEvidenceRowSchema>[]> {
  const result = await client.query({
    query: `SELECT
        toString(selected_session_id) AS selected_session_id,
        toJSONString(overlapping_sessions) AS overlapping_sessions
      FROM ${targetSchema}.daily_sleep FINAL
      WHERE user_id = {userId:UUID}
        AND date = toDate({date:String})
        AND is_deleted = 0`,
    query_params: {
      date: conflictSleepDate,
      userId: testUserId,
    },
    clickhouse_settings: { date_time_output_format: "iso" },
    format: "JSONEachRow",
  });
  const rows = await result.json<{
    selected_session_id: string;
    overlapping_sessions: string;
  }>();
  return rows.map((row) =>
    overlapEvidenceRowSchema.parse({
      ...row,
      overlapping_sessions: JSON.parse(row.overlapping_sessions),
    }),
  );
}

async function countLiveHistoricalSourceRows(
  client: ClickHouseClient,
  targetSchema: string,
): Promise<number> {
  const result = await client.query({
    query: `SELECT count() AS row_count
      FROM ${targetSchema}.v_sleep
      WHERE user_id = {userId:UUID}
        AND toDate(started_at - INTERVAL 6 HOUR) = toDate({date:String})`,
    query_params: {
      date: historicalSleepDate,
      userId: testUserId,
    },
    format: "JSONEachRow",
  });
  const rows = await result.json<unknown>();
  const parsedRows = z.array(z.object({ row_count: z.coerce.number() })).parse(rows);
  return parsedRows[0]?.row_count ?? 0;
}

async function seedDailySleepFixture(
  client: ClickHouseClient,
  targetSchema: string,
): Promise<void> {
  await runStatements(client, [
    `DROP DATABASE IF EXISTS ${targetSchema} SYNC`,
    `CREATE DATABASE ${targetSchema}`,
    createSleepSourceTableSql(targetSchema),
    createSleepViewSql(targetSchema),
    createDailySleepTableSql(targetSchema),
    insertInitialSleepRowsSql(targetSchema),
  ]);
}

async function runStatements(client: ClickHouseClient, statements: string[]): Promise<void> {
  for (const [statementIndex, statement] of statements.entries()) {
    try {
      await client.command({ query: statement });
    } catch (error) {
      const statementPreview = statement.replace(/\s+/g, " ").slice(0, 240);
      throw new Error(
        `ClickHouse fixture statement ${statementIndex + 1} failed: ${statementPreview}`,
        { cause: error },
      );
    }
  }
}

function createSleepSourceTableSql(targetSchema: string): string {
  return `CREATE TABLE ${targetSchema}.sleep_session (
  id UUID,
  user_id UUID,
  provider_id String,
  source_name Nullable(String),
  source_providers Array(String),
  timezone Nullable(String),
  start_utc_offset_minutes Nullable(Int16),
  end_utc_offset_minutes Nullable(Int16),
  local_time_source LowCardinality(String),
  started_at DateTime64(6, 'UTC'),
  ended_at Nullable(DateTime64(6, 'UTC')),
  duration_minutes Nullable(Int32),
  deep_minutes Nullable(Int32),
  rem_minutes Nullable(Int32),
  light_minutes Nullable(Int32),
  awake_minutes Nullable(Int32),
  efficiency_pct Nullable(Float64),
  staging_available Bool,
  is_nap Bool,
  _peerdb_synced_at DateTime64(9, 'UTC'),
  _peerdb_is_deleted UInt8
)
ENGINE = ReplacingMergeTree(_peerdb_synced_at)
ORDER BY id`;
}

function createSleepViewSql(targetSchema: string): string {
  return `CREATE VIEW ${targetSchema}.v_sleep AS
SELECT
  id,
  user_id,
  provider_id,
  source_name,
  source_providers,
  timezone,
  start_utc_offset_minutes,
  end_utc_offset_minutes,
  local_time_source,
  started_at,
  ended_at,
  duration_minutes,
  if(staging_available, deep_minutes, NULL) AS deep_minutes,
  if(staging_available, rem_minutes, NULL) AS rem_minutes,
  if(staging_available, light_minutes, NULL) AS light_minutes,
  if(staging_available, awake_minutes, NULL) AS awake_minutes,
  efficiency_pct,
  staging_available,
  is_nap
FROM ${targetSchema}.sleep_session FINAL
WHERE _peerdb_is_deleted = 0`;
}

function createDailySleepTableSql(targetSchema: string): string {
  return `CREATE TABLE ${targetSchema}.daily_sleep (
  user_id UUID,
  date Date,
  provider_id String,
  source_name Nullable(String),
  source_providers Array(String),
  selected_session_id Nullable(UUID),
  overlapping_sessions Array(Tuple(
    session_id UUID,
    provider_id String,
    source_name Nullable(String),
    source_providers Array(String),
    timezone Nullable(String),
    start_utc_offset_minutes Nullable(Int16),
    end_utc_offset_minutes Nullable(Int16),
    local_time_source String,
    started_at DateTime64(6, 'UTC'),
    ended_at Nullable(DateTime64(6, 'UTC')),
    duration_minutes Nullable(Int32)
  )),
  timezone Nullable(String),
  start_utc_offset_minutes Nullable(Int16),
  end_utc_offset_minutes Nullable(Int16),
  local_time_source LowCardinality(String),
  started_at DateTime64(6, 'UTC'),
  ended_at Nullable(DateTime64(6, 'UTC')),
  duration_minutes Nullable(Int32),
  deep_minutes Nullable(Int32),
  rem_minutes Nullable(Int32),
  light_minutes Nullable(Int32),
  awake_minutes Nullable(Int32),
  efficiency_pct Nullable(Float64),
  staging_available Bool DEFAULT false,
  refresh_version UInt64,
  is_deleted UInt8 DEFAULT 0,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, date)`;
}

function insertInitialSleepRowsSql(targetSchema: string): string {
  return `INSERT INTO ${targetSchema}.sleep_session VALUES
(
  '${selectedSleepId}',
  '${testUserId}',
  'selected-provider',
  'Selected Device',
  ['selected-provider'],
  'America/Los_Angeles',
  -480,
  -420,
  'provider_timezone',
  toDateTime64('2026-01-01 22:00:00', 6, 'UTC'),
  toDateTime64('2026-01-02 06:00:00', 6, 'UTC'),
  480,
  90,
  100,
  250,
  40,
  91,
  true,
  false,
  toDateTime64('2026-01-02 06:01:00', 9, 'UTC'),
  0
),
(
  '${fallbackSleepId}',
  '${testUserId}',
  'fallback-provider',
  'Fallback Device',
  ['fallback-provider'],
  NULL,
  600,
  600,
  'provider_offset',
  toDateTime64('2026-01-01 22:30:00', 6, 'UTC'),
  toDateTime64('2026-01-02 05:30:00', 6, 'UTC'),
  420,
  NULL,
  90,
  220,
  30,
  89,
  false,
  false,
  toDateTime64('2026-01-02 06:01:00', 9, 'UTC'),
  0
),
(
  '${recentSleepId}',
  '${testUserId}',
  'recent-provider',
  'Recent Device',
  ['recent-provider'],
  NULL,
  NULL,
  NULL,
  'unknown',
  toDateTime64('2026-06-30 22:00:00', 6, 'UTC'),
  toDateTime64('2026-07-01 06:00:00', 6, 'UTC'),
  480,
  90,
  100,
  250,
  40,
  92,
  true,
  false,
  toDateTime64('2026-07-01 06:01:00', 9, 'UTC'),
  0
),
(
  '${conflictSelectedSleepId}',
  '${testUserId}',
  'selected-provider',
  'Selected Device',
  ['selected-provider'],
  'America/Los_Angeles',
  -480,
  -420,
  'provider_timezone',
  toDateTime64('2026-02-01 22:00:00', 6, 'UTC'),
  toDateTime64('2026-02-02 06:00:00', 6, 'UTC'),
  480,
  90,
  100,
  250,
  40,
  91,
  true,
  false,
  toDateTime64('2026-02-02 06:01:00', 9, 'UTC'),
  0
),
(
  '${conflictOverlapSleepId}',
  '${testUserId}',
  'overlap-provider',
  'Overlap Device',
  ['overlap-provider'],
  NULL,
  0,
  0,
  'provider_offset',
  toDateTime64('2026-02-01 23:30:00', 6, 'UTC'),
  toDateTime64('2026-02-02 05:00:00', 6, 'UTC'),
  330,
  50,
  70,
  180,
  30,
  90,
  true,
  false,
  toDateTime64('2026-02-02 06:01:00', 9, 'UTC'),
  0
),
(
  '${conflictSplitSleepId}',
  '${testUserId}',
  'split-provider',
  'Split Device',
  ['split-provider'],
  NULL,
  0,
  0,
  'provider_offset',
  toDateTime64('2026-02-01 18:00:00', 6, 'UTC'),
  toDateTime64('2026-02-01 20:00:00', 6, 'UTC'),
  120,
  20,
  20,
  70,
  10,
  91,
  true,
  false,
  toDateTime64('2026-02-02 06:01:00', 9, 'UTC'),
  0
)`;
}

async function tombstoneSourceSleep(
  client: ClickHouseClient,
  targetSchema: string,
  sleepId: string,
  durationMinutes: number,
): Promise<void> {
  await client.command({
    query: `INSERT INTO ${targetSchema}.sleep_session VALUES (
      {sleepId:UUID},
      {userId:UUID},
      'deleted-provider',
      NULL,
      [],
      NULL,
      NULL,
      NULL,
      'unknown',
      toDateTime64('2026-01-01 22:00:00', 6, 'UTC'),
      toDateTime64('2026-01-02 06:00:00', 6, 'UTC'),
      {durationMinutes:Int32},
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      false,
      false,
      now64(9, 'UTC'),
      1
    )`,
    query_params: {
      durationMinutes,
      sleepId,
      userId: testUserId,
    },
  });
}
