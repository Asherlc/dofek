import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ClickHouseClient,
  type ClickHouseCommandClient,
  createClickHouseClientFromEnv,
} from "../clickhouse.ts";
import { clickHouseMigrations } from "./registry.ts";

const resultSchema = z.array(
  z.object({
    column_type: z.string(),
    column_position: z.union([z.number(), z.string()]).transform(Number),
    source_refresh_ns: z.string(),
    refreshed_ns: z.string(),
    reconciled_refresh_ns: z.string(),
  }),
);

describe("0083_activity_location_source_refresh", () => {
  const database = `activity_location_source_refresh_${randomUUID().replaceAll("-", "")}`;
  const client = createClickHouseClientFromEnv();

  beforeAll(async () => {
    await client.command({ query: `CREATE DATABASE ${database}` });
  });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close?.();
  });

  it("handles an absent target and upgrades legacy location rows idempotently", async () => {
    const migration = clickHouseMigrations("postgres://test").find(
      ({ id }) => id === "0083_activity_location_source_refresh",
    );
    if (!migration?.run) throw new Error("Expected registered query-capable migration 0083");

    const scope = (query: string) =>
      query
        .replaceAll("analytics.", `${database}.`)
        .replaceAll("database = 'analytics'", `database = '${database}'`);
    const scopedClient: ClickHouseCommandClient = {
      command: (options: Parameters<typeof client.command>[0]) =>
        client.command({ ...options, query: scope(options.query) }),
      query: <TRow extends object>(options: Parameters<ClickHouseClient["query"]>[0]) =>
        client.query<TRow>({ ...options, query: scope(options.query) }),
    };

    await migration.run(scopedClient, "postgres://test");
    await client.command({
      query: `CREATE TABLE ${database}.activity_location_sample (
        source_metric_stream_id UUID,
        is_deleted UInt8,
        refreshed_at DateTime64(9, 'UTC')
      ) ENGINE = MergeTree ORDER BY source_metric_stream_id`,
    });
    await client.command({
      query: `INSERT INTO ${database}.activity_location_sample VALUES
        ('00000000-0000-0000-0000-000000000001', 0, '2026-09-09 12:34:56.123456789')`,
    });
    await migration.run(scopedClient, "postgres://test");
    await migration.run(scopedClient, "postgres://test");

    const result = await client.query({
      query: `SELECT
        (SELECT type FROM system.columns
          WHERE database = {database:String}
            AND table = 'activity_location_sample'
            AND name = 'source_refreshed_at') AS column_type,
        (SELECT position FROM system.columns
          WHERE database = {database:String}
            AND table = 'activity_location_sample'
            AND name = 'source_refreshed_at') AS column_position,
        toString(toUnixTimestamp64Nano(source_refreshed_at)) AS source_refresh_ns,
        toString(toUnixTimestamp64Nano(refreshed_at)) AS refreshed_ns,
        toString(toUnixTimestamp64Nano(greatest(source_refreshed_at, refreshed_at)))
          AS reconciled_refresh_ns
      FROM ${database}.activity_location_sample`,
      query_params: { database },
      format: "JSONEachRow",
    });
    const rows = resultSchema.parse(await result.json());

    expect(rows).toEqual([
      {
        column_type: "DateTime64(9, 'UTC')",
        column_position: 3,
        source_refresh_ns: "1788957296123456789",
        refreshed_ns: "1788957296123456789",
        reconciled_refresh_ns: "1788957296123456789",
      },
    ]);
  });
});
