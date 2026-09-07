import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../clickhouse.ts";
import { buildPostgresFitnessActivityRawTableStatement } from "../clickhouse-raw-tables.ts";
import { createMigration } from "./0078_stable_activity_read_views.ts";

const userId = "00000000-0000-0000-0000-000000000001";
const groupId = "00000000-0000-0000-0000-000000000100";
const pelotonId = "00000000-0000-0000-0000-000000000101";
const whoopId = "00000000-0000-0000-0000-000000000102";
const absentId = "00000000-0000-0000-0000-000000000103";

describe("0078 stable activity read views", () => {
  const database = `stable_activity_views_${randomUUID().replaceAll("-", "")}`;
  let client: ClickHouseClient;

  const runIsolated = async (statement: string): Promise<void> => {
    await client.command({
      query: statement
        .replaceAll("analytics.", `${database}.`)
        .replaceAll("postgres_fitness.", `${database}.`),
    });
  };

  beforeAll(async () => {
    client = createClickHouseClientFromEnv();
    await client.command({ query: `CREATE DATABASE ${database}` });
    await runIsolated(buildPostgresFitnessActivityRawTableStatement());
    await runIsolated(`CREATE TABLE postgres_fitness.provider_priority (
      provider_id String, priority Int32, _peerdb_is_deleted Int8,
      _peerdb_version Int64) ENGINE = ReplacingMergeTree(_peerdb_version)
      ORDER BY provider_id`);
    await runIsolated(`CREATE TABLE postgres_fitness.device_priority (
      provider_id String, source_name_pattern String, priority Nullable(Int32),
      _peerdb_is_deleted Int8, _peerdb_version Int64)
      ENGINE = ReplacingMergeTree(_peerdb_version)
      ORDER BY (provider_id, source_name_pattern)`);
    await runIsolated(`INSERT INTO postgres_fitness.activity
      (id, group_id, provider_id, user_id, external_id, canonical_type, provider_type,
       started_at, ended_at, name, source_name, created_at, _peerdb_is_deleted, _peerdb_version)
      VALUES
      ('${pelotonId}', '${groupId}', 'peloton', '${userId}', 'peloton-1', 'cardio', '',
       now64(6), now64(6) + INTERVAL 1 HOUR, 'Peloton Ride', 'Peloton', now64(6), 0, 1),
      ('${whoopId}', '${groupId}', 'whoop', '${userId}', 'whoop-1', 'cycling', 'commuting',
       now64(6), now64(6) + INTERVAL 1 HOUR, 'Bike Commute', 'WHOOP', now64(6), 0, 1)`);
    await runIsolated(`INSERT INTO postgres_fitness.provider_priority VALUES
      ('peloton', 1, 0, 1), ('whoop', 100, 0, 1)`);
    for (const statement of createMigration().statements) await runIsolated(statement);
  });

  afterAll(async () => {
    await client?.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
  });

  it("publishes persisted group identity and specificity-first representative metadata", async () => {
    const result = await client.query({
      query: `SELECT toString(id) AS id, toString(primary_activity_id) AS primary_activity_id,
        canonical_type, provider_type, arraySort(member_activity_ids) AS member_activity_ids
        FROM ${database}.v_activity`,
      format: "JSONEachRow",
    });

    expect(
      z
        .array(
          z.object({
            id: z.string(),
            primary_activity_id: z.string(),
            canonical_type: z.string(),
            provider_type: z.string(),
            member_activity_ids: z.array(z.string()),
          }),
        )
        .parse(await result.json()),
    ).toEqual([
      {
        id: groupId,
        primary_activity_id: whoopId,
        canonical_type: "cycling",
        provider_type: "commuting",
        member_activity_ids: [pelotonId, whoopId],
      },
    ]);
  });

  it("excludes a group when one of its persisted members is provider-absent", async () => {
    await runIsolated(`INSERT INTO postgres_fitness.activity
      (id, group_id, provider_id, user_id, external_id, canonical_type, provider_type,
       started_at, ended_at, name, source_name, provider_absent_at, created_at,
       _peerdb_is_deleted, _peerdb_version)
      VALUES
      ('${absentId}', '${groupId}', 'route-provider', '${userId}', 'route-absent-1',
       'cycling', '', now64(6), now64(6) + INTERVAL 1 HOUR, 'Recorded Route',
       'Route Provider', now64(6), now64(6), 0, 1)`);

    const result = await client.query({
      query: `SELECT toString(activity.id) AS id FROM ${database}.v_activity AS activity
        WHERE activity.id = toUUID('${groupId}')`,
      format: "JSONEachRow",
    });

    expect(await result.json()).toEqual([]);
  });

  it("fails loudly when an active mirrored member lacks persisted identity", async () => {
    await runIsolated(`INSERT INTO postgres_fitness.activity
      (id, group_id, provider_id, user_id, canonical_type, provider_type,
       started_at, created_at, _peerdb_is_deleted, _peerdb_version)
      VALUES (generateUUIDv4(), NULL, 'whoop', '${userId}', 'cycling', 'commuting',
        now64(6), now64(6), 0, 1)`);

    await expect(
      client.query({ query: `SELECT id FROM ${database}.v_activity`, format: "JSONEachRow" }),
    ).rejects.toThrow("Active activity is missing persisted group identity");
  });
});
