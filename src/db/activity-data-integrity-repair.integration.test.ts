import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@clickhouse/client";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runActivityIntegrityDbtBuild } from "./activity-data-integrity-dbt.ts";
import {
  type ActivityIntegrityClickHouseClient,
  repairActivityDataIntegrity,
  rollbackActivityDataIntegrity,
} from "./activity-data-integrity-repair.ts";
import { TEST_USER_ID } from "./schema/core.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";
import { ensureProvider } from "./tokens.ts";

const wahooActivityId = "2a7c6fa3-32f1-4ae5-9c99-b981c31e289b";
const pelotonActivityId = "761483e6-0000-4000-8000-000000000001";
const namedZoneActivityId = "894ce621-0000-4000-8000-000000000001";
const unrelatedActivityId = "9f99f9a7-0000-4000-8000-000000000001";
const CDC_FIXTURE_TIMEOUT_MS = 120_000;
const dbtEnvironmentKeys = [
  "DBT_TARGET",
  "DBT_CLICKHOUSE_SCHEMA",
  "DBT_ANALYTICS_SOURCE_SCHEMA",
  "DBT_INGEST_SOURCE_SCHEMA",
  "DBT_POSTGRES_FITNESS_SOURCE_SCHEMA",
] as const;
const priorDbtEnvironment = new Map(
  dbtEnvironmentKeys.map((key) => [key, process.env[key]] as const),
);

type NativeClickHouseClient = ReturnType<typeof createClient>;

