import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type ClickHouseClient = ReturnType<typeof createClient>;

const activityA = "00000000-0000-4000-8000-000000000201";
const activityB = "00000000-0000-4000-8000-000000000202";
const activityC = "00000000-0000-4000-8000-000000000203";
const activityD = "00000000-0000-4000-8000-000000000204";

describe("activity_duplicate_groups read model", () => {
  let client: ClickHouseClient | undefined;
  const database = `analytics_activity_groups_test_${randomBytes(6).toString("hex")}`;

  beforeAll(async () => {
    const url = process.env.CLICKHOUSE_URL?.trim();
    if (!url) throw new Error("CLICKHOUSE_URL is required for activity group integration tests");
    client = createClient({ url, request_timeout: 120_000 });
    await client.query({ query: "SELECT 1", format: "JSONEachRow" });
  }, 120_000);

  afterAll(async () => {
    if (!client) return;
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close();
  });

  it("assigns one group to every activity in a four-node duplicate chain", async () => {
    const activeClient = requireClient(client);
    await seedFixture(activeClient, database);

    await activeClient.command({
      query: `INSERT INTO ${database}.activity_duplicate_groups
${renderModel(database)}`,
    });

    const result = await activeClient.query({
      query: `SELECT
          toString(activity_id) AS activityId,
          group_id AS groupId
        FROM ${database}.activity_duplicate_groups FINAL
        WHERE is_deleted = 0
        ORDER BY activityId`,
      format: "JSONEachRow",
    });

    await expect(result.json()).resolves.toEqual([
      { activityId: activityA, groupId: activityA },
      { activityId: activityB, groupId: activityA },
      { activityId: activityC, groupId: activityA },
      { activityId: activityD, groupId: activityA },
    ]);
  }, 180_000);
});

function requireClient(client: ClickHouseClient | undefined): ClickHouseClient {
  if (!client) throw new Error("ClickHouse client was not initialized");
  return client;
}

function renderModel(database: string, incremental = false): string {
  return readFileSync(new URL("./activity_duplicate_groups.sql", import.meta.url), "utf8")
    .replace(/{{ config\([\s\S]*?\) }}\s*/, "")
    .replace(
      /{% if is_incremental\(\) %}([\s\S]*?){% else %}([\s\S]*?){% endif %}/g,
      incremental ? "$1" : "$2",
    )
    .replace(/{{ ref\('activity_source_records'\) }}/g, `${database}.activity_source_records`)
    .replace(/{{ ref\('activity_duplicate_matches'\) }}/g, `${database}.activity_duplicate_matches`)
    .replace(/{{ this }}/g, `${database}.activity_duplicate_groups`)
    .concat("\nSETTINGS max_threads = 1");
}

async function seedFixture(client: ClickHouseClient, database: string): Promise<void> {
  const statements = [
    `DROP DATABASE IF EXISTS ${database} SYNC`,
    `CREATE DATABASE ${database}`,
    `CREATE TABLE ${database}.activity_source_records (
      activity_id UUID,
      is_deleted UInt8
    ) ENGINE = ReplacingMergeTree() ORDER BY activity_id`,
    `CREATE TABLE ${database}.activity_duplicate_matches (
      activity_id UUID,
      duplicate_activity_id UUID,
      is_deleted UInt8
    ) ENGINE = ReplacingMergeTree() ORDER BY (activity_id, duplicate_activity_id)`,
    `CREATE TABLE ${database}.activity_duplicate_groups (
      activity_id UUID,
      group_id String,
      refresh_version UInt64,
      is_deleted UInt8,
      refreshed_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY activity_id`,
    `INSERT INTO ${database}.activity_source_records VALUES
      ('${activityA}', 0),
      ('${activityB}', 0),
      ('${activityC}', 0),
      ('${activityD}', 0)`,
    `INSERT INTO ${database}.activity_duplicate_matches VALUES
      ('${activityA}', '${activityB}', 0),
      ('${activityB}', '${activityC}', 0),
      ('${activityC}', '${activityD}', 0)`,
  ];
  for (const statement of statements) await client.command({ query: statement });
}
