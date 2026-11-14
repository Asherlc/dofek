import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { createClient } from "@clickhouse/client";
import { expect } from "vitest";
import { z } from "zod";
import { runDbtBatch } from "./activity-payload-dbt-microbatch-test-helpers.ts";
import { readDbtStatementTarget } from "./activity-refresh-scope-dbt-test-helpers.ts";
import { buildPostgresFitnessProviderFieldPriorityRawTableStatement } from "./clickhouse-raw-tables.ts";
import { readModelSql, renderDbtModelSql } from "./read-model-sql-test-helpers.ts";

type ClickHouseClient = ReturnType<typeof createClient>;
export const activityId = "00000000-0000-0000-0000-000000000101";
export const linkedActivityId = "00000000-0000-0000-0000-000000000102";
export const groupId = "00000000-0000-0000-0000-000000000202";
export const testUserId = "00000000-0000-0000-0000-000000000303";
export const priorOnlyGroupId = "00000000-0000-0000-0000-000000000404";

export const dedupedActivitiesWorkReuseSampleCount = 8192;
export const dedupedActivitiesWorkReuseReadRowsLimit =
  dedupedActivitiesWorkReuseSampleCount * 1.5 + 1024;

export function requireClickHouseUrl(): string {
  const url = process.env.CLICKHOUSE_URL?.trim();
  if (!url) {
    throw new Error("CLICKHOUSE_URL is required for deduped activities integration tests");
  }
  return url;
}

export function requireClient(client: ClickHouseClient | undefined): ClickHouseClient {
  if (!client) {
    throw new Error("ClickHouse client was not initialized");
  }
  return client;
}

