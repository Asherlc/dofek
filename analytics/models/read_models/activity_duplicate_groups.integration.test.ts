import { randomBytes } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { readModelSql, renderDbtModelSql } from "../../../src/db/read-model-sql-test-helpers.ts";

type ClickHouseClient = ReturnType<typeof createClient>;

const activityA = "00000000-0000-4000-8000-000000000201";
const activityB = "00000000-0000-4000-8000-000000000202";
const activityC = "00000000-0000-4000-8000-000000000203";
const activityD = "00000000-0000-4000-8000-000000000204";
const userA = "00000000-0000-4000-8000-000000000001";
const userB = "00000000-0000-4000-8000-000000000002";
const tombstonedActivity = "00000000-0000-4000-8000-000000000205";
const otherUserActivity = "00000000-0000-4000-8000-000000000206";
const groupRowsSchema = z.array(
  z.object({ activityId: z.string().uuid(), groupId: z.string().uuid() }),
);
const groupCountRowsSchema = z.array(z.object({ groupCount: z.coerce.number().int() }));
const groupLifecycleRowsSchema = z.array(
  z.object({ activityId: z.string().uuid(), isDeleted: z.coerce.number().int() }),
);

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

    expect(groupRowsSchema.parse(await result.json<unknown>())).toEqual([
      { activityId: activityA, groupId: activityA },
      { activityId: activityB, groupId: activityA },
      { activityId: activityC, groupId: activityA },
      { activityId: activityD, groupId: activityA },
    ]);
  }, 180_000);

  it("ignores duplicate edges whose endpoint is inactive or belongs to another user", async () => {
    const activeClient = requireClient(client);
    await seedFixture(activeClient, database);
    await activeClient.command({
      query: `INSERT INTO ${database}.activity_source_records VALUES
        ('${otherUserActivity}', '${userB}', 0)`,
    });
    await activeClient.command({
      query: `INSERT INTO ${database}.activity_duplicate_matches VALUES
        ('${activityA}', '${tombstonedActivity}', 0),
        ('${activityA}', '${otherUserActivity}', 0)`,
    });

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

    expect(groupRowsSchema.parse(await result.json<unknown>())).toEqual([
      { activityId: activityA, groupId: activityA },
      { activityId: activityB, groupId: activityA },
      { activityId: activityC, groupId: activityA },
      { activityId: activityD, groupId: activityA },
      { activityId: otherUserActivity, groupId: otherUserActivity },
    ]);
  }, 180_000);

  it("converges a sparse component beyond the former 16-round propagation cap", async () => {
    const activeClient = requireClient(client);
    const activityIds = Array.from(
      { length: 18 },
      (_, index) => `00000000-0000-4000-8000-${String(301 + index).padStart(12, "0")}`,
    );
    await seedChainFixture(activeClient, database, activityIds);

    await activeClient.command({
      query: `INSERT INTO ${database}.activity_duplicate_groups
${renderModel(database)}`,
    });

    const result = await activeClient.query({
      query: `SELECT uniqExact(group_id) AS groupCount
        FROM ${database}.activity_duplicate_groups FINAL
        WHERE is_deleted = 0`,
      format: "JSONEachRow",
    });
    expect(groupCountRowsSchema.parse(await result.json<unknown>())).toEqual([{ groupCount: 1 }]);
  }, 180_000);

  it("tombstones a removed component member during a scoped incremental refresh", async () => {
    const activeClient = requireClient(client);
    await seedFixture(activeClient, database);
    await activeClient.command({
      query: `INSERT INTO ${database}.activity_duplicate_groups
${renderModel(database)}`,
    });
    await activeClient.command({ query: `TRUNCATE TABLE ${database}.activity_source_records` });
    await activeClient.command({ query: `TRUNCATE TABLE ${database}.activity_duplicate_matches` });
    await activeClient.command({
      query: `INSERT INTO ${database}.activity_source_records VALUES
        ('${activityA}', '${userA}', 0),
        ('${activityB}', '${userA}', 0),
        ('${activityC}', '${userA}', 0)`,
    });
    await activeClient.command({
      query: `INSERT INTO ${database}.activity_duplicate_matches VALUES
        ('${activityA}', '${activityB}', 0),
        ('${activityB}', '${activityC}', 0)`,
    });

    const scopedRefreshSql = renderModel(database, true, [activityD]);
    await activeClient.command({
      query: `INSERT INTO ${database}.activity_duplicate_groups
${scopedRefreshSql}`,
    });

    const rawResult = await activeClient.query({
      query: `SELECT toString(activity_id) AS activityId, is_deleted AS isDeleted
        FROM ${database}.activity_duplicate_groups
        WHERE activity_id = toUUID('${activityD}')
        ORDER BY refresh_version`,
      format: "JSONEachRow",
    });
    expect(groupLifecycleRowsSchema.parse(await rawResult.json<unknown>())).toEqual([
      { activityId: activityD, isDeleted: 0 },
      { activityId: activityD, isDeleted: 1 },
    ]);

    const result = await activeClient.query({
      query: `SELECT toString(activity_id) AS activityId, is_deleted AS isDeleted
        FROM ${database}.activity_duplicate_groups FINAL
        WHERE activity_id = toUUID('${activityD}')`,
      format: "JSONEachRow",
    });
    expect(groupLifecycleRowsSchema.parse(await result.json<unknown>())).toEqual([
      { activityId: activityD, isDeleted: 1 },
    ]);
  }, 180_000);
});

