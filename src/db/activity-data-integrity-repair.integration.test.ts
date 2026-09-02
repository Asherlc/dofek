import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
const initialVersion = "9007199254740993";
const unrelatedActivityId = "9f99f9a7-0000-4000-8000-000000000001";

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
    await seedClickHouse(client, database);
    await rm(artifactDirectory, { recursive: true, force: true });
    await mkdir(artifactDirectory, { mode: 0o700 });
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
      await client.close();
    }
    if (artifactDirectory) await rm(artifactDirectory, { recursive: true, force: true });
    await context?.cleanup();
  }, 120_000);

  it("runs the production dbt path with an affected-key scope and preserves unrelated rows", async () => {
    await seedProductionDbtFixture(client, database);
    configureDbtEnvironment(database);
    await runActivityIntegrityDbtBuild({
      userId: TEST_USER_ID,
      activityIds: [wahooActivityId, pelotonActivityId, namedZoneActivityId, unrelatedActivityId],
    });
    const unrelatedBefore = await taskThreeRowsForActivity(client, database, unrelatedActivityId);
    const mirrorCommittedRows = mirrorPostgresCommit(context, client, database);
    const repaired = await repairActivityDataIntegrity(
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
    );
    await mirrorCommittedRows;

    expect(repaired).toMatchObject({ selected: 3, changed: 2, updated: 2 });
    await expect(clickHouseLocalTimeContext(client, database, pelotonActivityId)).resolves.toEqual({
      timezone: null,
      start_utc_offset_minutes: -240,
      end_utc_offset_minutes: -240,
      local_time_source: "provider_offset",
    });
    await expect(taskThreeRowsForActivity(client, database, unrelatedActivityId)).resolves.toEqual(
      unrelatedBefore,
    );
  }, 300_000);

  it("splits the false Wahoo/Peloton component, normalizes time, and rolls captured rows forward", async () => {
    const bounds = {
      userId: TEST_USER_ID,
      startAt: new Date("2026-09-01T00:00:00.000Z"),
      endAt: new Date("2026-09-02T00:00:00.000Z"),
      batchSize: 10,
      maxBatches: 1,
    };
    const dryRun = await repairActivityDataIntegrity(
      context.db,
      scopedClient,
      { ...bounds, execute: false, artifactDirectory },
      {
        now: () => new Date("2026-09-02T18:00:00.000Z"),
        generateRunId: randomUUID,
        rebuildReadModels: () => Promise.reject(new Error("dry run must not rebuild")),
      },
    );
    expect(dryRun).toMatchObject({ selected: 3, changed: 2, updated: 0 });
    await expect(postgresLocalTimeContext(context, pelotonActivityId)).resolves.toMatchObject({
      timezone: "Etc/GMT+4",
      start_utc_offset_minutes: -300,
    });

    const mirrorCommittedRows = mirrorPostgresCommit(context, client, database);
    const repaired = await repairActivityDataIntegrity(
      context.db,
      scopedClient,
      {
        ...bounds,
        execute: true,
        artifactDirectory,
        acceptanceOwner: "data-on-call@example.com",
        acceptanceDeadline: new Date("2026-09-03T18:00:00.000Z"),
      },
      {
        now: () => new Date("2026-09-02T18:01:00.000Z"),
        generateRunId: randomUUID,
        rebuildReadModels: () => rebuildTaskThreeModels(context, client, database),
      },
    );
    await mirrorCommittedRows;

    expect(repaired).toMatchObject({
      selected: 3,
      changed: 2,
      updated: 2,
      beforeComponentCount: 2,
      afterComponentCount: 3,
      incompatibleMemberCount: 0,
    });
    const repairedGroups = await currentGroups(client, database);
    expect(groupFor(repairedGroups, wahooActivityId)).not.toBe(
      groupFor(repairedGroups, pelotonActivityId),
    );
    expect(await currentDedupedMembership(client, database)).toEqual([
      { activity_id: wahooActivityId, member_activity_ids: [wahooActivityId] },
      { activity_id: pelotonActivityId, member_activity_ids: [pelotonActivityId] },
      { activity_id: namedZoneActivityId, member_activity_ids: [namedZoneActivityId] },
    ]);
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
    expect(
      await finalRowCount(client, database, "activity_duplicate_groups", wahooActivityId),
    ).toBe(1);

    const artifact = JSON.parse(await readFile(repaired.artifactPath, "utf8"));
    const repairedVersion = BigInt(artifact.execution.highestDerivedVersion);

    await context.db.execute(sql`
      UPDATE fitness.activity
      SET start_utc_offset_minutes = -180
      WHERE id = ${pelotonActivityId}::uuid
    `);
    await expect(
      rollbackActivityDataIntegrity(context.db, scopedClient, repaired.artifactPath),
    ).rejects.toThrow("stale audit artifact");
    await context.db.execute(sql`
      UPDATE fitness.activity
      SET start_utc_offset_minutes = -240
      WHERE id = ${pelotonActivityId}::uuid
    `);

    const rolledBack = await rollbackActivityDataIntegrity(
      context.db,
      scopedClient,
      repaired.artifactPath,
      { now: () => new Date("2026-09-02T18:02:00.000Z") },
    );
    expect(BigInt(rolledBack.refreshVersion)).toBeGreaterThan(repairedVersion);
    const rolledBackGroups = await currentGroups(client, database);
    expect(groupFor(rolledBackGroups, wahooActivityId)).toBe(
      groupFor(rolledBackGroups, pelotonActivityId),
    );
    expect(await currentDedupedMembership(client, database)).toEqual([
      {
        activity_id: wahooActivityId,
        member_activity_ids: [wahooActivityId, pelotonActivityId],
      },
      { activity_id: namedZoneActivityId, member_activity_ids: [namedZoneActivityId] },
    ]);
    expect(await postgresLocalTimeContext(context, pelotonActivityId)).toEqual({
      timezone: "Etc/GMT+4",
      start_utc_offset_minutes: -300,
      end_utc_offset_minutes: -300,
      local_time_source: "provider_timezone",
    });
    const finalVersion = await groupVersion(client, database, wahooActivityId);
    expect(BigInt(finalVersion)).toBe(BigInt(rolledBack.refreshVersion));
    expect(
      await finalRowCount(client, database, "activity_duplicate_groups", wahooActivityId),
    ).toBe(1);
  }, 240_000);
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
        'cycling', 'cycling', '2026-09-01T16:00:00Z', '2026-09-01T17:00:00Z',
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
    `CREATE TABLE ${database}.activity_sensor_sample (
      activity_id UUID,
      user_id UUID,
      recorded_at DateTime64(6, 'UTC'),
      channel String,
      scalar Nullable(Float64),
      refresh_version UInt64,
      is_deleted UInt8
    ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, activity_id, channel, recorded_at)`,
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
        'cycling', NULL, toDateTime64('2026-09-01 16:00:00', 6, 'UTC'),
        toDateTime64('2026-09-01 17:00:00', 6, 'UTC'), NULL, 'Named zone ride', NULL,
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