describe("activity data integrity repair", () => {
  let context: TestContext;
  let client: NativeClickHouseClient;
  let scopedClient: ActivityIntegrityClickHouseClient;
  let artifactDirectory: string;
  const database = `activity_integrity_${randomBytes(6).toString("hex")}`;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await ensureProvider(context.db, "wahoo", "Wahoo");
    await ensureProvider(context.db, "peloton", "Peloton");
    const clickHouseUrl = process.env.CLICKHOUSE_URL?.trim();
    if (!clickHouseUrl)
      throw new Error("CLICKHOUSE_URL is required for activity repair integration tests");
    client = createClient({ url: clickHouseUrl, request_timeout: 120_000 });
    await client.query({ query: "SELECT 1", format: "JSONEachRow" });
    scopedClient = scopeClickHouseClient(client, database);
    artifactDirectory = await mkdtemp(join(tmpdir(), "activity-integrity-integration-"));
  }, 300_000);

  beforeEach(async () => {
    await seedPostgres(context);
    await rm(artifactDirectory, { recursive: true, force: true });
    await mkdir(artifactDirectory, { mode: 0o700 });
  }, 120_000);

  afterAll(async () => {
    for (const [key, value] of priorDbtEnvironment) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
      await client.close();
    }
    if (artifactDirectory) await rm(artifactDirectory, { recursive: true, force: true });
    await context?.cleanup();
  }, 120_000);

  it("uses the production dbt path to split a legacy Wahoo/Peloton component, preserve its valid B-C edge, and roll back only local time", async () => {
    await seedProductionDbtFixture(client, database);
    configureDbtEnvironment(database);
    await runActivityIntegrityDbtBuild({
      userId: TEST_USER_ID,
      activityIds: [wahooActivityId, pelotonActivityId, namedZoneActivityId, unrelatedActivityId],
    });
    await seedLegacyFalseComponent(client, database);
    const unrelatedBefore = await taskThreeRowsForActivity(client, database, unrelatedActivityId);
    const [repaired] = await Promise.all([
      repairActivityDataIntegrity(
        context.db,
        scopedClient,
        {
          execute: true,
          userId: TEST_USER_ID,
          startAt: new Date("2026-09-01T00:00:00.000Z"),
          endAt: new Date("2026-09-02T00:00:00.000Z"),
          batchSize: 10,
          maxBatches: 1,
          artifactDirectory,
          acceptanceOwner: "data-on-call@example.com",
          acceptanceDeadline: new Date("2026-09-03T18:01:00.000Z"),
        },
        {
          now: () => new Date("2026-09-02T18:01:00.000Z"),
          generateRunId: randomUUID,
          cdcReadinessPollIntervalMs: 10,
        },
      ),
      mirrorPostgresCommit(context, client, database),
    ]);

    expect(repaired).toMatchObject({
      selected: 3,
      changed: 2,
      updated: 2,
      beforeComponentCount: 1,
      afterComponentCount: 2,
    });
    await expect(clickHouseLocalTimeContext(client, database, pelotonActivityId)).resolves.toEqual({
      timezone: null,
      start_utc_offset_minutes: -240,
      end_utc_offset_minutes: -240,
      local_time_source: "provider_offset",
    });
    await assertCorrectDerivedActivityState(client, database, "repaired");
    await expect(activityIntegrityJournalPhase(context, repaired.runId)).resolves.toBe("executed");
    expect(await postgresLocalTimeContext(context, pelotonActivityId)).toEqual({
      timezone: null,
      start_utc_offset_minutes: -240,
      end_utc_offset_minutes: -240,
      local_time_source: "provider_offset",
    });
    expect(await postgresLocalTimeContext(context, namedZoneActivityId)).toEqual({
      timezone: "America/New_York",
      start_utc_offset_minutes: -240,
      end_utc_offset_minutes: -240,
      local_time_source: "provider_timezone",
    });
    await context.db.execute(sql`
      UPDATE fitness.activity
      SET name = 'Provider title updated after repair', raw = '{"revision":"later-provider-sync"}'::jsonb
      WHERE id = ${pelotonActivityId}::uuid
    `);
    const [rolledBack] = await Promise.all([
      rollbackActivityDataIntegrity(context.db, scopedClient, repaired.artifactPath, {
        now: () => new Date("2026-09-02T18:02:00.000Z"),
      }),
      mirrorPostgresRollback(context, client, database),
    ]);
    expect(rolledBack).toMatchObject({ runId: repaired.runId, updated: 2 });
    await assertCorrectDerivedActivityState(client, database, "rolled back");
    await expect(activityIntegrityJournalPhase(context, repaired.runId)).resolves.toBe(
      "rolled_back",
    );
    expect(await postgresLocalTimeContext(context, pelotonActivityId)).toEqual({
      timezone: "Etc/GMT+4",
      start_utc_offset_minutes: -300,
      end_utc_offset_minutes: -300,
      local_time_source: "provider_timezone",
    });
    await expect(postgresActivityName(context, pelotonActivityId)).resolves.toBe(
      "Provider title updated after repair",
    );
    await expect(taskThreeRowsForActivity(client, database, unrelatedActivityId)).resolves.toEqual(
      unrelatedBefore,
    );
    const artifact = JSON.parse(await readFile(repaired.artifactPath, "utf8"));
    expect(artifact).toMatchObject({ phase: "rolled_back", rollbackEligibility: "not_applicable" });
  }, 300_000);
});

async function seedPostgres(context: TestContext): Promise<void> {
  await context.db.execute(sql`
    DELETE FROM fitness.activity
    WHERE id IN (${wahooActivityId}::uuid, ${pelotonActivityId}::uuid, ${namedZoneActivityId}::uuid)
  `);
  await context.db.execute(sql`
    INSERT INTO fitness.activity (
      id, provider_id, user_id, external_id, canonical_type, provider_type,
      started_at, ended_at, timezone, start_utc_offset_minutes,
      end_utc_offset_minutes, local_time_source
    ) VALUES
      (
        ${wahooActivityId}::uuid, 'wahoo', ${TEST_USER_ID}::uuid, 'wahoo-ride',
        'other', 'workout', '2026-09-01T14:50:00Z', '2026-09-01T15:30:00Z',
        NULL, NULL, NULL, 'unknown'
      ),
      (
        ${pelotonActivityId}::uuid, 'peloton', ${TEST_USER_ID}::uuid, 'peloton-ride',
        'cycling', 'cycling', '2026-09-01T14:55:54Z', '2026-09-01T15:25:54Z',
        'Etc/GMT+4', -300, -300, 'provider_timezone'
      ),
      (
        ${namedZoneActivityId}::uuid, 'wahoo', ${TEST_USER_ID}::uuid, 'named-zone-ride',
        'cycling', 'cycling', '2026-09-01T15:00:00Z', '2026-09-01T15:30:00Z',
        'America/New_York', -420, -420, 'provider_timezone'
      )
  `);
}

