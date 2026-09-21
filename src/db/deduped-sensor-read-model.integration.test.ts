import { randomBytes } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { readModelSql, renderDbtModelSql } from "./read-model-sql-test-helpers.ts";

type ClickHouseClient = ReturnType<typeof createClient>;

const selectedSensorRowSchema = z.object({
  scalar: z.coerce.number(),
  provider_id: z.string(),
  member_activity_id: z.string().nullable(),
  device_id: z.string().nullable(),
  source_external_id: z.string().nullable(),
  source_type: z.string().nullable(),
  measurement_kind: z.string(),
  source_metric_stream_id: z.string(),
  source_activity_id: z.string().nullable(),
  provider_priority: z.coerce.number(),
  source_refreshed_at: z.string(),
  is_deleted: z.coerce.number(),
});

const userId = "00000000-0000-0000-0000-000000000001";
const winnerId = "10000000-0000-0000-0000-000000000001";

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
    const activeClient = requireClient(client);
    const result = await activeClient.query({
      query: renderDedupedSensorSql(database),
      format: "JSONEachRow",
    });
    const rows = z.array(selectedSensorRowSchema).parse(await result.json());

    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.is_deleted === 0)).toEqual({
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
      source_refreshed_at: "2026-09-15 00:03:00.000000000",
      is_deleted: 0,
    });
    expect(rows.find((row) => row.is_deleted === 1)?.source_refreshed_at).toBe(
      "2026-09-15 00:04:00.000000000",
    );
  });
});

function requireClient(client: ClickHouseClient | undefined): ClickHouseClient {
  if (!client) throw new Error("ClickHouse client was not initialized");
  return client;
}

function renderDedupedSensorSql(database: string): string {
  return renderDbtModelSql(readModelSql("deduped_sensor.sql"), { isIncremental: false })
    .replaceAll("{{ ref('sensor_scalar_sample') }}", `${database}.sensor_scalar_sample`)
    .concat("\nSETTINGS max_threads = 1");
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
      channel String,
      provider_id String,
      source_external_id Nullable(String),
      device_id Nullable(String),
      source_type Nullable(String),
      measurement_kind String,
      scalar Float64,
      provider_priority UInt16,
      _peerdb_synced_at DateTime64(9, 'UTC'),
      _peerdb_is_deleted UInt8
    ) ENGINE = MergeTree ORDER BY (user_id, channel, recorded_at, id)`,
  });
  await client.insert({
    table: `${database}.sensor_scalar_sample`,
    values: [
      {
        id: winnerId,
        activity_id: null,
        member_activity_id: null,
        user_id: userId,
        recorded_at: "2026-09-14 10:00:00",
        channel: "heart_rate",
        provider_id: "provider-a",
        source_external_id: null,
        device_id: null,
        source_type: null,
        measurement_kind: "direct",
        scalar: 111,
        provider_priority: 10,
        _peerdb_synced_at: "2026-09-15 00:01:00",
        _peerdb_is_deleted: 0,
      },
      {
        id: "10000000-0000-0000-0000-000000000002",
        activity_id: "20000000-0000-0000-0000-000000000002",
        member_activity_id: "20000000-0000-0000-0000-000000000002",
        user_id: userId,
        recorded_at: "2026-09-14 10:00:00",
        channel: "heart_rate",
        provider_id: "provider-b",
        source_external_id: "provider-b-sample",
        device_id: "provider-b-device",
        source_type: "activity",
        measurement_kind: "estimated",
        scalar: 222,
        provider_priority: 20,
        _peerdb_synced_at: "2026-09-15 00:02:00",
        _peerdb_is_deleted: 0,
      },
      {
        id: "10000000-0000-0000-0000-000000000003",
        activity_id: null,
        member_activity_id: null,
        user_id: userId,
        recorded_at: "2026-09-14 10:00:00",
        channel: "heart_rate",
        provider_id: "deleted-provider",
        source_external_id: null,
        device_id: null,
        source_type: null,
        measurement_kind: "unknown",
        scalar: 333,
        provider_priority: 1,
        _peerdb_synced_at: "2026-09-15 00:03:00",
        _peerdb_is_deleted: 1,
      },
      {
        id: "10000000-0000-0000-0000-000000000004",
        activity_id: null,
        member_activity_id: null,
        user_id: userId,
        recorded_at: "2026-09-14 11:00:00",
        channel: "heart_rate",
        provider_id: "deleted-provider",
        source_external_id: null,
        device_id: null,
        source_type: null,
        measurement_kind: "unknown",
        scalar: 444,
        provider_priority: 1,
        _peerdb_synced_at: "2026-09-15 00:04:00",
        _peerdb_is_deleted: 1,
      },
    ],
    format: "JSONEachRow",
  });
}
