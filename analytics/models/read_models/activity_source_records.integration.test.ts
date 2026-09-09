import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readModelSql, renderDbtModelSql } from "../../../src/db/read-model-sql-test-helpers.ts";

const userId = "00000000-0000-4000-8000-000000000001";
const memberId = "00000000-0000-4000-8000-000000000101";
const groupId = "00000000-0000-4000-8000-000000000901";

describe("activity source membership projection", () => {
  const database = `activity_source_${randomUUID().replaceAll("-", "")}`;
  let client: ReturnType<typeof createClient>;

  function render(scopedId?: string, incremental = true) {
    return renderDbtModelSql(readModelSql("activity_source_records.sql"), {
      isIncremental: incremental,
      activityRefreshScoped: scopedId !== undefined,
    })
      .replaceAll("{{ source('postgres_fitness', 'activity') }}", `${database}.activity`)
      .replaceAll("{{ source('postgres_fitness', 'provider_priority') }}", `${database}.provider_priority`)
      .replaceAll("{{ source('postgres_fitness', 'device_priority') }}", `${database}.device_priority`)
      .replaceAll("{{ this }}", `${database}.activity_source_records`)
      .replaceAll('{{ var("activity_refresh_user_id") }}', userId)
      .replaceAll("{{ activity_refresh_ids() }}", `CAST(['${scopedId ?? memberId}'], 'Array(UUID)')`)
      .replaceAll("{{ activity_source_mass_tombstone_min_existing }}", "10")
      .replaceAll("{{ activity_source_mass_tombstone_ratio }}", "0.95")
      .replaceAll("{{ (activity_source_mass_tombstone_ratio * 100) | int }}", "95")
      .concat("\nSETTINGS join_use_nulls = 1, max_threads = 1");
  }

  beforeAll(async () => {
    const url = process.env.CLICKHOUSE_URL;
    if (!url) throw new Error("CLICKHOUSE_URL is required");
    client = createClient({ url });
    const statements = [
      `CREATE DATABASE ${database}`,
      `CREATE TABLE ${database}.activity (
        id UUID, group_id Nullable(UUID), user_id UUID, provider_id String,
        external_id Nullable(String), canonical_type String, provider_type Nullable(String),
        modality Nullable(String), started_at DateTime64(6, 'UTC'), ended_at Nullable(DateTime64(6, 'UTC')),
        source_name Nullable(String), name Nullable(String), notes Nullable(String), timezone Nullable(String),
        start_utc_offset_minutes Nullable(Int16), end_utc_offset_minutes Nullable(Int16),
        local_time_source String DEFAULT 'unknown', raw Nullable(String),
        provider_absent_at Nullable(DateTime64(6, 'UTC')), deleted_at Nullable(DateTime64(6, 'UTC')),
        _peerdb_is_deleted UInt8, _peerdb_synced_at DateTime64(9, 'UTC')
      ) ENGINE = ReplacingMergeTree ORDER BY id`,
      `CREATE TABLE ${database}.provider_priority (provider_id String, priority Int32, _peerdb_is_deleted UInt8)
        ENGINE = ReplacingMergeTree ORDER BY provider_id`,
      `CREATE TABLE ${database}.device_priority (provider_id String, source_name_pattern String, priority Int32, _peerdb_is_deleted UInt8)
        ENGINE = ReplacingMergeTree ORDER BY (provider_id, source_name_pattern)`,
    ];
    for (const query of statements) await client.command({ query });
    await client.command({ query: `CREATE TABLE ${database}.activity_source_records
      ENGINE = ReplacingMergeTree(refresh_version) ORDER BY activity_id AS ${render(undefined, false)}` });
  });

  beforeEach(async () => {
    await client.command({ query: `TRUNCATE TABLE ${database}.activity` });
    await client.command({ query: `TRUNCATE TABLE ${database}.activity_source_records` });
    await client.command({ query: `INSERT INTO ${database}.activity
      (id, group_id, user_id, provider_id, canonical_type, started_at) VALUES
      ('${memberId}', '${groupId}', '${userId}', 'whoop', 'cycling', '2026-09-01 12:00:00')` });
  });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close();
  });

  it("carries the persisted group through a refresh requested by group UUID", async () => {
    await client.command({ query: `INSERT INTO ${database}.activity_source_records ${render(groupId)}` });
    const result = await client.query({ query: `SELECT toString(activity_id) AS memberId, toString(group_id) AS groupId
      FROM ${database}.activity_source_records FINAL WHERE is_deleted = 0`, format: "JSONEachRow" });
    expect(await result.json()).toEqual([{ memberId, groupId }]);
  });

  it("tombstones the removed member when refreshing its group UUID", async () => {
    await client.command({ query: `INSERT INTO ${database}.activity_source_records ${render(memberId)}` });
    await client.command({ query: `TRUNCATE TABLE ${database}.activity` });
    await client.command({ query: `INSERT INTO ${database}.activity_source_records ${render(groupId)}` });
    const result = await client.query({ query: `SELECT is_deleted FROM ${database}.activity_source_records FINAL`, format: "JSONEachRow" });
    expect(await result.json()).toEqual([{ is_deleted: 1 }]);
  });

  it("refreshes a member that moved out of the requested prior group", async () => {
    await client.command({ query: `INSERT INTO ${database}.activity_source_records ${render(memberId)}` });
    const nextGroup = "00000000-0000-4000-8000-000000000902";
    await client.command({ query: `ALTER TABLE ${database}.activity UPDATE group_id = '${nextGroup}' WHERE 1 SETTINGS mutations_sync = 2` });
    await client.command({ query: `INSERT INTO ${database}.activity_source_records ${render(groupId)}` });
    const result = await client.query({ query: `SELECT toString(group_id) AS groupId, is_deleted
      FROM ${database}.activity_source_records FINAL`, format: "JSONEachRow" });
    expect(await result.json()).toEqual([{ groupId: nextGroup, is_deleted: 0 }]);
  });

  it.each(["NULL", "toUUID('00000000-0000-0000-0000-000000000000')"])("rejects missing persisted membership %s", async (missingId) => {
    await client.command({ query: `ALTER TABLE ${database}.activity UPDATE group_id = ${missingId} WHERE 1 SETTINGS mutations_sync = 2` });
    await expect(client.command({ query: `INSERT INTO ${database}.activity_source_records ${render(memberId)}` }))
      .rejects.toThrow("missing persisted group_id");
  });
});