function configureDbtEnvironment(database: string): void {
  process.env.DBT_TARGET = "dev";
  process.env.DBT_CLICKHOUSE_SCHEMA = database;
  process.env.DBT_ANALYTICS_SOURCE_SCHEMA = database;
  process.env.DBT_INGEST_SOURCE_SCHEMA = database;
  process.env.DBT_POSTGRES_FITNESS_SOURCE_SCHEMA = database;
}

async function seedProductionDbtFixture(
  client: NativeClickHouseClient,
  database: string,
): Promise<void> {
  const statements = [
    `DROP DATABASE IF EXISTS ${database} SYNC`,
    `CREATE DATABASE ${database}`,
    `CREATE TABLE ${database}.activity (
      id UUID,
      provider_id String,
      user_id UUID,
      external_id String,
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
      local_time_source String,
      raw String,
      provider_absent_at Nullable(DateTime64(6, 'UTC')),
      deleted_at Nullable(DateTime64(6, 'UTC')),
      _peerdb_is_deleted UInt8,
      _peerdb_synced_at DateTime64(9, 'UTC'),
      _peerdb_version UInt64
    ) ENGINE = ReplacingMergeTree(_peerdb_version) ORDER BY id`,
    `CREATE TABLE ${database}.provider_priority (
      provider_id String,
      priority Int16,
      _peerdb_is_deleted UInt8
    ) ENGINE = ReplacingMergeTree() ORDER BY provider_id`,
    `CREATE TABLE ${database}.device_priority (
      provider_id String,
      source_name_pattern String,
      priority Int16,
      _peerdb_is_deleted UInt8
    ) ENGINE = ReplacingMergeTree() ORDER BY (provider_id, source_name_pattern)`,
    `CREATE TABLE ${database}.deduped_sensor (
      user_id UUID,
      recorded_at DateTime64(6, 'UTC'),
      recorded_date Date,
      channel String,
      scalar Nullable(Float64),
      is_deleted UInt8,
      refreshed_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree(refreshed_at)
      ORDER BY (user_id, channel, recorded_at)`,
    `CREATE TABLE ${database}.activity_sensor_sample (
      activity_id UUID,
      user_id UUID,
      recorded_at DateTime64(6, 'UTC'),
      recorded_date Date,
      channel String,
      scalar Nullable(Float64),
      refresh_version UInt64,
      is_deleted UInt8,
      refreshed_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, activity_id, recorded_date, channel, recorded_at)`,
    `CREATE TABLE ${database}.activity_location_summary_rows (
      activity_id UUID,
      user_id UUID,
      total_distance Nullable(Float64),
      centroid_lat Nullable(Float64),
      centroid_lng Nullable(Float64),
      refresh_version UInt64,
      is_deleted UInt8,
      refreshed_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id)`,
    `INSERT INTO ${database}.activity VALUES
      (
        '${wahooActivityId}', 'wahoo', '${TEST_USER_ID}', 'wahoo-ride', 'other',
        'workout', NULL, toDateTime64('2026-09-01 14:50:00', 6, 'UTC'),
        toDateTime64('2026-09-01 15:30:00', 6, 'UTC'), NULL, 'Wahoo ride', NULL,
        NULL, NULL, NULL, 'unknown', '{}', NULL, NULL, 0,
        toDateTime64('2026-09-02 17:00:00', 9, 'UTC'), 1
      ),
      (
        '${pelotonActivityId}', 'peloton', '${TEST_USER_ID}', 'peloton-ride', 'cycling',
        'cycling', 'indoor', toDateTime64('2026-09-01 14:55:54', 6, 'UTC'),
        toDateTime64('2026-09-01 15:25:54', 6, 'UTC'), NULL, 'Peloton ride', NULL,
        'Etc/GMT+4', -300, -300, 'provider_timezone', '{}', NULL, NULL, 0,
        toDateTime64('2026-09-02 17:00:00', 9, 'UTC'), 1
      ),
      (
        '${namedZoneActivityId}', 'wahoo', '${TEST_USER_ID}', 'named-zone-ride', 'cycling',
        'cycling', NULL, toDateTime64('2026-09-01 15:00:00', 6, 'UTC'),
        toDateTime64('2026-09-01 15:30:00', 6, 'UTC'), NULL, 'Named zone ride', NULL,
        'America/New_York', -420, -420, 'provider_timezone', '{}', NULL, NULL, 0,
        toDateTime64('2026-09-02 17:00:00', 9, 'UTC'), 1
      ),
      (
        '${unrelatedActivityId}', 'wahoo', '${TEST_USER_ID}', 'unrelated-ride', 'cycling',
        'cycling', NULL, toDateTime64('2026-08-01 16:00:00', 6, 'UTC'),
        toDateTime64('2026-08-01 17:00:00', 6, 'UTC'), NULL, 'Unrelated ride', NULL,
        'America/New_York', -240, -240, 'provider_timezone', '{}', NULL, NULL, 0,
        toDateTime64('2026-09-02 17:00:00', 9, 'UTC'), 1
      )`,
  ];
  for (const statement of statements) await client.command({ query: statement });
}

