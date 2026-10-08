import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CLICKHOUSE_DEFAULT_SETTINGS } from "./clickhouse.ts";
import { createMigration } from "./clickhouse-migrations/0102_activity_field_source_priorities.ts";
import { buildPostgresFitnessActivityRawTableStatement } from "./clickhouse-raw-tables.ts";

const userId = "00000000-0000-0000-0000-000000000001";
const groupId = "20000000-0000-4000-8000-000000000100";
const whoopId = "20000000-0000-4000-8000-000000000101";
const appleId = "20000000-0000-4000-8000-000000000102";
const pelotonId = "20000000-0000-4000-8000-000000000103";
const kayaId = "20000000-0000-4000-8000-000000000104";
const kayaName = "Kaya climbing at Touchstone Great Western Power Company";

describe("live activity field priorities", () => {
  const database = `activity_field_priority_${randomUUID().replaceAll("-", "")}`;
  let client: ReturnType<typeof createClient>;

  const runIsolated = async (statement: string): Promise<void> => {
    await client.command({
      query: statement
        .replaceAll("analytics.", `${database}.`)
        .replaceAll("postgres_fitness.", `${database}.`),
    });
  };

  const insertActivities = async (
    activities: Array<{
      id: string;
      groupId: string;
      providerId: string;
      canonicalType: string;
      name: string | null;
      notes?: string | null;
      sourceName?: string;
    }>,
  ): Promise<void> => {
    await client.insert({
      table: `${database}.activity`,
      format: "JSONEachRow",
      values: activities.map((activity) => ({
        id: activity.id,
        group_id: activity.groupId,
        provider_id: activity.providerId,
        user_id: userId,
        external_id: activity.id,
        canonical_type: activity.canonicalType,
        provider_type: activity.canonicalType,
        started_at: "2026-09-05 18:00:00",
        ended_at: "2026-09-05 19:00:00",
        name: activity.name,
        notes: activity.notes ?? null,
        source_name: activity.sourceName ?? activity.providerId,
        created_at: "2026-09-05 18:00:00",
        _peerdb_is_deleted: 0,
        _peerdb_version: 1,
      })),
    });
  };

  const mergedFields = async (id: string) => {
    const result = await client.query({
      query: `SELECT name, notes, provider_id, canonical_type
        FROM ${database}.v_activity WHERE id = toUUID('${id}')`,
      format: "JSONEachRow",
    });
    return z
      .array(
        z.object({
          name: z.string().nullable(),
          notes: z.string().nullable(),
          provider_id: z.string(),
          canonical_type: z.string(),
        }),
      )
      .parse(await result.json());
  };

  beforeAll(async () => {
    const url = process.env.CLICKHOUSE_URL;
    if (!url) throw new Error("CLICKHOUSE_URL is required");
    client = createClient({ url, clickhouse_settings: CLICKHOUSE_DEFAULT_SETTINGS });
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
    for (const statement of createMigration().statements) {
      await runIsolated(statement);
    }
    await runIsolated(`INSERT INTO postgres_fitness.provider_priority
      (provider_id, priority, _peerdb_is_deleted, _peerdb_version) VALUES
      ('whoop', 30, 0, 1), ('apple_health', 90, 0, 1),
      ('peloton', 20, 0, 1), ('kaya', 100, 0, 1)`);
    await runIsolated(`INSERT INTO postgres_fitness.provider_field_priority
      (provider_id, field_key, priority, _peerdb_is_deleted, _peerdb_version)
      VALUES ('kaya', 'activity.name', 0, 0, 1)`);
    await runIsolated(`INSERT INTO postgres_fitness.activity
      (id, group_id, provider_id, user_id, external_id, canonical_type,
       provider_type, started_at, ended_at, name, notes, source_name, created_at,
       _peerdb_is_deleted, _peerdb_version)
      VALUES
      ('${whoopId}', '${groupId}', 'whoop', '${userId}', 'whoop-climb',
       'climbing', 'Rock Climbing', now64(6), now64(6) + INTERVAL 1 HOUR,
       NULL, NULL, 'WHOOP', now64(6), 0, 1),
      ('${appleId}', '${groupId}', 'apple_health', '${userId}', 'apple-climb',
       'climbing', 'HKWorkoutActivityTypeClimbing', now64(6), now64(6) + INTERVAL 1 HOUR,
       NULL, NULL, 'Apple Health', now64(6), 0, 1),
      ('${pelotonId}', '${groupId}', 'peloton', '${userId}', 'peloton-climb',
       'cardio', 'Cardio', now64(6), now64(6) + INTERVAL 1 HOUR,
       '41 min 58 sec Cardio: Climbing', 'Peloton note', 'Peloton', now64(6), 0, 1),
      ('${kayaId}', '${groupId}', 'kaya', '${userId}', 'kaya-climb',
       'climbing', 'rock_climbing', now64(6), now64(6) + INTERVAL 1 HOUR,
       '${kayaName}', 'Kaya note', 'Kaya', now64(6), 0, 1)`);
  });

  afterAll(async () => {
    await client?.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client?.close();
  });

  it("selects Kaya's name while keeping generic notes and WHOOP canonical metadata", async () => {
    const result = await client.query({
      query: `SELECT name, notes, provider_id, canonical_type,
        arraySort(member_activity_ids) AS member_activity_ids
        FROM ${database}.v_activity WHERE id = toUUID('${groupId}')`,
      format: "JSONEachRow",
    });
    const rows = z
      .array(
        z.object({
          name: z.string(),
          notes: z.string(),
          provider_id: z.string(),
          canonical_type: z.string(),
          member_activity_ids: z.array(z.string()),
        }),
      )
      .parse(await result.json());
    expect(rows).toEqual([
      {
        name: kayaName,
        notes: "Peloton note",
        provider_id: "whoop",
        canonical_type: "climbing",
        member_activity_ids: [whoopId, appleId, pelotonId, kayaId],
      },
    ]);
  });

  it("skips a null Kaya name and uses the next non-null source", async () => {
    const id = "20000000-0000-4000-8000-000000000110";
    await insertActivities([
      {
        id: "20000000-0000-4000-8000-000000000111",
        groupId: id,
        providerId: "kaya",
        canonicalType: "climbing",
        name: null,
      },
      {
        id: "20000000-0000-4000-8000-000000000112",
        groupId: id,
        providerId: "peloton",
        canonicalType: "cardio",
        name: "Peloton fallback",
      },
    ]);
    expect(await mergedFields(id)).toEqual([
      {
        name: "Peloton fallback",
        notes: null,
        provider_id: "kaya",
        canonical_type: "climbing",
      },
    ]);
  });

  it("applies a notes rule independently of the name", async () => {
    const id = "20000000-0000-4000-8000-000000000120";
    await runIsolated(`INSERT INTO postgres_fitness.provider_field_priority
      (provider_id, field_key, priority, _peerdb_is_deleted, _peerdb_version)
      VALUES ('whoop', 'activity.notes', 0, 0, 1)`);
    await insertActivities([
      {
        id: "20000000-0000-4000-8000-000000000121",
        groupId: id,
        providerId: "whoop",
        canonicalType: "climbing",
        name: null,
        notes: "WHOOP note",
      },
      {
        id: "20000000-0000-4000-8000-000000000122",
        groupId: id,
        providerId: "peloton",
        canonicalType: "cardio",
        name: "Peloton name",
        notes: "Peloton note",
      },
    ]);
    expect(await mergedFields(id)).toEqual([
      {
        name: "Peloton name",
        notes: "WHOOP note",
        provider_id: "whoop",
        canonical_type: "climbing",
      },
    ]);
  });

  it("falls back to generic device priority when no field rule exists", async () => {
    const id = "20000000-0000-4000-8000-000000000130";
    await runIsolated(`INSERT INTO postgres_fitness.device_priority
      (provider_id, source_name_pattern, priority, _peerdb_is_deleted, _peerdb_version)
      VALUES ('apple_health', 'Wahoo TICKR%', 5, 0, 1)`);
    await insertActivities([
      {
        id: "20000000-0000-4000-8000-000000000131",
        groupId: id,
        providerId: "apple_health",
        canonicalType: "cycling",
        name: "Device name",
        notes: "Device note",
        sourceName: "Wahoo TICKR X",
      },
      {
        id: "20000000-0000-4000-8000-000000000132",
        groupId: id,
        providerId: "peloton",
        canonicalType: "cardio",
        name: "Peloton name",
        notes: "Peloton note",
      },
    ]);
    expect(await mergedFields(id)).toEqual([
      {
        name: "Device name",
        notes: "Device note",
        provider_id: "apple_health",
        canonical_type: "cycling",
      },
    ]);
  });

  it("lets the name rule beat generic device priority for that field only", async () => {
    const id = "20000000-0000-4000-8000-000000000140";
    await insertActivities([
      {
        id: "20000000-0000-4000-8000-000000000141",
        groupId: id,
        providerId: "apple_health",
        canonicalType: "climbing",
        name: "Device name",
        notes: "Device note",
        sourceName: "Wahoo TICKR X",
      },
      {
        id: "20000000-0000-4000-8000-000000000142",
        groupId: id,
        providerId: "kaya",
        canonicalType: "climbing",
        name: "Kaya route",
        notes: "Kaya note",
      },
    ]);
    expect(await mergedFields(id)).toEqual([
      {
        name: "Kaya route",
        notes: "Device note",
        provider_id: "apple_health",
        canonical_type: "climbing",
      },
    ]);
  });

  it("breaks equal field-priority ties by source activity ID", async () => {
    const id = "20000000-0000-4000-8000-000000000150";
    await runIsolated(`INSERT INTO postgres_fitness.provider_priority
      (provider_id, priority, _peerdb_is_deleted, _peerdb_version) VALUES
      ('field-a', 70, 0, 1), ('field-b', 80, 0, 1)`);
    await runIsolated(`INSERT INTO postgres_fitness.provider_field_priority
      (provider_id, field_key, priority, _peerdb_is_deleted, _peerdb_version) VALUES
      ('field-a', 'activity.name', 0, 0, 1),
      ('field-b', 'activity.name', 0, 0, 1)`);
    await insertActivities([
      {
        id: "20000000-0000-4000-8000-000000000152",
        groupId: id,
        providerId: "field-a",
        canonicalType: "walking",
        name: "Higher ID",
      },
      {
        id: "20000000-0000-4000-8000-000000000151",
        groupId: id,
        providerId: "field-b",
        canonicalType: "walking",
        name: "Lower ID",
      },
    ]);
    expect(await mergedFields(id)).toEqual([
      {
        name: "Lower ID",
        notes: null,
        provider_id: "field-a",
        canonical_type: "walking",
      },
    ]);
  });

  it("keeps an unrelated group's generic name and canonical type", async () => {
    const id = "20000000-0000-4000-8000-000000000160";
    await insertActivities([
      {
        id: "20000000-0000-4000-8000-000000000161",
        groupId: id,
        providerId: "whoop",
        canonicalType: "cycling",
        name: null,
      },
      {
        id: "20000000-0000-4000-8000-000000000162",
        groupId: id,
        providerId: "peloton",
        canonicalType: "cardio",
        name: "Morning ride",
      },
    ]);
    expect(await mergedFields(id)).toEqual([
      {
        name: "Morning ride",
        notes: null,
        provider_id: "whoop",
        canonical_type: "cycling",
      },
    ]);
  });

  it("ignores a deleted mirrored name rule and restores generic ordering", async () => {
    await runIsolated(`INSERT INTO postgres_fitness.provider_field_priority
      (provider_id, field_key, priority, _peerdb_is_deleted, _peerdb_version)
      VALUES ('kaya', 'activity.name', 0, 1, 2)`);
    expect(await mergedFields(groupId)).toEqual([
      {
        name: "41 min 58 sec Cardio: Climbing",
        notes: "Peloton note",
        provider_id: "whoop",
        canonical_type: "climbing",
      },
    ]);
  });
});
