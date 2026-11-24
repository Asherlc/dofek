import { randomBytes } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { readModelSql, renderDbtModelSql } from "./read-model-sql-test-helpers.ts";

type ClickHouseClient = ReturnType<typeof createClient>;

const selectedSensorRowSchema = z.object({
  recorded_at: z.string(),
  scalar: z.coerce.number().nullable(),
  provider_id: z.string().nullable(),
  member_activity_id: z.string().nullable(),
  device_id: z.string().nullable(),
  source_external_id: z.string().nullable(),
  source_type: z.string().nullable(),
  measurement_kind: z.string().nullable(),
  source_metric_stream_id: z.string().nullable(),
  source_activity_id: z.string().nullable(),
  provider_priority: z.coerce.number(),
  source_refreshed_at: z.string(),
  is_deleted: z.coerce.number(),
  heart_rate_changed_at: z.string(),
});

const userId = "00000000-0000-0000-0000-000000000001";
const winnerId = "10000000-0000-0000-0000-000000000001";
const preservedStamp = "2026-09-14 12:00:00.000000000";
const latestSourceFreshness = "2026-09-15 00:03:00.000000000";

describe("deduped_sensor read model", () => {
  let client: ClickHouseClient | undefined;
  const database = `deduped_sensor_test_${randomBytes(6).toString("hex")}`;

  beforeAll(async () => {
    const clickHouseUrl = process.env.CLICKHOUSE_URL?.trim();
    if (!clickHouseUrl) {
      throw new Error("CLICKHOUSE_URL is required for deduped sensor integration tests");
    }
    client = createClient({ url: clickHouseUrl, request_timeout: 120_000 });
    await client.query({ query: "SELECT 1", format: "JSONEachRow" });
    await seedFixture(client, database);
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
      await client.close();
    }
  });

  it("selects one complete provider row while preserving nullable provenance", async () => {
    const rows = await queryDeduped(requireClient(client), database, false);
    expect(rows).toHaveLength(2);
    const liveRow = rows.find((row) => row.is_deleted === 0);
    expect(liveRow).toMatchObject({
      scalar: 111,
      provider_id: "provider-a",
      member_activity_id: null,
      device_id: null,
      source_external_id: null,
      source_type: null,
      measurement_kind: "direct",
      source_metric_stream_id: winnerId,
      source_activity_id: null,
      provider_priority: 10,
      source_refreshed_at: latestSourceFreshness,
      is_deleted: 0,
    });
    expect(liveRow?.heart_rate_changed_at).not.toBe("1970-01-01 00:00:00.000000000");
    expect(rows.find((row) => row.is_deleted === 1)?.source_refreshed_at).toBe(
      "2026-09-15 00:04:00.000000000",
    );
  });

  it("preserves heart_rate_changed_at for equal heart-rate payload replays", async () => {
    const rows = await queryDeduped(requireClient(client), database, true);
    const liveRow = rows.find((row) => row.is_deleted === 0 && row.scalar === 111);
    expect(liveRow?.heart_rate_changed_at).toBe(preservedStamp);
    expect(liveRow?.source_refreshed_at).toBe(latestSourceFreshness);
  });

  it("assigns a new heart_rate_changed_at for priority corrections with an older source clock", async () => {
    const activeClient = requireClient(client);
    await activeClient.command({
      query: `INSERT INTO ${database}.sensor_scalar_sample (
        id, activity_id, member_activity_id, user_id, recorded_at, channel, provider_id,
        source_external_id, device_id, source_type, measurement_kind, scalar, provider_priority,
        _peerdb_synced_at, _peerdb_is_deleted, _peerdb_version
      ) VALUES (
        '10000000-0000-0000-0000-000000000099', NULL, NULL, {userId:UUID},
        '2026-09-14 10:00:00', 'heart_rate', 'provider-c',
        NULL, NULL, NULL, 'direct', 67, 5,
        '2026-09-14 23:00:00', 0, 2
      )`,
      query_params: { userId },
    });

    const rows = await queryDeduped(activeClient, database, true);
    const liveRow = rows.find((row) => row.is_deleted === 0 && row.scalar === 67);
    expect(liveRow?.source_refreshed_at).toBe(latestSourceFreshness);
    expect(liveRow?.heart_rate_changed_at).not.toBe(preservedStamp);
    expect(liveRow?.heart_rate_changed_at).not.toBe("1970-01-01 00:00:00.000000000");
  });
});

function requireClient(client: ClickHouseClient | undefined): ClickHouseClient {
  if (!client) throw new Error("ClickHouse client was not initialized");
  return client;
}

