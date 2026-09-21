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
    source_refresh_ns: z.string(),
    refreshed_ns: z.string().nullable(),
  }),
);

describe("0084_activity_location_source_refresh_default", () => {
  const database = `activity_location_source_refresh_default_${randomUUID().replaceAll("-", "")}`;
  const client = createClickHouseClientFromEnv();

  beforeAll(async () => {
    await client.command({ query: `CREATE DATABASE ${database}` });
  });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close?.();
  });

  it("makes legacy nullable refresh values safe and remains idempotent", async () => {
    const migrations = clickHouseMigrations("postgres://test");
    const addColumnMigration = migrations.find(
      ({ id }) => id === "0083_activity_location_source_refresh",
    );
    const repairDefaultMigration = migrations.find(
      ({ id }) => id === "0084_activity_location_source_refresh_default",
    );
    if (!addColumnMigration?.run) throw new Error("Expected query-capable migration 0083");
    if (!repairDefaultMigration?.run) throw new Error("Expected query-capable migration 0084");

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

    await repairDefaultMigration.run(scopedClient, "postgres://test");
    await client.command({
      query: `CREATE TABLE ${database}.activity_location_sample (
        source_metric_stream_id UUID,
        is_deleted UInt8,
        refreshed_at Nullable(DateTime64(6, 'UTC'))
      ) ENGINE = MergeTree ORDER BY source_metric_stream_id`,
    });
    await client.command({
      query: `INSERT INTO ${database}.activity_location_sample VALUES
        ('00000000-0000-0000-0000-000000000001', 0, '2026-09-09 12:34:56.123456'),
        ('00000000-0000-0000-0000-000000000002', 0, null)`,
    });
    await addColumnMigration.run(scopedClient, "postgres://test");
    await repairDefaultMigration.run(scopedClient, "postgres://test");
    await repairDefaultMigration.run(scopedClient, "postgres://test");

    const result = await client.query({
      query: `SELECT
        toString(toUnixTimestamp64Nano(source_refreshed_at)) AS source_refresh_ns,
        if(refreshed_at IS null, null,
          toString(toUnixTimestamp64Nano(assumeNotNull(refreshed_at)))) AS refreshed_ns
      FROM ${database}.activity_location_sample
      ORDER BY source_metric_stream_id`,
      format: "JSONEachRow",
    });

    expect(resultSchema.parse(await result.json())).toEqual([
      {
        source_refresh_ns: "1788957296123456000",
        refreshed_ns: "1788957296123456000",
      },
      {
        source_refresh_ns: "0",
        refreshed_ns: null,
      },
    ]);
  });
});
