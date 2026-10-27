import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

const primaryActivityId = "00000000-0000-0000-0000-000000000111";
const secondaryActivityId = "00000000-0000-0000-0000-000000000222";
const testUserId = "00000000-0000-0000-0000-000000000001";

const activityTitleSchema = z.object({
  activity_id: z.string(),
  provider_id: z.string(),
  activity_type: z.string(),
  source_name: z.string(),
  name: z.string().nullable(),
});

describe("deduped activity primary titles", () => {
  const targetSchema = `analytics_activity_title_test_${randomBytes(6).toString("hex")}`;
  const client = createClient({ url: process.env.CLICKHOUSE_URL });

  beforeAll(async () => {
    await client.command({ query: `CREATE DATABASE ${targetSchema}` });
    await client.command({
      query: `CREATE TABLE ${targetSchema}.activity_source_records (
        activity_id UUID,
        provider_id Nullable(String),
        user_id Nullable(UUID),
        external_id Nullable(String),
        activity_type Nullable(String),
        started_at Nullable(DateTime64(6, 'UTC')),
        ended_at Nullable(DateTime64(6, 'UTC')),
        source_name Nullable(String),
        name Nullable(String),
        notes Nullable(String),
        timezone Nullable(String),
        raw Nullable(String),
        source_synced_at Nullable(DateTime64(9, 'UTC')),
        priority Nullable(Int32),
        refresh_version UInt64,
        is_deleted UInt8
      ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY activity_id`,
    });
    await client.command({
      query: `CREATE TABLE ${targetSchema}.activity_duplicate_groups (
        activity_id UUID,
        group_id Nullable(String),
        refresh_version UInt64,
        is_deleted UInt8
      ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY activity_id`,
    });
    await client.command({
      query: `CREATE TABLE ${targetSchema}.source_activity (
        id UUID,
        provider_id Nullable(String),
        external_id Nullable(String),
        deleted_at Nullable(DateTime64(6, 'UTC')),
        provider_absent_at Nullable(DateTime64(6, 'UTC')),
        _peerdb_is_deleted UInt8,
        _peerdb_synced_at DateTime64(9, 'UTC')
      ) ENGINE = ReplacingMergeTree(_peerdb_synced_at) ORDER BY id`,
    });
    await client.insert({
      table: `${targetSchema}.activity_duplicate_groups`,
      format: "JSONEachRow",
      values: [primaryActivityId, secondaryActivityId].map((activityId) => ({
        activity_id: activityId,
        group_id: primaryActivityId,
        refresh_version: 1,
        is_deleted: 0,
      })),
    });
  });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${targetSchema} SYNC` });
    await client.close();
  });

  it.each([
    { primaryTitle: null, secondaryPriority: 20 },
    { primaryTitle: "Afternoon run", secondaryPriority: 20 },
    { primaryTitle: null, secondaryPriority: 10 },
  ])("uses primary title $primaryTitle with secondary priority $secondaryPriority", async ({
    primaryTitle,
    secondaryPriority,
  }) => {
    await client.command({ query: `TRUNCATE TABLE ${targetSchema}.activity_source_records` });
    const sharedActivity = {
      user_id: testUserId,
      started_at: "2026-10-26 22:11:00.000000",
      ended_at: "2026-10-26 22:52:00.000000",
      source_synced_at: "2026-10-26 23:00:00.000000000",
      refresh_version: 1,
      is_deleted: 0,
    };
    await client.insert({
      table: `${targetSchema}.activity_source_records`,
      format: "JSONEachRow",
      values: [
        {
          ...sharedActivity,
          activity_id: secondaryActivityId,
          provider_id: "secondary",
          activity_type: "walking",
          name: "40 min 58 sec Walking",
          priority: secondaryPriority,
        },
        {
          ...sharedActivity,
          activity_id: primaryActivityId,
          provider_id: "apple_health",
          activity_type: "running",
          source_name: "Asher’s Apple Watch",
          name: primaryTitle,
          priority: 10,
        },
      ],
    });

    const result = await client.query({
      query: renderDedupedActivitiesSql(targetSchema),
      format: "JSONEachRow",
    });
    const rows = z.array(activityTitleSchema).parse(await result.json());

    expect(rows).toEqual([
      {
        activity_id: primaryActivityId,
        provider_id: "apple_health",
        activity_type: "running",
        source_name: "Asher’s Apple Watch",
        name: primaryTitle,
      },
    ]);
  });
});

function renderDedupedActivitiesSql(targetSchema: string): string {
  return readFileSync(
    new URL("../../analytics/models/read_models/deduped_activities.sql", import.meta.url),
    "utf8",
  )
    .replace(/{{ config\([\s\S]*?\) }}\s*/, "")
    .replace(/{% if is_incremental\(\) %}[\s\S]*?{% endif %}/g, "")
    .replace(/{{ ref\('activity_source_records'\) }}/g, `${targetSchema}.activity_source_records`)
    .replace(
      /{{ ref\('activity_duplicate_groups'\) }}/g,
      `${targetSchema}.activity_duplicate_groups`,
    )
    .replace(/{{ source\('postgres_fitness', 'activity'\) }}/g, `${targetSchema}.source_activity`)
    .concat("\nSETTINGS join_use_nulls = 1, max_threads = 1");
}