async function mirrorPostgresCommit(
  context: TestContext,
  client: NativeClickHouseClient,
  database: string,
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
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

async function seedClickHouse(client: NativeClickHouseClient, database: string): Promise<void> {
  const statements = [
    `DROP DATABASE IF EXISTS ${database} SYNC`,
    `CREATE DATABASE ${database}`,
    `CREATE TABLE ${database}.activity_source_records (
      activity_id UUID,
      provider_id String,
      user_id UUID,
      external_id String,
      canonical_type String,
      started_at DateTime64(6, 'UTC'),
      ended_at Nullable(DateTime64(6, 'UTC')),
      timezone Nullable(String),
      start_utc_offset_minutes Nullable(Int16),
      end_utc_offset_minutes Nullable(Int16),
      local_time_source LowCardinality(String),
      refresh_version UInt64,
      is_deleted UInt8,
      refreshed_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY activity_id`,
    `CREATE TABLE ${database}.source_activity (
      id UUID,
      user_id UUID,
      provider_id String,
      canonical_type String,
      started_at DateTime64(6, 'UTC'),
      ended_at Nullable(DateTime64(6, 'UTC')),
      _peerdb_is_deleted UInt8,
      provider_absent_at Nullable(DateTime64(6, 'UTC')),
      deleted_at Nullable(DateTime64(6, 'UTC'))
    ) ENGINE = ReplacingMergeTree() ORDER BY id`,
    `CREATE TABLE ${database}.activity (
      id UUID,
      provider_id String,
      user_id UUID,
      canonical_type String,
      timezone Nullable(String),
      start_utc_offset_minutes Nullable(Int16),
      end_utc_offset_minutes Nullable(Int16),
      local_time_source String,
      _peerdb_is_deleted UInt8,
      _peerdb_synced_at DateTime64(9, 'UTC'),
      _peerdb_version UInt64
    ) ENGINE = ReplacingMergeTree(_peerdb_version) ORDER BY id`,
    `CREATE TABLE ${database}.activity_duplicate_matches (
      activity_id UUID,
      duplicate_activity_id UUID,
      overlap_ratio Nullable(Float64),
      refresh_version UInt64,
      is_deleted UInt8,
      refreshed_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (activity_id, duplicate_activity_id)`,
    `CREATE TABLE ${database}.activity_duplicate_groups (
      activity_id UUID,
      group_id Nullable(String),
      refresh_version UInt64,
      is_deleted UInt8,
      refreshed_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY activity_id`,
    `CREATE TABLE ${database}.deduped_activities (
      activity_id UUID,
      user_id UUID,
      provider_id String,
      canonical_type String,
      member_activity_ids Array(UUID),
      refresh_version UInt64,
      is_deleted UInt8,
      refreshed_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY activity_id`,
    `CREATE TABLE ${database}.deduped_activity_members (
      activity_id UUID,
      user_id UUID,
      member_activity_id UUID,
      refresh_version UInt64,
      is_deleted UInt8,
      refreshed_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, member_activity_id)`,
    `CREATE TABLE ${database}.activity_summary_rows (
      activity_id UUID,
      user_id UUID,
      marker String,
      refresh_version UInt64,
      is_deleted UInt8,
      refreshed_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY activity_id`,
    `CREATE TABLE ${database}.activity_sensor_summary_rows (
      activity_id UUID,
      user_id UUID,
      refresh_version UInt64,
      is_deleted UInt8,
      refreshed_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY activity_id`,
    `INSERT INTO ${database}.activity VALUES
      ('${wahooActivityId}', 'wahoo', '${TEST_USER_ID}', 'other', NULL, NULL, NULL,
       'unknown', 0, now64(9), 1),
      ('${pelotonActivityId}', 'peloton', '${TEST_USER_ID}', 'cycling', 'Etc/GMT+4', -300, -300,
       'provider_timezone', 0, now64(9), 1),
      ('${namedZoneActivityId}', 'wahoo', '${TEST_USER_ID}', 'cycling', 'America/New_York', -420, -420,
       'provider_timezone', 0, now64(9), 1)`,
    `INSERT INTO ${database}.activity_source_records VALUES
      ('${wahooActivityId}', 'wahoo', '${TEST_USER_ID}', 'wahoo-ride', 'other',
       toDateTime64('2026-09-01 14:50:00', 6, 'UTC'), toDateTime64('2026-09-01 15:30:00', 6, 'UTC'),
       NULL, NULL, NULL, 'unknown', ${initialVersion}, 0, now64(9)),
      ('${pelotonActivityId}', 'peloton', '${TEST_USER_ID}', 'peloton-ride', 'cycling',
       toDateTime64('2026-09-01 14:55:54', 6, 'UTC'), toDateTime64('2026-09-01 15:25:54', 6, 'UTC'),
       'Etc/GMT+4', -300, -300, 'provider_timezone', ${initialVersion}, 0, now64(9)),
      ('${namedZoneActivityId}', 'wahoo', '${TEST_USER_ID}', 'named-zone-ride', 'cycling',
       toDateTime64('2026-09-01 16:00:00', 6, 'UTC'), toDateTime64('2026-09-01 17:00:00', 6, 'UTC'),
       'America/New_York', -420, -420, 'provider_timezone', ${initialVersion}, 0, now64(9))`,
    `INSERT INTO ${database}.activity_duplicate_matches VALUES
      ('${wahooActivityId}', '${pelotonActivityId}', 0.95, ${initialVersion}, 0, now64(9))`,
    `INSERT INTO ${database}.activity_duplicate_groups VALUES
      ('${wahooActivityId}', '${wahooActivityId}', ${initialVersion}, 0, now64(9)),
      ('${pelotonActivityId}', '${wahooActivityId}', ${initialVersion}, 0, now64(9)),
      ('${namedZoneActivityId}', '${namedZoneActivityId}', ${initialVersion}, 0, now64(9))`,
    `INSERT INTO ${database}.deduped_activities VALUES
      ('${wahooActivityId}', '${TEST_USER_ID}', 'wahoo', 'other', ['${wahooActivityId}', '${pelotonActivityId}'], ${initialVersion}, 0, now64(9)),
      ('${namedZoneActivityId}', '${TEST_USER_ID}', 'wahoo', 'cycling', ['${namedZoneActivityId}'], ${initialVersion}, 0, now64(9))`,
    `INSERT INTO ${database}.deduped_activity_members VALUES
      ('${wahooActivityId}', '${TEST_USER_ID}', '${wahooActivityId}', ${initialVersion}, 0, now64(9)),
      ('${wahooActivityId}', '${TEST_USER_ID}', '${pelotonActivityId}', ${initialVersion}, 0, now64(9)),
      ('${namedZoneActivityId}', '${TEST_USER_ID}', '${namedZoneActivityId}', ${initialVersion}, 0, now64(9))`,
    `INSERT INTO ${database}.activity_summary_rows VALUES
      ('${wahooActivityId}', '${TEST_USER_ID}', 'before', ${initialVersion}, 0, now64(9)),
      ('${namedZoneActivityId}', '${TEST_USER_ID}', 'before', ${initialVersion}, 0, now64(9))`,
  ];
  for (const statement of statements) await client.command({ query: statement });
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

async function rebuildTaskThreeModels(
  context: TestContext,
  client: NativeClickHouseClient,
  database: string,
): Promise<void> {
  const rows = await context.db.execute<{
    id: string;
    provider_id: string;
    external_id: string;
    canonical_type: string;
    started_at: Date;
    ended_at: Date | null;
    timezone: string | null;
    start_utc_offset_minutes: number | null;
    end_utc_offset_minutes: number | null;
    local_time_source: string;
  }>(sql`
    SELECT id::text, provider_id, external_id, canonical_type, started_at, ended_at,
      timezone, start_utc_offset_minutes::integer, end_utc_offset_minutes::integer,
      local_time_source
    FROM fitness.activity
    WHERE id IN (${wahooActivityId}::uuid, ${pelotonActivityId}::uuid, ${namedZoneActivityId}::uuid)
    ORDER BY id
  `);
  await client.insert({
    table: `${database}.activity_source_records`,
    values: rows.map((row) => ({
      activity_id: row.id,
      provider_id: row.provider_id,
      user_id: TEST_USER_ID,
      external_id: row.external_id,
      canonical_type: row.canonical_type,
      started_at: new Date(row.started_at).toISOString(),
      ended_at: row.ended_at == null ? null : new Date(row.ended_at).toISOString(),
      timezone: row.timezone,
      start_utc_offset_minutes: row.start_utc_offset_minutes,
      end_utc_offset_minutes: row.end_utc_offset_minutes,
      local_time_source: row.local_time_source,
      refresh_version: "9007199254740994",
      is_deleted: 0,
      refreshed_at: "2026-09-02T18:01:00.000Z",
    })),
    format: "JSONEachRow",
  });
  await client.command({
    query: `INSERT INTO ${database}.activity_duplicate_matches\n${renderMatchesModel(database)}`,
  });
  await client.command({
    query: `INSERT INTO ${database}.activity_duplicate_groups\n${renderGroupsModel(database)}`,
  });
  const sourceRowsById = new Map(rows.map((row) => [row.id, row]));
  await client.insert({
    table: `${database}.deduped_activities`,
    values: [wahooActivityId, pelotonActivityId, namedZoneActivityId].map((activityId) => {
      const sourceRow = sourceRowsById.get(activityId);
      if (!sourceRow) throw new Error(`Missing source row for ${activityId}`);
      return {
        activity_id: activityId,
        user_id: TEST_USER_ID,
        provider_id: sourceRow.provider_id,
        canonical_type: sourceRow.canonical_type,
        member_activity_ids: [activityId],
        refresh_version: "9007199254740994",
        is_deleted: 0,
        refreshed_at: "2026-09-02T18:01:00.000Z",
      };
    }),
    format: "JSONEachRow",
  });
  await client.insert({
    table: `${database}.deduped_activity_members`,
    values: [wahooActivityId, pelotonActivityId, namedZoneActivityId].map((activityId) => ({
      activity_id: activityId,
      user_id: TEST_USER_ID,
      member_activity_id: activityId,
      refresh_version: "9007199254740994",
      is_deleted: 0,
      refreshed_at: "2026-09-02T18:01:00.000Z",
    })),
    format: "JSONEachRow",
  });
  await client.insert({
    table: `${database}.activity_summary_rows`,
    values: [wahooActivityId, pelotonActivityId, namedZoneActivityId].map((activityId) => ({
      activity_id: activityId,
      user_id: TEST_USER_ID,
      marker: "after",
      refresh_version: "9007199254740994",
      is_deleted: 0,
      refreshed_at: "2026-09-02T18:01:00.000Z",
    })),
    format: "JSONEachRow",
  });
}

function renderMatchesModel(database: string): string {
  return readModel("activity_duplicate_matches")
    .replace(/{% if is_incremental\(\) %}([\s\S]*?){% else %}([\s\S]*?){% endif %}/g, "$1")
    .replace(/{{ ref\('activity_source_records'\) }}/g, `${database}.activity_source_records`)
    .replace(/{{ source\('postgres_fitness', 'activity'\) }}/g, `${database}.source_activity`)
    .replace(/{{ this }}/g, `${database}.activity_duplicate_matches`)
    .concat("\nSETTINGS max_threads = 1");
}

function renderGroupsModel(database: string): string {
  return readModel("activity_duplicate_groups")
    .replace(/{% if is_incremental\(\) %}([\s\S]*?){% else %}([\s\S]*?){% endif %}/g, "$1")
    .replace(/{{ ref\('activity_source_records'\) }}/g, `${database}.activity_source_records`)
    .replace(/{{ ref\('activity_duplicate_matches'\) }}/g, `${database}.activity_duplicate_matches`)
    .replace(/{{ this }}/g, `${database}.activity_duplicate_groups`)
    .concat("\nSETTINGS max_threads = 1");
}

function readModel(name: string): string {
  const model = readFileSync(
    new URL(`../../analytics/models/read_models/${name}.sql`, import.meta.url),
    "utf8",
  ).replace(/{{ config\([\s\S]*?\) }}\s*/, "");
  return withoutActivityRefreshScope(model);
}

function withoutActivityRefreshScope(model: string): string {
  const lines = model.split("\n");
  const rendered: string[] = [];
  let disabledDepth = 0;
  for (const line of lines) {
    if (line.includes("{% set activity_refresh_scoped")) continue;
    if (disabledDepth === 0 && line.includes("{% if activity_refresh_scoped %}")) {
      disabledDepth = 1;
      continue;
    }
    if (disabledDepth > 0) {
      if (line.includes("{% if ")) disabledDepth += 1;
      if (line.includes("{% endif %}")) disabledDepth -= 1;
      continue;
    }
    rendered.push(line);
  }
  return rendered.join("\n");
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

async function currentGroups(client: NativeClickHouseClient, database: string) {
  const result = await client.query({
    query: `SELECT toString(activity_id) AS activity_id, group_id
      FROM ${database}.activity_duplicate_groups FINAL
      WHERE is_deleted = 0
      ORDER BY activity_id`,
    format: "JSONEachRow",
  });
  return result.json<{ activity_id: string; group_id: string }>();
}

async function currentDedupedMembership(client: NativeClickHouseClient, database: string) {
  const result = await client.query({
    query: `SELECT
        toString(activity_id) AS activity_id,
        arrayMap(value -> toString(value), member_activity_ids) AS member_activity_ids
      FROM ${database}.deduped_activities FINAL
      WHERE is_deleted = 0
      ORDER BY activity_id`,
    format: "JSONEachRow",
  });
  return result.json<{ activity_id: string; member_activity_ids: string[] }>();
}

function groupFor(rows: Array<{ activity_id: string; group_id: string }>, activityId: string) {
  return rows.find((row) => row.activity_id === activityId)?.group_id;
}

async function groupVersion(
  client: NativeClickHouseClient,
  database: string,
  activityId: string,
): Promise<string> {
  const result = await client.query({
    query: `SELECT toString(refresh_version) AS refresh_version
      FROM ${database}.activity_duplicate_groups FINAL
      WHERE activity_id = {activityId:UUID}`,
    query_params: { activityId },
    format: "JSONEachRow",
  });
  const rows = await result.json<{ refresh_version: string }>();
  return rows[0]?.refresh_version ?? "0";
}

async function finalRowCount(
  client: NativeClickHouseClient,
  database: string,
  table: string,
  activityId: string,
): Promise<number> {
  const result = await client.query({
    query: `SELECT count() AS row_count FROM ${database}.${table} FINAL
      WHERE activity_id = {activityId:UUID}`,
    query_params: { activityId },
    format: "JSONEachRow",
  });
  const rows = await result.json<{ row_count: string }>();
  return Number(rows[0]?.row_count ?? 0);
}
