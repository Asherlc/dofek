import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CLICKHOUSE_DEFAULT_SETTINGS } from "./clickhouse.ts";
import { buildActivitySensorSummaryRowsTableSql } from "./clickhouse-activity-sensor-summary.ts";
import { buildActivitySummaryRowsTableSql } from "./clickhouse-activity-summary.ts";
import {
  buildPostgresFitnessActivityRawTableStatement,
  buildPostgresFitnessProviderFieldPriorityRawTableStatement,
} from "./clickhouse-raw-tables.ts";
import { readModelSql, renderDbtModelSql } from "./read-model-sql-test-helpers.ts";

const userId = "00000000-0000-0000-0000-000000000001";
const groupId = "30000000-0000-4000-8000-000000000100";
const whoopId = "30000000-0000-4000-8000-000000000101";
const appleId = "30000000-0000-4000-8000-000000000102";
const pelotonId = "30000000-0000-4000-8000-000000000103";
const kayaId = "30000000-0000-4000-8000-000000000104";
const kayaName = "Kaya climbing at Touchstone Great Western Power Company";

interface SourceFixture {
  id: string;
  groupId: string;
  providerId: string;
  canonicalType: string;
  providerType: string;
  name: string | null;
  notes?: string | null;
  priority: number;
  sourceName?: string;
}