export async function waitForClickHouse(client: ClickHouseClient): Promise<void> {
  let lastError: unknown;
  for (let attemptIndex = 0; attemptIndex < 60; attemptIndex += 1) {
    try {
      const result = await client.query({ query: "SELECT 1", format: "JSONEachRow" });
      await result.json();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveAfterDelay) => setTimeout(resolveAfterDelay, 1_000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("ClickHouse did not become ready");
}

export function renderDedupedActivitiesSelectSql(
  targetSchema: string,
  scopedIds?: string[],
): string {
  return renderDbtModelSql(readModelSql("deduped_activities.sql"), {
    isIncremental: true,
    activityRefreshScoped: scopedIds !== undefined,
    activityRefreshIds: scopedIds,
  })
    .replaceAll('{{ var("activity_refresh_user_id") }}', testUserId)
    .replace(/{{ ref\('activity_source_records'\) }}/g, `${targetSchema}.activity_source_records`)
    .replace(/{{ ref\('deduped_sensor'\) }}/g, `${targetSchema}.deduped_sensor`)
    .replace(
      /{{ ref\('activity_duplicate_groups'\) }}/g,
      `${targetSchema}.activity_duplicate_groups`,
    )
    .replace(/{{ this }}/g, `${targetSchema}.deduped_activities`)
    .replace(/{{ source\('postgres_fitness', 'activity'\) }}/g, `${targetSchema}.source_activity`)
    .replace(
      /{{ source\('postgres_fitness', 'provider_field_priority'\) }}/g,
      `${targetSchema}.provider_field_priority`,
    )
    .replace(/{{ source\('ingest', 'metric_stream_current'\) }}/g, `${targetSchema}.metric_stream`)
    .concat("\nSETTINGS max_threads = 1, join_use_nulls = 1, enable_materialized_cte = 1");
}

export async function seedMissingSourceNameFixture(
  client: ClickHouseClient,
  targetSchema: string,
): Promise<void> {
  await seedTablesAndMembership(client, targetSchema, [
    `DROP DATABASE IF EXISTS ${targetSchema} SYNC`,
    `CREATE DATABASE ${targetSchema}`,
    createActivitySourceRecordsTableSql(targetSchema),
    createActivityDuplicateGroupsTableSql(targetSchema),
    createSourceActivityTableSql(targetSchema),
    createMetricStreamTableSql(targetSchema),
    createDedupedActivitiesTableSql(targetSchema),
    insertActivitySourceRecordSql(targetSchema),
    insertActivityDuplicateGroupSql(targetSchema),
  ]);
}

export async function seedSpecificActivityTypeFixture(
  client: ClickHouseClient,
  targetSchema: string,
  linkedProviderType = "commuting",
  pelotonActivityType = "cardio",
): Promise<void> {
  await seedTablesAndMembership(client, targetSchema, [
    `DROP DATABASE IF EXISTS ${targetSchema} SYNC`,
    `CREATE DATABASE ${targetSchema}`,
    createActivitySourceRecordsTableSql(targetSchema),
    createActivityDuplicateGroupsTableSql(targetSchema),
    createSourceActivityTableSql(targetSchema),
    createMetricStreamTableSql(targetSchema),
    createDedupedActivitiesTableSql(targetSchema),
    insertActivitySourceRecordSql(targetSchema, pelotonActivityType),
    `INSERT INTO ${targetSchema}.activity_source_records VALUES (
  '${linkedActivityId}',
  'whoop',
  '${testUserId}',
  'whoop-rock-climbing-workout',
  'cycling',
  '${linkedProviderType}',
  CAST(NULL, 'Nullable(String)'),
  toDateTime64('2026-07-05 16:00:00', 6, 'UTC'),
  toDateTime64('2026-07-05 17:00:00', 6, 'UTC'),
  CAST(NULL, 'Nullable(String)'),
  CAST(NULL, 'Nullable(String)'),
  CAST(NULL, 'Nullable(String)'),
  'America/Los_Angeles',
  -480,
  -420,
  'provider_timezone',
  CAST(NULL, 'Nullable(String)'),
  toDateTime64('2026-07-05 17:01:00', 9, 'UTC'),
  20,
  1,
  0,
  toDateTime64('2026-07-05 17:02:00', 9, 'UTC')
)`,
    insertActivityDuplicateGroupSql(targetSchema),
    `INSERT INTO ${targetSchema}.activity_duplicate_groups VALUES (
  '${linkedActivityId}',
  '${groupId}',
  1,
  0,
  toDateTime64('2026-07-05 17:02:00', 9, 'UTC')
)`,
    `INSERT INTO ${targetSchema}.metric_stream VALUES ('${testUserId}', '${linkedActivityId}', 0)`,
  ]);
}

export async function seedSensorBearingRepresentativeFixture(
  client: ClickHouseClient,
  targetSchema: string,
): Promise<void> {
  await seedSpecificActivityTypeFixture(client, targetSchema, "cycling", "cycling");
}

export async function seedDedupedActivitiesWorkReuseFixture(
  client: ClickHouseClient,
  targetSchema: string,
): Promise<void> {
  await seedSensorBearingRepresentativeFixture(client, targetSchema);
  await client.command({ query: `TRUNCATE TABLE ${targetSchema}.deduped_sensor` });
  await client.command({
    query: `INSERT INTO ${targetSchema}.deduped_sensor
      (user_id, provider_id, recorded_at, channel)
      VALUES ('${testUserId}', 'peloton', toDateTime64('2026-07-05 16:05:00', 6, 'UTC'), 'heart_rate')`,
  });
  await client.command({
    query: `INSERT INTO ${targetSchema}.deduped_activities
      ${renderDedupedActivitiesSelectSql(targetSchema)}`,
  });
  await client.command({
    query: `INSERT INTO ${targetSchema}.deduped_activities
      SELECT * REPLACE (
        toUUID('${priorOnlyGroupId}') AS activity_id,
        toUUID('${priorOnlyGroupId}') AS primary_activity_id,
        toUUID('${priorOnlyGroupId}') AS representative_activity_id,
        [toUUID('${priorOnlyGroupId}')] AS member_activity_ids,
        [toUUID('${priorOnlyGroupId}')] AS origin_candidate_member_ids
      )
      FROM (
        SELECT * FROM ${targetSchema}.deduped_activities FINAL
        WHERE activity_id = toUUID('${groupId}') AND is_deleted = 0
      )`,
  });
  await client.command({
    query: `CREATE VIEW ${targetSchema}.activity AS
      SELECT * FROM ${targetSchema}.source_activity`,
  });
}

export async function runDedupedActivitiesWorkReuseDbtAppend(
  client: ClickHouseClient,
  targetSchema: string,
  scoped: boolean,
): Promise<{
  denseSampleCount: number;
  queryId: string;
  readRows: number;
  readBytes: number;
  queryDurationMs: number;
  memoryUsage: number;
  settings: Record<string, string>;
}> {
  await client.command({
    query: `INSERT INTO ${targetSchema}.deduped_sensor
      (user_id, provider_id, recorded_at, channel)
      SELECT '${testUserId}', 'whoop',
        toDateTime64('2026-07-05 16:00:00', 6, 'UTC') + toIntervalMicrosecond(number * 439000),
        'heart_rate'
      FROM numbers(${dedupedActivitiesWorkReuseSampleCount})`,
  });
  const sampleResult = await client.query({
    query: `SELECT count() AS sample_count FROM ${targetSchema}.deduped_sensor FINAL
      WHERE user_id = toUUID('${testUserId}') AND provider_id = 'whoop'
        AND source_activity_id = toUUID('${linkedActivityId}')`,
    format: "JSONEachRow",
  });
  const sampleRows = z
    .array(z.object({ sample_count: z.coerce.number() }))
    .parse(await sampleResult.json());
  const sampleRow = sampleRows[0];
  if (!sampleRow) throw new Error("Dense sensor count query returned no row");
  const denseSampleCount = sampleRow.sample_count;
  if (denseSampleCount !== dedupedActivitiesWorkReuseSampleCount) {
    throw new Error(
      `Expected ${dedupedActivitiesWorkReuseSampleCount} surviving WHOOP samples, found ${denseSampleCount}`,
    );
  }

  const startedResult = await client.query({
    query: "SELECT toString(now64(6, 'UTC')) AS started_at",
    format: "JSONEachRow",
  });
  const startedRows = z
    .array(z.object({ started_at: z.string().min(1) }))
    .parse(await startedResult.json());
  const startedRow = startedRows[0];
  if (!startedRow) throw new Error("ClickHouse timestamp query returned no row");
  const startedAt = startedRow.started_at;
  const artifactDirectory = join(
    tmpdir(),
    `deduped-activities-work-${randomBytes(6).toString("hex")}`,
  );
  try {
    await runDbtBatch(
      targetSchema,
      artifactDirectory,
      ["deduped_activities"],
      "2026-07-05",
      "2026-07-06",
      scoped ? [groupId, priorOnlyGroupId] : undefined,
      undefined,
      testUserId,
    );
    await client.command({ query: "SYSTEM FLUSH LOGS" });
    const logResult = await client.query({
      query: `SELECT query, query_id, read_rows, read_bytes, query_duration_ms, memory_usage, Settings
        FROM system.query_log
        WHERE type = 'QueryFinish' AND is_initial_query = 1 AND query_kind = 'Insert'
          AND query_start_time_microseconds >= toDateTime64({startedAt:String}, 6, 'UTC')
          AND position(query, {targetSchema:String}) > 0`,
      query_params: { startedAt, targetSchema },
      format: "JSONEachRow",
    });
    const records = z
      .array(
        z.object({
          query: z.string(),
          query_id: z.string().min(1),
          read_rows: z.coerce.number(),
          read_bytes: z.coerce.number(),
          query_duration_ms: z.coerce.number(),
          memory_usage: z.coerce.number(),
          Settings: z.record(z.string(), z.string()),
        }),
      )
      .parse(await logResult.json())
      .filter(({ query }) => {
        const target = readDbtStatementTarget(query);
        return (
          target?.operation === "insert" &&
          target.database === targetSchema &&
          target.model === "deduped_activities"
        );
      });
    expect(records).toHaveLength(1);
    const record = records[0];
    if (!record) throw new Error("Missing dbt model QueryFinish record");
    const metrics = {
      denseSampleCount,
      queryId: record.query_id,
      readRows: record.read_rows,
      readBytes: record.read_bytes,
      queryDurationMs: record.query_duration_ms,
      memoryUsage: record.memory_usage,
      settings: record.Settings,
    };
    process.stdout.write(`${JSON.stringify({ dedupedActivitiesWorkReuse: metrics })}\n`);
    expect(metrics.readRows).toBeGreaterThan(0);
    expect(metrics.readBytes).toBeGreaterThan(0);
    expect(metrics.queryDurationMs).toBeGreaterThan(0);
    expect(metrics.memoryUsage).toBeGreaterThan(0);
    return metrics;
  } finally {
    await rm(artifactDirectory, { recursive: true, force: true });
  }
}

export async function seedNamedTimezoneContextFixture(
  client: ClickHouseClient,
  targetSchema: string,
): Promise<void> {
  await seedTablesAndMembership(client, targetSchema, [
    `DROP DATABASE IF EXISTS ${targetSchema} SYNC`,
    `CREATE DATABASE ${targetSchema}`,
    createActivitySourceRecordsTableSql(targetSchema),
    createActivityDuplicateGroupsTableSql(targetSchema),
    createSourceActivityTableSql(targetSchema),
    createMetricStreamTableSql(targetSchema),
    createDedupedActivitiesTableSql(targetSchema),
    `INSERT INTO ${targetSchema}.activity_source_records VALUES (
  '${activityId}',
  'peloton',
  '${testUserId}',
  'peloton-offset-only',
  'strength',
  'strength',
  CAST(NULL, 'Nullable(String)'),
  toDateTime64('2026-09-01 14:55:54', 6, 'UTC'),
  toDateTime64('2026-09-01 15:55:54', 6, 'UTC'),
  CAST(NULL, 'Nullable(String)'),
  CAST(NULL, 'Nullable(String)'),
  CAST(NULL, 'Nullable(String)'),
  CAST(NULL, 'Nullable(String)'),
  -240,
  -240,
  'provider_offset',
  CAST(NULL, 'Nullable(String)'),
  toDateTime64('2026-09-01 16:00:00', 9, 'UTC'),
  10,
  1,
  0,
  toDateTime64('2026-09-01 16:01:00', 9, 'UTC')
)`,
    `INSERT INTO ${targetSchema}.activity_source_records VALUES (
  '${linkedActivityId}',
  'strong-csv',
  '${testUserId}',
  'strong-named-zone',
  'strength',
  'strength',
  CAST(NULL, 'Nullable(String)'),
  toDateTime64('2026-09-01 14:55:54', 6, 'UTC'),
  toDateTime64('2026-09-01 15:55:54', 6, 'UTC'),
  CAST(NULL, 'Nullable(String)'),
  CAST(NULL, 'Nullable(String)'),
  CAST(NULL, 'Nullable(String)'),
  'America/Los_Angeles',
  -420,
  -420,
  'device_timezone',
  CAST(NULL, 'Nullable(String)'),
  toDateTime64('2026-09-01 16:00:00', 9, 'UTC'),
  20,
  1,
  0,
  toDateTime64('2026-09-01 16:01:00', 9, 'UTC')
)`,
    insertActivityDuplicateGroupSql(targetSchema),
    `INSERT INTO ${targetSchema}.activity_duplicate_groups VALUES (
  '${linkedActivityId}',
  '${groupId}',
  1,
  0,
  toDateTime64('2026-09-01 16:01:00', 9, 'UTC')
)`,
  ]);
}

async function seedTablesAndMembership(
  client: ClickHouseClient,
  database: string,
  statements: string[],
): Promise<void> {
  for (const statement of statements) {
    await client.command({ query: statement });
  }
  await client.command({
    query: buildPostgresFitnessProviderFieldPriorityRawTableStatement().replaceAll(
      "postgres_fitness.",
      `${database}.`,
    ),
  });
  await client.command({
    query: `ALTER TABLE ${database}.activity_source_records ADD COLUMN group_id Nullable(UUID) DEFAULT '${groupId}'`,
  });
  await client.command({
    query: `ALTER TABLE ${database}.source_activity ADD COLUMN group_id Nullable(UUID) DEFAULT '${groupId}'`,
  });
  await client.command({
    query: `CREATE TABLE ${database}.deduped_sensor (
    user_id UUID, provider_id String, recorded_at DateTime64(6, 'UTC'), channel String,
    source_activity_id Nullable(UUID) DEFAULT if(provider_id = 'peloton', toUUID('${activityId}'), toUUID('${linkedActivityId}')),
    is_deleted UInt8 DEFAULT 0, refresh_version UInt64 DEFAULT 1
  ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, channel, recorded_at)`,
  });
  await client.command({
    query: `INSERT INTO ${database}.deduped_sensor (user_id, provider_id, recorded_at, channel)
    SELECT user_id, 'whoop', toDateTime64('2026-07-05 16:05:00', 6, 'UTC'), 'heart_rate'
    FROM ${database}.metric_stream WHERE is_deleted = 0`,
  });
}

function createActivitySourceRecordsTableSql(targetSchema: string): string {
  return `CREATE TABLE ${targetSchema}.activity_source_records (
  activity_id UUID,
  provider_id Nullable(String),
  user_id Nullable(UUID),
  external_id Nullable(String),
  canonical_type Nullable(String),
  provider_type Nullable(String),
  modality Nullable(String),
  started_at Nullable(DateTime64(6, 'UTC')),
  ended_at Nullable(DateTime64(6, 'UTC')),
  source_name Nullable(String),
  name Nullable(String),
  notes Nullable(String),
  timezone Nullable(String),
  start_utc_offset_minutes Nullable(Int16),
  end_utc_offset_minutes Nullable(Int16),
  local_time_source LowCardinality(String),
  raw Nullable(String),
  source_synced_at Nullable(DateTime64(9, 'UTC')),
  priority Nullable(Int32),
  refresh_version UInt64,
  is_deleted UInt8,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY activity_id`;
}

function createDedupedActivitiesTableSql(targetSchema: string): string {
  return `CREATE TABLE ${targetSchema}.deduped_activities (
  activity_id UUID,
  provider_id String,
  user_id UUID,
  primary_activity_id Nullable(UUID),
  canonical_type String,
  provider_type String,
  modality Nullable(String),
  started_at DateTime64(6, 'UTC'),
  ended_at Nullable(DateTime64(6, 'UTC')),
  source_name Nullable(String),
  name Nullable(String),
  notes Nullable(String),
  timezone Nullable(String),
  start_utc_offset_minutes Nullable(Int16),
  end_utc_offset_minutes Nullable(Int16),
  local_time_source LowCardinality(String) DEFAULT 'unknown',
  raw Nullable(String),
  source_synced_at DateTime64(9, 'UTC'),
  source_providers Array(String),
  source_external_ids Array(Map(String, String)),
  absent_source_external_ids Array(Map(String, String)),
  member_activity_ids Array(UUID),
  representative_activity_id UUID DEFAULT assumeNotNull(primary_activity_id),
  primary_provider_id Nullable(String),
  primary_source_name Nullable(String),
  origin_candidate_member_ids Array(UUID) DEFAULT member_activity_ids,
  origin_evidence Array(Map(String, String)),
  refresh_version UInt64,
  is_deleted UInt8,
  refreshed_at DateTime64(9, 'UTC'),
  primary_canonical_type Nullable(String)
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, activity_id)`;
}

function createActivityDuplicateGroupsTableSql(targetSchema: string): string {
  return `CREATE TABLE ${targetSchema}.activity_duplicate_groups (
  activity_id UUID,
  group_id UUID,
  refresh_version UInt64,
  is_deleted UInt8,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY activity_id`;
}

function createSourceActivityTableSql(targetSchema: string): string {
  return `CREATE TABLE ${targetSchema}.source_activity (
  id UUID,
  user_id UUID,
  provider_type Nullable(String),
  provider_id Nullable(String),
  external_id Nullable(String),
  source_name Nullable(String),
  raw Nullable(String),
  provider_absent_at Nullable(DateTime64(6, 'UTC')),
  deleted_at Nullable(DateTime64(6, 'UTC')),
  created_at DateTime64(6, 'UTC'),
  _peerdb_is_deleted UInt8
)
ENGINE = ReplacingMergeTree()
ORDER BY id`;
}

function createMetricStreamTableSql(targetSchema: string): string {
  return `CREATE TABLE ${targetSchema}.metric_stream (
  user_id UUID,
  activity_id Nullable(UUID),
  is_deleted UInt8
)
ENGINE = ReplacingMergeTree()
ORDER BY (user_id, activity_id)
SETTINGS allow_nullable_key = 1`;
}

function insertActivitySourceRecordSql(targetSchema: string, activityType = "cycling"): string {
  return `INSERT INTO ${targetSchema}.activity_source_records VALUES (
  '${activityId}',
  'peloton',
  '${testUserId}',
  'peloton-workout-without-source-name',
  '${activityType}',
  '${activityType}',
  CAST(NULL, 'Nullable(String)'),
  toDateTime64('2026-07-05 16:00:00', 6, 'UTC'),
  toDateTime64('2026-07-05 17:00:00', 6, 'UTC'),
  CAST(NULL, 'Nullable(String)'),
  'Power Zone Ride',
  CAST(NULL, 'Nullable(String)'),
  'America/Los_Angeles',
  -480,
  -420,
  'provider_timezone',
  '{"classTitle":"Power Zone Ride"}',
  toDateTime64('2026-07-05 17:01:00', 9, 'UTC'),
  10,
  1,
  0,
  toDateTime64('2026-07-05 17:02:00', 9, 'UTC')
)`;
}

function insertActivityDuplicateGroupSql(targetSchema: string): string {
  return `INSERT INTO ${targetSchema}.activity_duplicate_groups VALUES (
  '${activityId}',
  '${groupId}',
  1,
  0,
  toDateTime64('2026-07-05 17:02:00', 9, 'UTC')
)`;
}
