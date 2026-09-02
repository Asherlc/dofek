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
const broadWhoopOtherId = "00000000-0000-4000-8000-000000000105";

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

    await expect(result.json()).resolves.toEqual([
      { activityId: whoopOtherId, duplicateActivityId: containedCyclingId },
    ]);
  }, 180_000);
});

function requireClient(client: ClickHouseClient | undefined): ClickHouseClient {
  if (!client) throw new Error("ClickHouse client was not initialized");
  return client;
}

function renderModel(database: string): string {
  return readFileSync(new URL("./activity_duplicate_matches.sql", import.meta.url), "utf8")
    .replace(/{{ config\([\s\S]*?\) }}\s*/, "")
    .replace(
      /{% if is_incremental\(\) %}[\s\S]*?{% else %}([\s\S]*?){% endif %}/g,
      "$1",
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
      ('${whoopOtherId}', 'whoop', '${userId}', 'other',
       toDateTime64('2026-04-01 15:22:30', 6, 'UTC'),
       toDateTime64('2026-04-01 15:35:59', 6, 'UTC'), 0),
      ('${containedCyclingId}', 'wahoo', '${userId}', 'cycling',
       toDateTime64('2026-04-01 15:21:24', 6, 'UTC'),
       toDateTime64('2026-04-01 16:13:42', 6, 'UTC'), 0),
      ('${typedStrengthId}', 'apple_health', '${userId}', 'strength',
       toDateTime64('2026-05-01 18:02:00', 6, 'UTC'),
       toDateTime64('2026-05-01 18:10:00', 6, 'UTC'), 0),
      ('${containingCyclingId}', 'wahoo', '${userId}', 'cycling',
       toDateTime64('2026-05-01 18:00:00', 6, 'UTC'),
       toDateTime64('2026-05-01 19:00:00', 6, 'UTC'), 0),
      ('${broadWhoopOtherId}', 'whoop', '${userId}', 'other',
       toDateTime64('2026-05-01 17:59:00', 6, 'UTC'),
       toDateTime64('2026-05-01 19:01:00', 6, 'UTC'), 0)`,
  ];
  for (const statement of statements) await client.command({ query: statement });
}
