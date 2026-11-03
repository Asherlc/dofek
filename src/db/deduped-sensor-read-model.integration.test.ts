import { randomBytes, randomUUID } from "node:crypto";
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

  it("selects latest sample versions within a bounded query memory budget", async () => {
    const activeClient = requireClient(client);
    await seedMemoryFixture(activeClient, database);
    const query = renderDedupedSensorSql(database).replace(/\nSETTINGS max_threads = 1$/, "");
    const result = await activeClient.query({
      query: `SELECT count() AS count, min(scalar) AS minimum, max(scalar) AS maximum,
          sum(cityHash64(tuple(* EXCEPT(refresh_version)))) AS checksum
        FROM (${query})
        SETTINGS max_threads = 1, max_memory_usage = 220000000`,
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([
      expect.objectContaining({ count: 1000, minimum: 222, maximum: 222 }),
    ]);
  }, 120_000);

  it("spills below the query memory cap and preserves the complete result", async () => {
    const activeClient = requireClient(client);
    await seedMemoryFixture(activeClient, database);
    const model = renderDedupedSensorSql(database).replace(/\nSETTINGS max_threads = 1$/, "");
    const read = async (settings: string, queryId: string = randomUUID()) => {
      const result = await activeClient.query({
        query: `SELECT count() AS count, min(scalar) AS minimum, max(scalar) AS maximum,
            sum(cityHash64(tuple(* EXCEPT(refresh_version)))) AS checksum
          FROM (${model})
          SETTINGS max_threads = 1, output_format_json_quote_64bit_integers = 1, ${settings}`,
        query_id: queryId,
        format: "JSONEachRow",
      });
      return z
        .array(
          z.object({
            count: z.coerce.number(),
            minimum: z.number(),
            maximum: z.number(),
            checksum: z.string(),
          }),
        )
        .parse(await result.json());
    };
    const reference = await read("max_memory_usage = 220000000");
    const budgets = `max_memory_usage = 134217728,
      max_temporary_data_on_disk_size_for_query = 134217728,
      max_block_size = 8192,
      max_bytes_before_external_sort = 16777216,
      max_bytes_before_external_group_by = 16777216`;
    await expect(read(budgets)).rejects.toThrow("Query memory limit exceeded");

    const queryId = `deduped-sensor-spill-${randomUUID()}`;
    const spilled = await read(`${budgets}, max_bytes_ratio_before_external_sort = 0`, queryId);
    expect(spilled).toEqual(reference);
    expect(spilled[0]).toMatchObject({ count: 1000, minimum: 222, maximum: 222 });
    await activeClient.command({ query: "SYSTEM FLUSH LOGS" });
    const profile = await activeClient.query({
      query: `SELECT memory_usage, exception_code,
          ProfileEvents['ExternalSortWritePart'] AS sort_parts
        FROM system.query_log
        WHERE query_id = {queryId:String} AND type = 'QueryFinish'`,
      query_params: { queryId },
      format: "JSONEachRow",
    });
    const rows = z
      .array(
        z.object({
          memory_usage: z.coerce.number(),
          exception_code: z.number(),
          sort_parts: z.coerce.number(),
        }),
      )
      .parse(await profile.json());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.exception_code).toBe(0);
    expect(rows[0]?.memory_usage).toBeLessThanOrEqual(134217728);
    expect(rows[0]?.sort_parts).toBeGreaterThan(0);
  }, 120_000);
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

async function seedMemoryFixture(activeClient: ClickHouseClient, database: string): Promise<void> {
  await activeClient.command({ query: `TRUNCATE TABLE ${database}.sensor_scalar_sample` });
  await activeClient.command({ query: `SYSTEM STOP MERGES ${database}.sensor_scalar_sample` });
  for (const version of [1, 2]) {
    for (let offset = 0; offset < 400_000; offset += 50_000) {
      await activeClient.command({
        query: `INSERT INTO ${database}.sensor_scalar_sample
            SELECT toUUID(concat('10000000-0000-0000-0000-', leftPad(toString(number), 12, '0'))),
              NULL, NULL, toUUID('${userId}'),
              toDateTime64('2026-09-14', 9) + toIntervalMillisecond(number % 1000),
              toDate('2026-09-14'), 'heart_rate', 'fixture', toString(number),
              repeat('d', 32), repeat('t', 16), 'direct', ${version * 111}, 10,
              toDateTime64('2026-09-15 00:01:00', 9), 0, ${version}
            FROM numbers(${offset}, 50000)
            SETTINGS max_threads = 1, max_memory_usage = 220000000`,
      });
    }
  }
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
    ) ENGINE = ReplacingMergeTree(_peerdb_version)
    ORDER BY (user_id, channel, recorded_date, recorded_at, provider_id, id)`,
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