function requireClient(client: ClickHouseClient | undefined): ClickHouseClient {
  if (!client) throw new Error("ClickHouse client was not initialized");
  return client;
}

function renderModel(
  database: string,
  incremental = false,
  scopedActivityIds?: readonly string[],
): string {
  return renderDbtModelSql(readModelSql("activity_duplicate_groups.sql"), {
    isIncremental: incremental,
    activityRefreshScoped: scopedActivityIds != null,
  })
    .replaceAll(
      "{{ activity_refresh_ids() }}",
      `CAST([${(scopedActivityIds ?? []).map((id) => `'${id}'`).join(", ")}], 'Array(UUID)')`,
    )
    .replaceAll('{{ var("activity_refresh_user_id") }}', userA)
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
      user_id UUID,
      is_deleted UInt8
    ) ENGINE = ReplacingMergeTree() ORDER BY activity_id`,
    `CREATE TABLE ${database}.activity_duplicate_matches (
      activity_id UUID,
      duplicate_activity_id UUID,
      is_deleted UInt8
    ) ENGINE = ReplacingMergeTree() ORDER BY (activity_id, duplicate_activity_id)`,
    `CREATE TABLE ${database}.activity_duplicate_groups (
      activity_id UUID,
      group_id Nullable(String),
      refresh_version UInt64,
      is_deleted UInt8,
      refreshed_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY activity_id`,
    `INSERT INTO ${database}.activity_source_records VALUES
      ('${activityA}', '${userA}', 0),
      ('${activityB}', '${userA}', 0),
      ('${activityC}', '${userA}', 0),
      ('${activityD}', '${userA}', 0)`,
    `INSERT INTO ${database}.activity_duplicate_matches VALUES
      ('${activityA}', '${activityB}', 0),
      ('${activityB}', '${activityC}', 0),
      ('${activityC}', '${activityD}', 0)`,
  ];
  for (const statement of statements) await client.command({ query: statement });
}

async function seedChainFixture(
  client: ClickHouseClient,
  database: string,
  activityIds: string[],
): Promise<void> {
  await client.command({ query: `TRUNCATE TABLE ${database}.activity_source_records` });
  await client.command({ query: `TRUNCATE TABLE ${database}.activity_duplicate_matches` });
  await client.command({ query: `TRUNCATE TABLE ${database}.activity_duplicate_groups` });
  await client.command({
    query: `INSERT INTO ${database}.activity_source_records VALUES
      ${activityIds.map((activityId) => `('${activityId}', '${userA}', 0)`).join(",\n      ")}`,
  });
  await client.command({
    query: `INSERT INTO ${database}.activity_duplicate_matches VALUES
      ${activityIds
        .slice(0, -1)
        .map((activityId, index) => `('${activityId}', '${activityIds[index + 1]}', 0)`)
        .join(",\n      ")}`,
  });
}
