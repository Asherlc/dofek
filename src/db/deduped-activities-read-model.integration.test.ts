import { randomBytes } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readModelSql, renderDbtModelSql } from "./read-model-sql-test-helpers.ts";

const activityId = "00000000-0000-0000-0000-000000000101";
const linkedActivityId = "00000000-0000-0000-0000-000000000102";
const groupId = "00000000-0000-0000-0000-000000000202";
const testUserId = "00000000-0000-0000-0000-000000000303";

type ClickHouseClient = ReturnType<typeof createClient>;

interface SourceLinkRow {
  providerId: string;
  sourceLinkCount: number;
  subsource: string;
}

interface ActivityTypeRow {
  activityType: string;
  activityId: string;
  providerId: string;
  providerType: string;
}

interface LocalTimeContextRow {
  endUtcOffsetMinutes: number | null;
  localTimeSource: string;
  startUtcOffsetMinutes: number | null;
  timezone: string | null;
}

describe("deduped_activities read model", () => {
  let client: ClickHouseClient | undefined;
  const targetSchema = `analytics_deduped_activities_test_${randomBytes(6).toString("hex")}`;

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

  it("materializes source links when source name fields are absent", async () => {
    const activeClient = requireClient(client);
    await seedMissingSourceNameFixture(activeClient, targetSchema);

    await activeClient.command({
      query: `INSERT INTO ${targetSchema}.deduped_activities
${renderDedupedActivitiesSelectSql(targetSchema)}`,
    });

    const result = await activeClient.query({
      query: `SELECT
          length(source_external_ids) AS sourceLinkCount,
          source_external_ids[1]['providerId'] AS providerId,
          source_external_ids[1]['subsource'] AS subsource
        FROM ${targetSchema}.deduped_activities FINAL
        WHERE activity_id = {activityId:UUID}
          AND is_deleted = 0`,
      query_params: { activityId },
      format: "JSONEachRow",
    });
    const rows = await result.json<SourceLinkRow>();

    expect(rows).toEqual([{ providerId: "peloton", sourceLinkCount: 1, subsource: "" }]);

    const localTimeResult = await activeClient.query({
      query: `SELECT
          timezone,
          start_utc_offset_minutes AS startUtcOffsetMinutes,
          end_utc_offset_minutes AS endUtcOffsetMinutes,
          local_time_source AS localTimeSource
        FROM ${targetSchema}.deduped_activities FINAL
        WHERE activity_id = {activityId:UUID}
          AND is_deleted = 0`,
      query_params: { activityId },
      format: "JSONEachRow",
    });
    const localTimeRows = await localTimeResult.json<LocalTimeContextRow>();

    expect(localTimeRows).toEqual([
      {
        endUtcOffsetMinutes: -420,
        localTimeSource: "provider_timezone",
        startUtcOffsetMinutes: -480,
        timezone: "America/Los_Angeles",
      },
    ]);
  }, 180_000);

  it("prefers specific canonical and provider type evidence over provider priority", async () => {
    const activeClient = requireClient(client);
    await seedSpecificActivityTypeFixture(activeClient, targetSchema);

    await activeClient.command({
      query: `INSERT INTO ${targetSchema}.deduped_activities
${renderDedupedActivitiesSelectSql(targetSchema)}`,
    });

    const result = await activeClient.query({
      query: `SELECT
          toString(activity_id) AS activityId,
          provider_id AS providerId,
          canonical_type AS activityType,
          provider_type AS providerType
        FROM ${targetSchema}.deduped_activities FINAL
        WHERE is_deleted = 0`,
      format: "JSONEachRow",
    });
    const rows = await result.json<ActivityTypeRow>();

    expect(rows).toEqual([
      {
        activityId: linkedActivityId,
        providerId: "whoop",
        activityType: "cycling",
        providerType: "commuting",
      },
    ]);
  }, 180_000);

  it("prefers a sensor-bearing member when type evidence is tied", async () => {
    const activeClient = requireClient(client);
    await seedSensorBearingRepresentativeFixture(activeClient, targetSchema);

    await activeClient.command({
      query: `INSERT INTO ${targetSchema}.deduped_activities
${renderDedupedActivitiesSelectSql(targetSchema)}`,
    });

    const result = await activeClient.query({
      query: `SELECT toString(activity_id) AS activityId, provider_id AS providerId,
          canonical_type AS activityType, provider_type AS providerType
        FROM ${targetSchema}.deduped_activities FINAL
        WHERE is_deleted = 0`,
      format: "JSONEachRow",
    });

    expect(await result.json<ActivityTypeRow>()).toEqual([
      {
        activityId: linkedActivityId,
        providerId: "whoop",
        activityType: "cycling",
        providerType: "cycling",
      },
    ]);
  }, 180_000);
});

function requireClickHouseUrl(): string {
  const url = process.env.CLICKHOUSE_URL?.trim();
  if (!url) {
    throw new Error("CLICKHOUSE_URL is required for deduped activities integration tests");
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

function renderDedupedActivitiesSelectSql(targetSchema: string): string {
  return renderDbtModelSql(readModelSql("deduped_activities.sql"), {
    isIncremental: true,
    activityRefreshScoped: false,
  })
    .replace(/{{ ref\('activity_source_records'\) }}/g, `${targetSchema}.activity_source_records`)
    .replace(
      /{{ ref\('activity_duplicate_groups'\) }}/g,
      `${targetSchema}.activity_duplicate_groups`,
    )
    .replace(/{{ this }}/g, `${targetSchema}.deduped_activities`)
    .replace(/{{ source\('postgres_fitness', 'activity'\) }}/g, `${targetSchema}.source_activity`)
    .replace(/{{ source\('ingest', 'metric_stream_current'\) }}/g, `${targetSchema}.metric_stream`)
    .concat("\nSETTINGS max_threads = 1, join_use_nulls = 1");
}

async function seedMissingSourceNameFixture(
  client: ClickHouseClient,
  targetSchema: string,
): Promise<void> {
  await runStatements(client, [
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

async function seedSpecificActivityTypeFixture(
  client: ClickHouseClient,
  targetSchema: string,
  linkedProviderType = "commuting",
  pelotonActivityType = "cardio",
): Promise<void> {
  await runStatements(client, [
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

async function seedSensorBearingRepresentativeFixture(
  client: ClickHouseClient,
  targetSchema: string,
): Promise<void> {
  await seedSpecificActivityTypeFixture(client, targetSchema, "cycling", "cycling");
}

async function runStatements(client: ClickHouseClient, statements: string[]): Promise<void> {
  for (const statement of statements) {
    await client.command({ query: statement });
  }
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
  primary_activity_id UUID,
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
  refresh_version UInt64,
  is_deleted UInt8,
  refreshed_at DateTime64(9, 'UTC')
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
  provider_id Nullable(String),
  external_id Nullable(String),
  source_name Nullable(String),
  raw Nullable(String),
  provider_absent_at Nullable(DateTime64(6, 'UTC')),
  deleted_at Nullable(DateTime64(6, 'UTC')),
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