async function seedLegacyFalseComponent(
  client: NativeClickHouseClient,
  database: string,
): Promise<void> {
  const refreshVersion = "toUInt64(toUnixTimestamp64Nano(now64(9)) - 1000000)";
  await client.command({
    query: `INSERT INTO ${database}.activity_duplicate_matches VALUES
      ('${wahooActivityId}', '${pelotonActivityId}', 0.95, ${refreshVersion}, 0, now64(9))`,
  });
  await client.command({
    query: `INSERT INTO ${database}.activity_duplicate_groups VALUES
      ('${wahooActivityId}', '${wahooActivityId}', ${refreshVersion}, 0, now64(9)),
      ('${pelotonActivityId}', '${wahooActivityId}', ${refreshVersion}, 0, now64(9)),
      ('${namedZoneActivityId}', '${wahooActivityId}', ${refreshVersion}, 0, now64(9))`,
  });
}

async function mirrorPostgresCommit(
  context: TestContext,
  client: NativeClickHouseClient,
  database: string,
): Promise<void> {
  const deadline = performance.now() + CDC_FIXTURE_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const peloton = await postgresLocalTimeContext(context, pelotonActivityId);
    const namedZone = await postgresLocalTimeContext(context, namedZoneActivityId);
    if (
      peloton?.timezone === null &&
      peloton?.start_utc_offset_minutes === -240 &&
      namedZone?.start_utc_offset_minutes === -240
    ) {
      await client.command({
        query: `INSERT INTO ${database}.activity
          SELECT * REPLACE(
            CAST(NULL, 'Nullable(String)') AS timezone,
            toInt16(-240) AS start_utc_offset_minutes,
            toInt16(-240) AS end_utc_offset_minutes,
            'provider_offset' AS local_time_source,
            now64(9) AS _peerdb_synced_at,
            _peerdb_version + 100 AS _peerdb_version
          )
          FROM ${database}.activity FINAL
          WHERE id = '${pelotonActivityId}'`,
      });
      await client.command({
        query: `INSERT INTO ${database}.activity
          SELECT * REPLACE(
            toInt16(-240) AS start_utc_offset_minutes,
            toInt16(-240) AS end_utc_offset_minutes,
            now64(9) AS _peerdb_synced_at,
            _peerdb_version + 100 AS _peerdb_version
          )
          FROM ${database}.activity FINAL
          WHERE id = '${namedZoneActivityId}'`,
      });
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("PostgreSQL repair commit was not observed by the integration CDC fixture");
}

async function mirrorPostgresRollback(
  context: TestContext,
  client: NativeClickHouseClient,
  database: string,
): Promise<void> {
  const deadline = performance.now() + CDC_FIXTURE_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const peloton = await postgresActivity(context, pelotonActivityId);
    const namedZone = await postgresActivity(context, namedZoneActivityId);
    if (
      peloton?.timezone === "Etc/GMT+4" &&
      peloton.start_utc_offset_minutes === -300 &&
      peloton.name === "Provider title updated after repair" &&
      namedZone?.timezone === "America/New_York" &&
      namedZone.start_utc_offset_minutes === -420
    ) {
      await client.command({
        query: `INSERT INTO ${database}.activity
          SELECT * REPLACE(
            'Provider title updated after repair' AS name,
            'Etc/GMT+4' AS timezone,
            toInt16(-300) AS start_utc_offset_minutes,
            toInt16(-300) AS end_utc_offset_minutes,
            'provider_timezone' AS local_time_source,
            now64(9) AS _peerdb_synced_at,
            _peerdb_version + 100 AS _peerdb_version
          )
          FROM ${database}.activity FINAL
          WHERE id = '${pelotonActivityId}'`,
      });
      await client.command({
        query: `INSERT INTO ${database}.activity
          SELECT * REPLACE(
            toInt16(-420) AS start_utc_offset_minutes,
            toInt16(-420) AS end_utc_offset_minutes,
            now64(9) AS _peerdb_synced_at,
            _peerdb_version + 100 AS _peerdb_version
          )
          FROM ${database}.activity FINAL
          WHERE id = '${namedZoneActivityId}'`,
      });
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("PostgreSQL rollback commit was not observed by the integration CDC fixture");
}

async function clickHouseLocalTimeContext(
  client: NativeClickHouseClient,
  database: string,
  activityId: string,
) {
  const response = await client.query({
    query: `SELECT
        timezone,
        start_utc_offset_minutes,
        end_utc_offset_minutes,
        local_time_source
      FROM ${database}.activity_source_records FINAL
      WHERE activity_id = {activityId:UUID} AND is_deleted = 0`,
    query_params: { activityId },
    format: "JSONEachRow",
  });
  return (await response.json())[0];
}

const affectedActivityIds = [wahooActivityId, pelotonActivityId, namedZoneActivityId];
const affectedActivityIdList = affectedActivityIds
  .map((activityId) => `'${activityId}'`)
  .join(", ");

async function queryDerivedRows<T extends object>(
  client: NativeClickHouseClient,
  query: string,
): Promise<T[]> {
  const response = await client.query({ query, format: "JSONEachRow" });
  return response.json<T>();
}

async function assertCorrectDerivedActivityState(
  client: NativeClickHouseClient,
  database: string,
  lifecycle: "repaired" | "rolled back",
): Promise<void> {
  const sourceRows = await queryDerivedRows<{
    activity_id: string;
    provider_id: string;
    canonical_type: string;
    timezone: string | null;
    start_utc_offset_minutes: number | null;
    end_utc_offset_minutes: number | null;
    local_time_source: string;
  }>(
    client,
    `SELECT
        toString(activity_id) AS activity_id,
        provider_id,
        canonical_type,
        timezone,
        start_utc_offset_minutes,
        end_utc_offset_minutes,
        local_time_source
      FROM ${database}.activity_source_records FINAL
      WHERE is_deleted = 0 AND activity_id IN (${affectedActivityIdList})
      ORDER BY activity_id`,
  );
  const matches = await queryDerivedRows<{
    activity_id: string;
    duplicate_activity_id: string;
  }>(
    client,
    `SELECT toString(activity_id) AS activity_id, toString(duplicate_activity_id) AS duplicate_activity_id
      FROM ${database}.activity_duplicate_matches FINAL
      WHERE is_deleted = 0
        AND activity_id IN (${affectedActivityIdList})
        AND duplicate_activity_id IN (${affectedActivityIdList})
      ORDER BY activity_id, duplicate_activity_id`,
  );
  const groups = await queryDerivedRows<{ activity_id: string; group_id: string }>(
    client,
    `SELECT toString(activity_id) AS activity_id, group_id
      FROM ${database}.activity_duplicate_groups FINAL
      WHERE is_deleted = 0 AND activity_id IN (${affectedActivityIdList})
      ORDER BY activity_id`,
  );
  const dedupedRows = await queryDerivedRows<{
    activity_id: string;
    member_activity_ids: string[];
  }>(
    client,
    `SELECT
        toString(activity_id) AS activity_id,
        arrayMap(value -> toString(value), member_activity_ids) AS member_activity_ids
      FROM ${database}.deduped_activities FINAL
      WHERE is_deleted = 0 AND hasAny(member_activity_ids, [${affectedActivityIdList}])
      ORDER BY activity_id`,
  );
  const memberRows = await queryDerivedRows<{
    activity_id: string;
    member_activity_id: string;
  }>(
    client,
    `SELECT toString(activity_id) AS activity_id, toString(member_activity_id) AS member_activity_id
      FROM ${database}.deduped_activity_members FINAL
      WHERE is_deleted = 0 AND member_activity_id IN (${affectedActivityIdList})
      ORDER BY member_activity_id`,
  );
  const sensorSummaryRows = await queryDerivedRows<{ activity_id: string }>(
    client,
    `SELECT toString(activity_id) AS activity_id
      FROM ${database}.activity_sensor_summary_rows FINAL
      WHERE is_deleted = 0 AND activity_id IN (${affectedActivityIdList})
      ORDER BY activity_id`,
  );
  const summaryRows = await queryDerivedRows<{ activity_id: string }>(
    client,
    `SELECT toString(activity_id) AS activity_id
      FROM ${database}.activity_summary_rows FINAL
      WHERE is_deleted = 0 AND activity_id IN (${affectedActivityIdList})
      ORDER BY activity_id`,
  );

  const expectedPeloton =
    lifecycle === "repaired"
      ? {
          timezone: null,
          start_utc_offset_minutes: -240,
          end_utc_offset_minutes: -240,
          local_time_source: "provider_offset",
        }
      : {
          timezone: "Etc/GMT+4",
          start_utc_offset_minutes: -300,
          end_utc_offset_minutes: -300,
          local_time_source: "provider_timezone",
        };
  const expectedNamedZone =
    lifecycle === "repaired"
      ? {
          timezone: "America/New_York",
          start_utc_offset_minutes: -240,
          end_utc_offset_minutes: -240,
          local_time_source: "provider_timezone",
        }
      : {
          timezone: "America/New_York",
          start_utc_offset_minutes: -420,
          end_utc_offset_minutes: -420,
          local_time_source: "provider_timezone",
        };

  expect(sourceRows).toEqual([
    {
      activity_id: wahooActivityId,
      provider_id: "wahoo",
      canonical_type: "other",
      timezone: null,
      start_utc_offset_minutes: null,
      end_utc_offset_minutes: null,
      local_time_source: "unknown",
    },
    {
      activity_id: pelotonActivityId,
      provider_id: "peloton",
      canonical_type: "cycling",
      ...expectedPeloton,
    },
    {
      activity_id: namedZoneActivityId,
      provider_id: "wahoo",
      canonical_type: "cycling",
      ...expectedNamedZone,
    },
  ]);
  expect(matches.map((row) => [row.activity_id, row.duplicate_activity_id].sort())).toEqual([
    [pelotonActivityId, namedZoneActivityId].sort(),
  ]);
  const wahooGroup = groups.find((row) => row.activity_id === wahooActivityId)?.group_id;
  const pelotonGroup = groups.find((row) => row.activity_id === pelotonActivityId)?.group_id;
  const namedZoneGroup = groups.find((row) => row.activity_id === namedZoneActivityId)?.group_id;
  expect(wahooGroup).toBeTruthy();
  expect(pelotonGroup).toBeTruthy();
  expect(wahooGroup).not.toBe(pelotonGroup);
  expect(pelotonGroup).toBe(namedZoneGroup);
  expect(dedupedRows.map((row) => [...row.member_activity_ids].sort()).sort()).toEqual([
    [wahooActivityId],
    [pelotonActivityId, namedZoneActivityId].sort(),
  ]);
  expect(memberRows).toHaveLength(3);
  const wahooMembership = memberRows.find((row) => row.member_activity_id === wahooActivityId);
  const pelotonMembership = memberRows.find((row) => row.member_activity_id === pelotonActivityId);
  const namedZoneMembership = memberRows.find(
    (row) => row.member_activity_id === namedZoneActivityId,
  );
  expect(wahooMembership?.activity_id).not.toBe(pelotonMembership?.activity_id);
  expect(pelotonMembership?.activity_id).toBe(namedZoneMembership?.activity_id);
  const canonicalActivityIds = dedupedRows.map((row) => row.activity_id).sort();
  expect(sensorSummaryRows.map((row) => row.activity_id)).toEqual(canonicalActivityIds);
  expect(summaryRows.map((row) => row.activity_id)).toEqual(canonicalActivityIds);
}

async function taskThreeRowsForActivity(
  client: NativeClickHouseClient,
  database: string,
  activityId: string,
): Promise<Array<{ model: string; rows: unknown[] }>> {
  const models = [
    ["activity_source_records", "activity_id = {activityId:UUID}"],
    [
      "activity_duplicate_matches",
      "activity_id = {activityId:UUID} OR duplicate_activity_id = {activityId:UUID}",
    ],
    ["activity_duplicate_groups", "activity_id = {activityId:UUID}"],
    [
      "deduped_activities",
      "activity_id = {activityId:UUID} OR has(member_activity_ids, {activityId:UUID})",
    ],
    [
      "deduped_activity_members",
      "activity_id = {activityId:UUID} OR member_activity_id = {activityId:UUID}",
    ],
    ["activity_sensor_summary_rows", "activity_id = {activityId:UUID}"],
    ["activity_summary_rows", "activity_id = {activityId:UUID}"],
  ] as const;
  const snapshots = [];
  for (const [model, filter] of models) {
    const response = await client.query({
      query: `SELECT * REPLACE(toString(refresh_version) AS refresh_version)
        FROM ${database}.${model} FINAL
        WHERE ${filter}
        ORDER BY tuple(*)`,
      query_params: { activityId },
      format: "JSONEachRow",
      clickhouse_settings: { output_format_json_quote_64bit_integers: 1 },
    });
    snapshots.push({ model, rows: await response.json() });
  }
  return snapshots;
}

function scopeClickHouseClient(
  client: NativeClickHouseClient,
  database: string,
): ActivityIntegrityClickHouseClient {
  const scope = (query: string) =>
    query.replaceAll("analytics.", `${database}.`).replaceAll("postgres_fitness.", `${database}.`);
  return {
    query: async (options) => {
      const result = await client.query({ ...options, query: scope(options.query) });
      return { json: () => result.json() };
    },
    insert: (options) =>
      client.insert({ ...options, table: scope(options.table), values: [...options.values] }),
  };
}

async function postgresLocalTimeContext(context: TestContext, activityId: string) {
  const rows = await context.db.execute(sql`
    SELECT timezone, start_utc_offset_minutes::integer, end_utc_offset_minutes::integer,
      local_time_source
    FROM fitness.activity
    WHERE id = ${activityId}::uuid
  `);
  return rows[0];
}

async function postgresActivity(context: TestContext, activityId: string) {
  const rows = await context.db.execute<{
    timezone: string | null;
    start_utc_offset_minutes: number | null;
    end_utc_offset_minutes: number | null;
    local_time_source: string;
    name: string | null;
  }>(sql`
    SELECT
      timezone,
      start_utc_offset_minutes::integer,
      end_utc_offset_minutes::integer,
      local_time_source,
      name
    FROM fitness.activity
    WHERE id = ${activityId}::uuid
  `);
  return rows[0];
}

async function postgresActivityName(
  context: TestContext,
  activityId: string,
): Promise<string | null> {
  return (await postgresActivity(context, activityId))?.name ?? null;
}

async function activityIntegrityJournalPhase(
  context: TestContext,
  runId: string,
): Promise<string | null> {
  const rows = await context.db.execute<{ phase: string }>(sql`
    SELECT phase
    FROM fitness.activity_integrity_repair_journal
    WHERE run_id = ${runId}::uuid
  `);
  return rows[0]?.phase ?? null;
}