describe("dbt merged activity field priorities", () => {
  const database = `activity_field_dbt_${randomUUID().replaceAll("-", "")}`;
  let client: ReturnType<typeof createClient>;

  const runIsolated = async (statement: string): Promise<void> => {
    await client.command({
      query: statement
        .replaceAll("analytics.", `${database}.`)
        .replaceAll("postgres_fitness.", `${database}.`),
    });
  };

  const renderModel = (file: string, incremental: boolean): string =>
    renderDbtModelSql(readModelSql(file), {
      isIncremental: incremental,
      activityRefreshScoped: false,
    })
      .replaceAll("{{ initial_lookback_days }}", "120")
      .replaceAll("{{ this }}", `${database}.${file.replace(".sql", "")}`)
      .replace(/\{\{ ref\('([^']+)'\) \}\}/g, `${database}.$1`)
      .replaceAll("{{ source('postgres_fitness', 'activity') }}", `${database}.activity`)
      .replaceAll(
        "{{ source('postgres_fitness', 'provider_field_priority') }}",
        `${database}.provider_field_priority`,
      )
      .concat("\nSETTINGS join_use_nulls = 1, enable_materialized_cte = 1, max_threads = 1");

  const insertSources = async (sources: SourceFixture[]): Promise<void> => {
    await client.insert({
      table: `${database}.activity_source_records`,
      format: "JSONEachRow",
      values: sources.map((source) => ({
        activity_id: source.id,
        group_id: source.groupId,
        provider_id: source.providerId,
        user_id: userId,
        external_id: source.id,
        canonical_type: source.canonicalType,
        provider_type: source.providerType,
        started_at: "2026-09-01 18:00:00",
        ended_at: "2026-09-01 19:00:00",
        source_name: source.sourceName ?? source.providerId,
        name: source.name,
        notes: source.notes ?? null,
        local_time_source: "unknown",
        raw: "{}",
        source_synced_at: "2026-09-01 20:00:00",
        priority: source.priority,
        refresh_version: 1,
        is_deleted: 0,
        refreshed_at: "2026-09-01 20:00:00",
      })),
    });
  };

  const refreshDeduped = async (incremental: boolean): Promise<void> => {
    await client.command({
      query: `INSERT INTO ${database}.deduped_activities ${renderModel("deduped_activities.sql", incremental)}`,
    });
  };

  const refreshSummary = async (incremental: boolean): Promise<void> => {
    await client.command({
      query: `INSERT INTO ${database}.activity_summary_rows ${renderModel("activity_summary_rows.sql", incremental)}`,
    });
  };

  const summaryName = async (id: string) => {
    const result = await client.query({
      query: `SELECT name FROM ${database}.activity_summary_rows FINAL
        WHERE activity_id = toUUID('${id}')`,
      format: "JSONEachRow",
    });
    return z.array(z.object({ name: z.string().nullable() })).parse(await result.json());
  };

  const mergedFields = async (id: string) => {
    const result = await client.query({
      query: `SELECT name, notes, provider_id, canonical_type
        FROM ${database}.deduped_activities FINAL
        WHERE activity_id = toUUID('${id}')`,
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
    await runIsolated(buildPostgresFitnessProviderFieldPriorityRawTableStatement());
    await client.command({
      query: `CREATE TABLE ${database}.activity_source_records (
      activity_id UUID, group_id Nullable(UUID), provider_id Nullable(String),
      user_id Nullable(UUID), external_id Nullable(String), canonical_type Nullable(String),
      provider_type Nullable(String), modality Nullable(String),
      started_at Nullable(DateTime64(6, 'UTC')), ended_at Nullable(DateTime64(6, 'UTC')),
      source_name Nullable(String), name Nullable(String), notes Nullable(String),
      timezone Nullable(String), start_utc_offset_minutes Nullable(Int16),
      end_utc_offset_minutes Nullable(Int16), local_time_source LowCardinality(String),
      raw Nullable(String), source_synced_at Nullable(DateTime64(9, 'UTC')),
      priority Nullable(Int32), refresh_version UInt64, is_deleted UInt8,
      refreshed_at DateTime64(9, 'UTC'))
      ENGINE = ReplacingMergeTree(refresh_version) ORDER BY activity_id`,
    });
    await client.command({
      query: `CREATE TABLE ${database}.deduped_sensor (
      user_id UUID, source_activity_id Nullable(UUID), channel String,
      recorded_at DateTime64(9, 'UTC'), is_deleted UInt8, refresh_version UInt64)
      ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, recorded_at, channel)`,
    });
    await client.command({
      query: `CREATE TABLE ${database}.deduped_activities (
      activity_id UUID, provider_id String, user_id UUID, primary_activity_id UUID,
      canonical_type String, provider_type String, modality Nullable(String),
      started_at DateTime64(6, 'UTC'), ended_at Nullable(DateTime64(6, 'UTC')),
      source_name Nullable(String), name Nullable(String), notes Nullable(String),
      timezone Nullable(String), start_utc_offset_minutes Nullable(Int16),
      end_utc_offset_minutes Nullable(Int16), local_time_source LowCardinality(String),
      raw Nullable(String), source_synced_at DateTime64(9, 'UTC'),
      source_providers Array(String), source_external_ids Array(Map(String, String)),
      absent_source_external_ids Array(Map(String, String)), member_activity_ids Array(UUID),
      refresh_version UInt64, is_deleted UInt8, refreshed_at DateTime64(9, 'UTC'))
      ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id)`,
    });
    await client.command({
      query: `CREATE TABLE ${database}.deduped_activity_members (
      activity_id UUID, user_id UUID, member_activity_id UUID, is_deleted UInt8,
      refresh_version UInt64) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, member_activity_id)`,
    });
    await runIsolated(buildActivitySensorSummaryRowsTableSql());
    await client.command({
      query: `CREATE TABLE ${database}.activity_location_summary_rows (
      activity_id UUID, user_id UUID, total_distance Nullable(Float64),
      centroid_lat Nullable(Float64), centroid_lng Nullable(Float64),
      refresh_version UInt64, is_deleted UInt8, refreshed_at DateTime64(9, 'UTC'))
      ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id)`,
    });
    await runIsolated(buildActivitySummaryRowsTableSql());
    await insertSources([
      {
        id: whoopId,
        groupId,
        providerId: "whoop",
        canonicalType: "climbing",
        providerType: "Rock Climbing",
        name: null,
        priority: 30,
      },
      {
        id: appleId,
        groupId,
        providerId: "apple_health",
        canonicalType: "climbing",
        providerType: "HKWorkoutActivityTypeClimbing",
        name: null,
        priority: 90,
      },
      {
        id: pelotonId,
        groupId,
        providerId: "peloton",
        canonicalType: "cardio",
        providerType: "Cardio",
        name: "41 min 58 sec Cardio: Climbing",
        notes: "Peloton note",
        priority: 20,
      },
      {
        id: kayaId,
        groupId,
        providerId: "kaya",
        canonicalType: "climbing",
        providerType: "rock_climbing",
        name: kayaName,
        notes: "Kaya note",
        priority: 100,
      },
    ]);
    await client.insert({
      table: `${database}.provider_field_priority`,
      format: "JSONEachRow",
      values: [
        {
          provider_id: "kaya",
          field_key: "activity.name",
          priority: 0,
          _peerdb_is_deleted: 0,
          _peerdb_version: 1,
        },
      ],
    });
  });

  afterAll(async () => {
    await client?.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client?.close();
  });

  it("selects Kaya's name while keeping WHOOP canonical metadata and generic notes", async () => {
    await refreshDeduped(false);
    const result = await client.query({
      query: `SELECT name, notes, provider_id, canonical_type,
        arraySort(member_activity_ids) AS member_activity_ids
        FROM ${database}.deduped_activities FINAL
        WHERE activity_id = toUUID('${groupId}')`,
      format: "JSONEachRow",
    });
    const rows = z
      .array(
        z.object({
          name: z.string().nullable(),
          notes: z.string().nullable(),
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

  it("skips a null preferred name and uses the next named source", async () => {
    const id = randomUUID();
    await insertSources([
      {
        id: randomUUID(),
        groupId: id,
        providerId: "kaya",
        canonicalType: "climbing",
        providerType: "rock_climbing",
        name: null,
        priority: 100,
      },
      {
        id: randomUUID(),
        groupId: id,
        providerId: "peloton",
        canonicalType: "cardio",
        providerType: "Cardio",
        name: "Peloton fallback",
        priority: 20,
      },
    ]);
    await refreshDeduped(true);
    expect(await mergedFields(id)).toEqual([
      {
        name: "Peloton fallback",
        notes: null,
        provider_id: "kaya",
        canonical_type: "climbing",
      },
    ]);
  });

  it("selects notes independently through an arbitrary provider's 64-bit priority", async () => {
    const id = randomUUID();
    const noteProvider = `note-${randomUUID()}`;
    await client.insert({
      table: `${database}.provider_field_priority`,
      format: "JSONEachRow",
      values: [
        {
          provider_id: noteProvider,
          field_key: "activity.notes",
          priority: -2147483649,
          _peerdb_is_deleted: 0,
          _peerdb_version: 1,
        },
      ],
    });
    await insertSources([
      {
        id: randomUUID(),
        groupId: id,
        providerId: noteProvider,
        canonicalType: "climbing",
        providerType: "Rock Climbing",
        name: null,
        notes: "Route note",
        priority: 100,
      },
      {
        id: randomUUID(),
        groupId: id,
        providerId: "peloton",
        canonicalType: "cardio",
        providerType: "Cardio",
        name: "Peloton name",
        notes: "Peloton note",
        priority: 20,
      },
    ]);
    await refreshDeduped(true);
    expect(await mergedFields(id)).toEqual([
      {
        name: "Peloton name",
        notes: "Route note",
        provider_id: noteProvider,
        canonical_type: "climbing",
      },
    ]);
  });

  it("falls back to generic device priority without a field rule", async () => {
    const id = randomUUID();
    await insertSources([
      {
        id: randomUUID(),
        groupId: id,
        providerId: "apple_health",
        canonicalType: "cycling",
        providerType: "Cycling",
        name: "Device name",
        notes: "Device note",
        sourceName: "Wahoo TICKR X",
        priority: 5,
      },
      {
        id: randomUUID(),
        groupId: id,
        providerId: "peloton",
        canonicalType: "cardio",
        providerType: "Cardio",
        name: "Peloton name",
        notes: "Peloton note",
        priority: 20,
      },
    ]);
    await refreshDeduped(true);
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
    const id = randomUUID();
    await insertSources([
      {
        id: randomUUID(),
        groupId: id,
        providerId: "apple_health",
        canonicalType: "climbing",
        providerType: "Rock Climbing",
        name: "Device name",
        notes: "Device note",
        sourceName: "Wahoo TICKR X",
        priority: 5,
      },
      {
        id: randomUUID(),
        groupId: id,
        providerId: "kaya",
        canonicalType: "climbing",
        providerType: "rock_climbing",
        name: "Kaya route",
        notes: "Kaya note",
        priority: 100,
      },
    ]);
    await refreshDeduped(true);
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
    const id = randomUUID();
    const firstId = randomUUID();
    const secondId = randomUUID();
    const lowerId = firstId < secondId ? firstId : secondId;
    const higherId = firstId < secondId ? secondId : firstId;
    const providerA = `tie-a-${randomUUID()}`;
    const providerB = `tie-b-${randomUUID()}`;
    await client.insert({
      table: `${database}.provider_field_priority`,
      format: "JSONEachRow",
      values: [providerA, providerB].map((providerId) => ({
        provider_id: providerId,
        field_key: "activity.name",
        priority: 0,
        _peerdb_is_deleted: 0,
        _peerdb_version: 1,
      })),
    });
    await insertSources([
      {
        id: higherId,
        groupId: id,
        providerId: providerA,
        canonicalType: "walking",
        providerType: "Walking",
        name: "Higher ID",
        priority: 70,
      },
      {
        id: lowerId,
        groupId: id,
        providerId: providerB,
        canonicalType: "walking",
        providerType: "Walking",
        name: "Lower ID",
        priority: 80,
      },
    ]);
    await refreshDeduped(true);
    expect(await mergedFields(id)).toEqual([
      {
        name: "Lower ID",
        notes: null,
        provider_id: providerA,
        canonical_type: "walking",
      },
    ]);
  });

  it("keeps an unrelated group's generic name and canonical type", async () => {
    const id = randomUUID();
    await insertSources([
      {
        id: randomUUID(),
        groupId: id,
        providerId: "whoop",
        canonicalType: "cycling",
        providerType: "Cycling",
        name: null,
        priority: 30,
      },
      {
        id: randomUUID(),
        groupId: id,
        providerId: "peloton",
        canonicalType: "cardio",
        providerType: "Cardio",
        name: "Morning ride",
        priority: 20,
      },
    ]);
    await refreshDeduped(true);
    expect(await mergedFields(id)).toEqual([
      {
        name: "Morning ride",
        notes: null,
        provider_id: "whoop",
        canonical_type: "cycling",
      },
    ]);
  });

  it("ignores a tombstoned rule and restores generic priority", async () => {
    const id = randomUUID();
    const provider = `deleted-${randomUUID()}`;
    await client.insert({
      table: `${database}.provider_field_priority`,
      format: "JSONEachRow",
      values: [
        {
          provider_id: provider,
          field_key: "activity.name",
          priority: 0,
          _peerdb_is_deleted: 0,
          _peerdb_version: 1,
        },
      ],
    });
    await insertSources([
      {
        id: randomUUID(),
        groupId: id,
        providerId: provider,
        canonicalType: "climbing",
        providerType: "Rock Climbing",
        name: "Preferred name",
        priority: 100,
      },
      {
        id: randomUUID(),
        groupId: id,
        providerId: "peloton",
        canonicalType: "cardio",
        providerType: "Cardio",
        name: "Generic name",
        priority: 20,
      },
    ]);
    await refreshDeduped(true);
    expect((await mergedFields(id))[0]?.name).toBe("Preferred name");
    await client.insert({
      table: `${database}.provider_field_priority`,
      format: "JSONEachRow",
      values: [
        {
          provider_id: provider,
          field_key: "activity.name",
          priority: 0,
          _peerdb_is_deleted: 1,
          _peerdb_version: 2,
        },
      ],
    });
    await refreshDeduped(true);
    expect(await mergedFields(id)).toEqual([
      {
        name: "Generic name",
        notes: null,
        provider_id: provider,
        canonical_type: "climbing",
      },
    ]);
  });

  it("refreshes the merged row and summary when a field priority changes", async () => {
    const id = randomUUID();
    await insertSources([
      {
        id: randomUUID(),
        groupId: id,
        providerId: "whoop",
        canonicalType: "climbing",
        providerType: "Rock Climbing",
        name: null,
        priority: 30,
      },
      {
        id: randomUUID(),
        groupId: id,
        providerId: "peloton",
        canonicalType: "cardio",
        providerType: "Cardio",
        name: "Peloton title",
        priority: 20,
      },
      {
        id: randomUUID(),
        groupId: id,
        providerId: "kaya",
        canonicalType: "climbing",
        providerType: "rock_climbing",
        name: "Kaya title",
        priority: 100,
      },
    ]);
    await refreshDeduped(true);
    await refreshSummary(false);
    expect((await mergedFields(id))[0]?.name).toBe("Kaya title");
    expect(await summaryName(id)).toEqual([{ name: "Kaya title" }]);

    await client.insert({
      table: `${database}.provider_field_priority`,
      format: "JSONEachRow",
      values: [
        {
          provider_id: "kaya",
          field_key: "activity.name",
          priority: 50,
          _peerdb_is_deleted: 0,
          _peerdb_version: 2,
        },
      ],
    });
    await refreshDeduped(true);
    expect((await mergedFields(id))[0]?.name).toBe("Peloton title");
    await refreshSummary(true);
    expect(await summaryName(id)).toEqual([{ name: "Peloton title" }]);
  });
});
