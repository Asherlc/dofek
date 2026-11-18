import { randomBytes } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { requireClickHouseUrl, waitForClickHouse } from "../db/deduped-activities-test-helpers.ts";
import { listChangedActivityTitles } from "./publisher.ts";

const database = `activity_search_${randomBytes(6).toString("hex")}`;
const table = `${database}.deduped_activities`;
const userId = "a0000000-0000-4000-8000-000000000001";
const activityId = "a0000000-0000-4000-8000-000000000002";
const mergedId = "a0000000-0000-4000-8000-000000000003";
const version = "1794952647000000001";
let client: ReturnType<typeof createClient>;

beforeAll(async () => {
  client = createClient({ url: requireClickHouseUrl() });
  await waitForClickHouse(client);
  await client.command({ query: `CREATE DATABASE ${database}` });
  await client.command({
    query: `CREATE TABLE ${table} (
    user_id UUID, activity_id UUID, name Nullable(String), canonical_type String,
    primary_canonical_type Nullable(String), provider_type Nullable(String),
    started_at DateTime64(6, 'UTC'), ended_at Nullable(DateTime64(6, 'UTC')),
    refresh_version UInt64, is_deleted UInt8
  ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id)`,
  });
});

afterAll(async () => {
  if (client) {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close();
  }
});

it("projects resolved titles and tombstones after a lossless ClickHouse checkpoint", async () => {
  const source = {
    user_id: userId,
    activity_id: activityId,
    name: "Old title",
    canonical_type: "indoor_cycling",
    primary_canonical_type: "cycling",
    provider_type: "cycling",
    started_at: "2021-05-14 15:00:00.000000",
    ended_at: "2021-05-14 16:00:00.000000",
    refresh_version: "1794952647000000000",
    is_deleted: 0,
  };
  await client.insert({
    table,
    format: "JSONEachRow",
    values: [
      source,
      { ...source, name: "Golden Hill Ride", refresh_version: version },
      { ...source, activity_id: mergedId, refresh_version: version, is_deleted: 1 },
    ],
  });
  const owner: Pick<ClickHouseClient, "query"> = {
    query: (options) =>
      client.query({
        ...options,
        query: options.query.replace("analytics.deduped_activities", table),
      }),
  };

  const rows = await listChangedActivityTitles(owner);
  expect(rows).toEqual([
    {
      version,
      userId,
      activityId,
      title: "Golden Hill Ride",
      activityType: "cycling",
      startedAt: "2021-05-14T15:00:00.000000Z",
      searchable: true,
    },
    {
      version,
      userId,
      activityId: mergedId,
      title: "Old title",
      activityType: "cycling",
      startedAt: "2021-05-14T15:00:00.000000Z",
      searchable: false,
    },
  ]);
  await expect(listChangedActivityTitles(owner, { version, userId, activityId })).resolves.toEqual([
    rows[1],
  ]);
});
