import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type ClickHouseClient = ReturnType<typeof createClient>;

const userId = "00000000-0000-4000-8000-000000000001";
const whoopOtherId = "00000000-0000-4000-8000-000000000101";
const containedCyclingId = "00000000-0000-4000-8000-000000000102";
const typedStrengthId = "00000000-0000-4000-8000-000000000103";
const containingCyclingId = "00000000-0000-4000-8000-000000000104";
const broadOtherId = "00000000-0000-4000-8000-000000000105";
const bridgeCyclingId = "00000000-0000-4000-8000-000000000106";
const bridgeStrengthId = "00000000-0000-4000-8000-000000000107";
const tombstonedWhoopId = "00000000-0000-4000-8000-000000000108";
const pelotonMemberId = "00000000-0000-4000-8000-000000000109";
const wahooOtherId = "2a7c6fa3-32f1-4ae5-9c99-b981c31e289b";

describe("activity_duplicate_matches read model", () => {
  let client: ClickHouseClient | undefined;
  const database = `analytics_activity_matches_test_${randomBytes(6).toString("hex")}`;

  beforeAll(async () => {
    const url = process.env.CLICKHOUSE_URL?.trim();
    if (!url) throw new Error("CLICKHOUSE_URL is required for activity match integration tests");
    client = createClient({ url, request_timeout: 120_000 });
    await client.query({ query: "SELECT 1", format: "JSONEachRow" });
  }, 120_000);

  afterAll(async () => {
    if (!client) return;
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close();
  });

  it("matches an untyped contained activity without merging differently typed activities", async () => {
    const activeClient = requireClient(client);
    await seedFixture(activeClient, database);

    await activeClient.command({
      query: `INSERT INTO ${database}.activity_duplicate_matches
${renderModel(database)}`,
    });

    const result = await activeClient.query({
      query: `SELECT
          toString(activity_id) AS activityId,
          toString(duplicate_activity_id) AS duplicateActivityId
        FROM ${database}.activity_duplicate_matches FINAL
        WHERE is_deleted = 0
        ORDER BY activityId, duplicateActivityId`,
      format: "JSONEachRow",
    });

    const matches = await result.json();

    expect(matches).toEqual([
      { activityId: whoopOtherId, duplicateActivityId: containedCyclingId },
      { activityId: containedCyclingId, duplicateActivityId: tombstonedWhoopId },
    ]);
    expect(groupsFor(wahooOtherId, matches)).not.toContain(pelotonMemberId);
  }, 180_000);

  it("emits a tombstone when an incremental refresh removes a stale match", async () => {
    const activeClient = requireClient(client);
    await seedFixture(activeClient, database);
    await activeClient.command({
      query: `INSERT INTO ${database}.activity_duplicate_matches
${renderModel(database)}`,
    });
    await activeClient.command({ query: `TRUNCATE TABLE ${database}.activity_source_records` });
    await activeClient.command({ query: `TRUNCATE TABLE ${database}.source_activity` });
    await activeClient.command({
      query: `INSERT INTO ${database}.activity_duplicate_matches
${renderModel(database, true)}`,
    });

    const result = await activeClient.query({
      query: `SELECT is_deleted AS isDeleted
        FROM ${database}.activity_duplicate_matches FINAL
        WHERE activity_id = toUUID('${whoopOtherId}')
          AND duplicate_activity_id = toUUID('${containedCyclingId}')`,
      format: "JSONEachRow",
    });

    await expect(result.json()).resolves.toEqual([{ isDeleted: 1 }]);
  }, 180_000);
});

function requireClient(client: ClickHouseClient | undefined): ClickHouseClient {
  if (!client) throw new Error("ClickHouse client was not initialized");
  return client;
}

function groupsFor(
  activityId: string,
  matches: Array<{ activityId: string; duplicateActivityId: string }>,
): string[] {
  const members = new Set([activityId]);
  let discoveredNewMember = true;
  while (discoveredNewMember) {
    discoveredNewMember = false;
    for (const match of matches) {
      if (members.has(match.activityId) && !members.has(match.duplicateActivityId)) {
        members.add(match.duplicateActivityId);
        discoveredNewMember = true;
      }
      if (members.has(match.duplicateActivityId) && !members.has(match.activityId)) {
        members.add(match.activityId);
        discoveredNewMember = true;
      }
    }
  }
  return [...members];
}