async function queryDeduped(
  client: ClickHouseClient,
  database: string,
  isIncremental: boolean,
): Promise<z.infer<typeof selectedSensorRowSchema>[]> {
  const result = await client.query({
    query: renderDbtModelSql(readModelSql("deduped_sensor.sql"), { isIncremental })
      .replaceAll("{{ ref('sensor_scalar_sample') }}", `${database}.sensor_scalar_sample`)
      .replaceAll("{{ this }}", `${database}.deduped_sensor`)
      .concat("\nSETTINGS max_threads = 1"),
    format: "JSONEachRow",
  });
  return z.array(selectedSensorRowSchema).parse(await result.json());
}

async function seedFixture(client: ClickHouseClient, database: string): Promise<void> {
  await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
  await client.command({ query: `CREATE DATABASE ${database}` });
  await client.command({
    query: `CREATE TABLE ${database}.sensor_scalar_sample (
      id UUID,
      activity_id Nullable(UUID),
      member_activity_id Nullable(UUID),
      user_id UUID,
      recorded_at DateTime64(9, 'UTC'),
      recorded_date Date DEFAULT toDate(recorded_at),
      channel String,
      provider_id String,
      source_external_id Nullable(String),
      device_id Nullable(String),
      source_type Nullable(String),
      measurement_kind String,
      scalar Float64,
      provider_priority UInt16,
      _peerdb_synced_at DateTime64(9, 'UTC'),
      _peerdb_is_deleted UInt8,
      _peerdb_version Int64 DEFAULT 1
    ) ENGINE = ReplacingMergeTree(_peerdb_version) ORDER BY (user_id, channel, recorded_at, id)`,
  });
  await client.command({
    query: `CREATE TABLE ${database}.deduped_sensor (
      user_id UUID,
      recorded_at DateTime64(6, 'UTC'),
      recorded_date Date,
      channel LowCardinality(String),
      scalar Nullable(Float32),
      provider_id Nullable(String),
      member_activity_id Nullable(UUID),
      device_id Nullable(String),
      source_external_id Nullable(String),
      source_type Nullable(String),
      measurement_kind LowCardinality(String),
      source_metric_stream_id Nullable(UUID),
      source_activity_id Nullable(UUID),
      provider_priority Int32,
      source_refreshed_at DateTime64(9, 'UTC'),
      refresh_version UInt64,
      is_deleted UInt8,
      refreshed_at DateTime64(9, 'UTC'),
      heart_rate_changed_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree(refresh_version)
    ORDER BY (user_id, channel, recorded_date, recorded_at)`,
  });
  await client.command({
    query: `INSERT INTO ${database}.sensor_scalar_sample (
      id, activity_id, member_activity_id, user_id, recorded_at, channel, provider_id,
      source_external_id, device_id, source_type, measurement_kind, scalar, provider_priority,
      _peerdb_synced_at, _peerdb_is_deleted
    ) VALUES
      ('${winnerId}', NULL, NULL, '${userId}', '2026-09-14 10:00:00', 'heart_rate', 'provider-a',
        NULL, NULL, NULL, 'direct', 111, 10, '2026-09-15 00:01:00', 0),
      ('10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002',
        '20000000-0000-0000-0000-000000000002', '${userId}', '2026-09-14 10:00:00', 'heart_rate',
        'provider-b', 'provider-b-sample', 'provider-b-device', 'activity', 'estimated', 222, 20,
        '2026-09-15 00:02:00', 0),
      ('10000000-0000-0000-0000-000000000003', NULL, NULL, '${userId}', '2026-09-14 10:00:00',
        'heart_rate', 'deleted-provider', NULL, NULL, NULL, 'unknown', 333, 1,
        '2026-09-15 00:03:00', 1),
      ('10000000-0000-0000-0000-000000000004', NULL, NULL, '${userId}', '2026-09-14 11:00:00',
        'heart_rate', 'deleted-provider', NULL, NULL, NULL, 'unknown', 444, 1,
        '2026-09-15 00:04:00', 1)`,
  });
  await client.command({
    query: `INSERT INTO ${database}.deduped_sensor (
      user_id, recorded_at, recorded_date, channel, scalar, provider_id,
      member_activity_id, device_id, source_external_id, source_type, measurement_kind,
      source_metric_stream_id, source_activity_id, provider_priority, source_refreshed_at,
      refresh_version, is_deleted, refreshed_at, heart_rate_changed_at
    ) VALUES
      ('${userId}', '2026-09-14 10:00:00', '2026-09-14', 'heart_rate', 111, 'provider-a',
        NULL, NULL, NULL, NULL, 'direct', '${winnerId}', NULL, 10, '2026-09-15 00:01:00',
        1, 0, '2026-09-15 00:01:00', '${preservedStamp}'),
      ('${userId}', '2026-09-14 11:00:00', '2026-09-14', 'heart_rate', 444, 'deleted-provider',
        NULL, NULL, NULL, NULL, 'unknown', '10000000-0000-0000-0000-000000000004', NULL, 1,
        '2026-09-15 00:04:00', 1, 1, '2026-09-15 00:04:00', '${preservedStamp}')`,
  });
}
