import { randomBytes } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractCteSql, readModelSql, renderDbtModelSql } from "./read-model-sql-test-helpers.ts";

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
      query_params: { activityId: groupId },
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
      query_params: { activityId: groupId },
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
        activityId: groupId,
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
        activityId: groupId,
        providerId: "whoop",
        activityType: "cycling",
        providerType: "cycling",
      },
    ]);
  }, 180_000);

  it("keeps a named timezone and its offsets from the same member", async () => {
    const activeClient = requireClient(client);
    await seedNamedTimezoneContextFixture(activeClient, targetSchema);

    await activeClient.command({
      query: `INSERT INTO ${targetSchema}.deduped_activities
${renderDedupedActivitiesSelectSql(targetSchema)}`,
    });

    const result = await activeClient.query({
      query: `SELECT
          timezone,
          start_utc_offset_minutes AS startUtcOffsetMinutes,
          end_utc_offset_minutes AS endUtcOffsetMinutes,
          local_time_source AS localTimeSource
        FROM ${targetSchema}.deduped_activities FINAL
        WHERE is_deleted = 0`,
      format: "JSONEachRow",
    });

    expect(await result.json<LocalTimeContextRow>()).toEqual([
      {
        endUtcOffsetMinutes: -420,
        localTimeSource: "device_timezone",
        startUtcOffsetMinutes: -420,
        timezone: "America/Los_Angeles",
      },
    ]);
  }, 180_000);

  it("keeps the group key and all members when richer sensor payload changes the winner", async () => {
    const activeClient = requireClient(client);
    await seedSpecificActivityTypeFixture(activeClient, targetSchema);
    await activeClient.command({
      query: `INSERT INTO ${targetSchema}.deduped_activities ${renderDedupedActivitiesSelectSql(targetSchema)}`,
    });
    const before = await activeClient.query({
      query: `SELECT primary_activity_id, provider_id, canonical_type, name FROM ${targetSchema}.deduped_activities FINAL`,
      format: "JSONEachRow",
    });
    expect(await before.json()).toEqual([
      {
        primary_activity_id: linkedActivityId,
        provider_id: "whoop",
        canonical_type: "cycling",
        name: null,
      },
    ]);
    // The generic, higher-priority member now has more samples than the specific member.
    await activeClient.command({
      query: `INSERT INTO ${targetSchema}.deduped_sensor (user_id, provider_id, recorded_at, channel) VALUES
        ('${testUserId}', 'peloton', '2026-07-05 16:10:00', 'heart_rate'),
        ('${testUserId}', 'peloton', '2026-07-05 16:11:00', 'heart_rate')`,
    });
    await activeClient.command({
      query: `INSERT INTO ${targetSchema}.deduped_activities ${renderDedupedActivitiesSelectSql(targetSchema)}`,
    });
    const result = await activeClient.query({
      query: `SELECT toString(activity_id) AS activityId, toString(primary_activity_id) AS primaryId,
        provider_id AS providerId, canonical_type AS activityType, name,
        arraySort(member_activity_ids) AS members, is_deleted AS isDeleted
        FROM ${targetSchema}.deduped_activities FINAL`,
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([
      {
        activityId: groupId,
        primaryId: activityId,
        providerId: "peloton",
        activityType: "cardio",
        name: "Power Zone Ride",
        members: [activityId, linkedActivityId],
        isDeleted: 0,
      },
    ]);
  });

  it("does not credit an overlapping metadata-only member of the same provider", async () => {
    const activeClient = requireClient(client);
    await seedSpecificActivityTypeFixture(activeClient, targetSchema, "cycling", "cycling");
    await activeClient.command({
      query: `ALTER TABLE ${targetSchema}.activity_source_records
      UPDATE provider_id = 'whoop' WHERE activity_id = '${activityId}' SETTINGS mutations_sync = 2`,
    });
    // Both windows and providers match; only the lower-priority linked member owns this sample.
    const sql = renderDedupedActivitiesSelectSql(targetSchema);
    const credits = await activeClient.query({
      query: `WITH ranked AS (${extractCteSql(sql, "ranked")}),
      sensor_bearing_members AS (${extractCteSql(sql, "sensor_bearing_members")})
      SELECT ranked.activity_id AS memberId, toUInt32(coalesce(sensor_sample_count, 0)) AS sampleCount
      FROM ranked LEFT JOIN sensor_bearing_members
        ON ranked.activity_id = sensor_bearing_members.activity_id
        AND ranked.user_id = sensor_bearing_members.user_id
      ORDER BY memberId SETTINGS join_use_nulls = 1`,
      format: "JSONEachRow",
    });
    expect(await credits.json()).toEqual([
      { memberId: activityId, sampleCount: 0 },
      { memberId: linkedActivityId, sampleCount: 1 },
    ]);
    const result = await activeClient.query({
      query: renderDedupedActivitiesSelectSql(targetSchema),
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([
      expect.objectContaining({ activity_id: groupId, primary_activity_id: linkedActivityId }),
    ]);
  });

  it.each([
    {
      name: "sensor presence before specific type",
      pelotonType: "cardio",
      whoopType: "commuting",
      pelotonSamples: 1,
      whoopSamples: 0,
      whoopPriority: 1,
      winner: "peloton",
    },
    {
      name: "sample richness before provider priority",
      pelotonType: "cycling",
      whoopType: "cycling",
      pelotonSamples: 1,
      whoopSamples: 2,
      whoopPriority: 20,
      winner: "whoop",
    },
    {
      name: "specific canonical type after tied payload",
      pelotonType: "cardio",
      whoopType: "cycling",
      pelotonSamples: 0,
      whoopSamples: 0,
      whoopPriority: 20,
      winner: "whoop",
    },
    {
      name: "provider refinement after tied canonical type",
      pelotonType: "cycling",
      whoopType: " commuting ",
      pelotonSamples: 0,
      whoopSamples: 0,
      whoopPriority: 20,
      winner: "whoop",
    },
    {
      name: "normalized provider type before priority",
      pelotonType: "cycling",
      whoopType: " Cycling ",
      pelotonSamples: 0,
      whoopSamples: 0,
      whoopPriority: 20,
      winner: "peloton",
    },
    {
      name: "priority after tied type and payload",
      pelotonType: "cycling",
      whoopType: "cycling",
      pelotonSamples: 0,
      whoopSamples: 0,
      whoopPriority: 1,
      winner: "whoop",
    },
    {
      name: "UUID after tied priority",
      pelotonType: "cycling",
      whoopType: "cycling",
      pelotonSamples: 0,
      whoopSamples: 0,
      whoopPriority: 10,
      winner: "peloton",
    },
  ])("ranks $name", async (scenario) => {
    const activeClient = requireClient(client);
    await seedSpecificActivityTypeFixture(
      activeClient,
      targetSchema,
      scenario.whoopType,
      scenario.pelotonType,
    );
    await activeClient.command({ query: `TRUNCATE TABLE ${targetSchema}.deduped_sensor` });
    await activeClient.command({
      query: `ALTER TABLE ${targetSchema}.activity_source_records
      UPDATE priority = ${scenario.whoopPriority} WHERE activity_id = '${linkedActivityId}' SETTINGS mutations_sync = 2`,
    });
    for (const [provider, count] of [
      ["peloton", scenario.pelotonSamples],
      ["whoop", scenario.whoopSamples],
    ] as const) {
      if (count === 0) continue;
      await activeClient.command({
        query: `INSERT INTO ${targetSchema}.deduped_sensor
        (user_id, provider_id, recorded_at, channel)
        SELECT '${testUserId}', '${provider}', toDateTime64('2026-07-05 16:00:00', 6, 'UTC') + toIntervalMinute(number), '${provider === "peloton" ? "power" : "heart_rate"}'
        FROM numbers(${count})`,
      });
    }
    const result = await activeClient.query({
      query: renderDedupedActivitiesSelectSql(targetSchema),
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([
      expect.objectContaining({ activity_id: groupId, provider_id: scenario.winner }),
    ]);
  });

  it("prefers elevation payload after equal sample counts", async () => {
    const activeClient = requireClient(client);
    await seedSpecificActivityTypeFixture(activeClient, targetSchema, "cycling", "cycling");
    await activeClient.command({ query: `TRUNCATE TABLE ${targetSchema}.deduped_sensor` });
    await activeClient.command({
      query: `INSERT INTO ${targetSchema}.deduped_sensor
      (user_id, provider_id, recorded_at, channel) VALUES
      ('${testUserId}', 'peloton', '2026-07-05 16:00:00', 'power'),
      ('${testUserId}', 'whoop', '2026-07-05 17:00:00', 'altitude')`,
    });
    const result = await activeClient.query({
      query: renderDedupedActivitiesSelectSql(targetSchema),
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([
      expect.objectContaining({ activity_id: groupId, provider_id: "whoop" }),
    ]);
  });

  it("ignores deleted samples and samples outside adjacent same-provider activity windows", async () => {
    const activeClient = requireClient(client);
    await seedSpecificActivityTypeFixture(activeClient, targetSchema, "cycling", "cycling");
    await activeClient.command({ query: `TRUNCATE TABLE ${targetSchema}.deduped_sensor` });
    await activeClient.command({
      query: `INSERT INTO ${targetSchema}.deduped_sensor
      (user_id, provider_id, recorded_at, channel, is_deleted) VALUES
      ('${testUserId}', 'whoop', '2026-07-05 15:59:59', 'heart_rate', 0),
      ('${testUserId}', 'whoop', '2026-07-05 17:00:01', 'heart_rate', 0),
      ('${testUserId}', 'whoop', '2026-07-05 16:10:00', 'heart_rate', 1)`,
    });
    const result = await activeClient.query({
      query: renderDedupedActivitiesSelectSql(targetSchema),
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([
      expect.objectContaining({ activity_id: groupId, provider_id: "peloton" }),
    ]);
  });

  it("tombstones a removed member alias while keeping its stable group during a group-scoped refresh", async () => {
    const activeClient = requireClient(client);
    await seedSpecificActivityTypeFixture(activeClient, targetSchema);
    await activeClient.command({
      query: `INSERT INTO ${targetSchema}.deduped_activities ${renderDedupedActivitiesSelectSql(targetSchema)}`,
    });
    const renderMembers = (incremental: boolean) =>
      renderDbtModelSql(readModelSql("deduped_activity_members.sql"), {
        isIncremental: incremental,
        activityRefreshScoped: true,
      })
        .replaceAll("{{ ref('deduped_activities') }}", `${targetSchema}.deduped_activities`)
        .replaceAll("{{ this }}", `${targetSchema}.deduped_activity_members`)
        .replaceAll('{{ var("activity_refresh_user_id") }}', testUserId)
        .replaceAll("{{ activity_refresh_ids() }}", `CAST(['${groupId}'], 'Array(UUID)')`)
        .concat("\nSETTINGS max_threads = 1, join_use_nulls = 1");
    await activeClient.command({
      query: `CREATE TABLE ${targetSchema}.deduped_activity_members
      ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, member_activity_id) AS ${renderMembers(false)}`,
    });
    await activeClient.command({
      query: `ALTER TABLE ${targetSchema}.activity_source_records
      UPDATE is_deleted = 1 WHERE activity_id = '${linkedActivityId}' SETTINGS mutations_sync = 2`,
    });
    await activeClient.command({
      query: `INSERT INTO ${targetSchema}.deduped_activities ${renderDedupedActivitiesSelectSql(targetSchema, [groupId])}`,
    });
    await activeClient.command({
      query: `INSERT INTO ${targetSchema}.deduped_activity_members ${renderMembers(true)}`,
    });
    const result = await activeClient.query({
      query: `SELECT toString(activity_id) AS groupId,
      toString(member_activity_id) AS memberId, is_deleted AS isDeleted
      FROM ${targetSchema}.deduped_activity_members FINAL ORDER BY memberId`,
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([
      { groupId, memberId: activityId, isDeleted: 0 },
      { groupId, memberId: linkedActivityId, isDeleted: 1 },
    ]);
  });

  it("fails explicitly if active membership has not reached the source projection", async () => {
    const activeClient = requireClient(client);
    await seedMissingSourceNameFixture(activeClient, targetSchema);
    await activeClient.command({
      query: `ALTER TABLE ${targetSchema}.activity_source_records
      UPDATE group_id = NULL WHERE 1 SETTINGS mutations_sync = 2`,
    });
    await expect(
      activeClient.command({
        query: `INSERT INTO ${targetSchema}.deduped_activities ${renderDedupedActivitiesSelectSql(targetSchema)}`,
      }),
    ).rejects.toThrow("missing persisted group_id");
  });
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

function renderDedupedActivitiesSelectSql(targetSchema: string, scopedIds?: string[]): string {
  return renderDbtModelSql(readModelSql("deduped_activities.sql"), {
    isIncremental: true,
    activityRefreshScoped: scopedIds !== undefined,
  })
    .replaceAll('{{ var("activity_refresh_user_id") }}', testUserId)
    .replaceAll(
      "{{ activity_refresh_ids() }}",
      `CAST([${(scopedIds ?? []).map((id) => `'${id}'`).join(",")}], 'Array(UUID)')`,
    )
    .replace(/{{ ref\('activity_source_records'\) }}/g, `${targetSchema}.activity_source_records`)
    .replace(/{{ ref\('deduped_sensor'\) }}/g, `${targetSchema}.deduped_sensor`)
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

async function seedSpecificActivityTypeFixture(
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

async function seedSensorBearingRepresentativeFixture(
  client: ClickHouseClient,
  targetSchema: string,
): Promise<void> {
  await seedSpecificActivityTypeFixture(client, targetSchema, "cycling", "cycling");
}

async function seedNamedTimezoneContextFixture(
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
  user_id UUID,
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