function renderModel(database: string, incremental = false): string {
  return readFileSync(new URL("./activity_duplicate_matches.sql", import.meta.url), "utf8")
    .replace(/{{ config\([\s\S]*?\) }}\s*/, "")
    .replace(
      /{% if is_incremental\(\) %}([\s\S]*?){% else %}([\s\S]*?){% endif %}/g,
      incremental ? "$1" : "$2",
    )
    .replace(/{{ ref\('activity_source_records'\) }}/g, `${database}.activity_source_records`)
    .replace(
      /{{ source\('postgres_fitness', 'activity'\) }}/g,
      `${database}.source_activity`,
    )
    .replace(/{{ this }}/g, `${database}.activity_duplicate_matches`)
    .concat("\nSETTINGS max_threads = 1");
}

async function seedFixture(client: ClickHouseClient, database: string): Promise<void> {
  const statements = [
    `DROP DATABASE IF EXISTS ${database} SYNC`,
    `CREATE DATABASE ${database}`,
    `CREATE TABLE ${database}.activity_source_records (
      activity_id UUID,
      provider_id String,
      user_id UUID,
      canonical_type String,
      started_at DateTime64(6, 'UTC'),
      ended_at Nullable(DateTime64(6, 'UTC')),
      is_deleted UInt8
    ) ENGINE = ReplacingMergeTree() ORDER BY activity_id`,
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
    `CREATE TABLE ${database}.activity_duplicate_matches (
      activity_id UUID,
      duplicate_activity_id UUID,
      overlap_ratio Nullable(Float64),
      refresh_version UInt64,
      is_deleted UInt8,
      refreshed_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (activity_id, duplicate_activity_id)`,
    `INSERT INTO ${database}.activity_source_records VALUES
      ('${whoopOtherId}', 'wahoo', '${userId}', 'other',
       toDateTime64('2026-04-01 15:22:00', 6, 'UTC'),
       toDateTime64('2026-04-01 16:05:00', 6, 'UTC'), 0),
      ('${containedCyclingId}', 'wahoo', '${userId}', 'cycling',
       toDateTime64('2026-04-01 15:21:24', 6, 'UTC'),
       toDateTime64('2026-04-01 16:13:42', 6, 'UTC'), 0),
      ('${typedStrengthId}', 'apple_health', '${userId}', 'strength',
       toDateTime64('2026-05-01 18:02:00', 6, 'UTC'),
       toDateTime64('2026-05-01 18:10:00', 6, 'UTC'), 0),
      ('${containingCyclingId}', 'wahoo', '${userId}', 'cycling',
       toDateTime64('2026-05-01 18:00:00', 6, 'UTC'),
       toDateTime64('2026-05-01 19:00:00', 6, 'UTC'), 0),
      ('${broadOtherId}', 'whoop', '${userId}', 'other',
       toDateTime64('2026-06-01 18:00:00', 6, 'UTC'),
       toDateTime64('2026-06-01 19:00:00', 6, 'UTC'), 0),
      ('${bridgeCyclingId}', 'wahoo', '${userId}', 'cycling',
       toDateTime64('2026-06-01 18:00:00', 6, 'UTC'),
       toDateTime64('2026-06-01 18:20:00', 6, 'UTC'), 0),
      ('${bridgeStrengthId}', 'apple_health', '${userId}', 'strength',
       toDateTime64('2026-06-01 18:40:00', 6, 'UTC'),
       toDateTime64('2026-06-01 19:00:00', 6, 'UTC'), 0),
      ('${pelotonMemberId}', 'peloton', '${userId}', 'cycling',
       toDateTime64('2026-07-01 18:00:00', 6, 'UTC'),
       toDateTime64('2026-07-01 19:00:00', 6, 'UTC'), 0),
      ('${wahooOtherId}', 'wahoo', '${userId}', 'other',
       toDateTime64('2026-07-01 18:10:00', 6, 'UTC'),
       toDateTime64('2026-07-01 18:50:00', 6, 'UTC'), 0)`,
    `INSERT INTO ${database}.source_activity VALUES
      ('${tombstonedWhoopId}', '${userId}', 'wahoo', 'other',
       toDateTime64('2026-04-01 15:30:00', 6, 'UTC'),
       toDateTime64('2026-04-01 16:13:00', 6, 'UTC'), 0,
       toDateTime64('2026-09-01 00:00:00', 6, 'UTC'), NULL)`,
  ];
  for (const statement of statements) await client.command({ query: statement });
}
