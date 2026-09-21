import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createClickHouseClientFromEnv } from "../clickhouse.ts";
import { clickHouseMigrations } from "./registry.ts";

const projectionSchema = z.array(
  z.object({
    name: z.string(),
    query: z.string(),
    sorting_key: z.array(z.string()),
  }),
);
const sizeSchema = z.array(z.object({ base_bytes: z.number(), projection_bytes: z.number() }));
const projectionSizeSchema = z.array(z.object({ projection_bytes: z.number() }));
const explainSchema = z.array(z.object({ explain: z.string() }));

describe("0094_sensor_scalar_sample_lightweight_refresh_projection", () => {
  const database = `sensor_lightweight_projection_${randomUUID().replaceAll("-", "")}`;
  const client = createClickHouseClientFromEnv();

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await client.close?.();
  });

  it("replaces the full refresh projection with a mutation-compatible lightweight index", async () => {
    const migration = clickHouseMigrations("postgres://test").find(
      ({ id }) => id === "0094_sensor_scalar_sample_lightweight_refresh_projection",
    );
    expect(migration).toBeDefined();

    await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: `CREATE TABLE ${database}.sensor_scalar_sample (
        id UInt64,
        user_id UInt64,
        scalar Float64,
        version UInt64,
        _peerdb_synced_at DateTime64(3, 'UTC'),
        PROJECTION by_peerdb_synced_at (
          SELECT * ORDER BY _peerdb_synced_at
        )
      ) ENGINE = ReplacingMergeTree(version)
        ORDER BY (user_id, id)
        SETTINGS
          deduplicate_merge_projection_mode = 'rebuild',
          lightweight_mutation_projection_mode = 'rebuild'`,
    });
    await client.command({
      query: `INSERT INTO ${database}.sensor_scalar_sample
        SELECT
          number,
          number % 1000,
          toFloat64(number),
          number,
          if(
            number % 100 = 0,
            toDateTime64('2026-09-13 12:00:00', 3, 'UTC'),
            toDateTime64('2026-09-01 12:00:00', 3, 'UTC')
          )
        FROM numbers(1000000)`,
    });

    const fullProjectionSizeResult = await client.query({
      query: `SELECT sum(bytes_on_disk) AS projection_bytes
        FROM system.projection_parts
        WHERE database = {database:String}
          AND table = 'sensor_scalar_sample'
          AND name = 'by_peerdb_synced_at'
          AND active`,
      query_params: { database },
      format: "JSONEachRow",
    });
    const [fullProjectionSize] = projectionSizeSchema.parse(await fullProjectionSizeResult.json());

    for (const statement of migration?.statements ?? []) {
      await client.command({ query: statement.replaceAll("analytics.", `${database}.`) });
    }

    const projectionResult = await client.query({
      query: `SELECT name, query, sorting_key
        FROM system.projections
        WHERE database = {database:String}
          AND table = 'sensor_scalar_sample'`,
      query_params: { database },
      format: "JSONEachRow",
    });
    expect(projectionSchema.parse(await projectionResult.json())).toEqual([
      {
        name: "by_peerdb_synced_at",
        query: expect.stringContaining("_part_offset"),
        sorting_key: ["_peerdb_synced_at"],
      },
    ]);

    const sizeResult = await client.query({
      query: `SELECT
          (
            SELECT sum(bytes_on_disk)
            FROM system.parts
            WHERE database = {database:String}
              AND table = 'sensor_scalar_sample'
              AND active
          ) AS base_bytes,
          (
            SELECT sum(bytes_on_disk)
            FROM system.projection_parts
            WHERE database = {database:String}
              AND table = 'sensor_scalar_sample'
              AND name = 'by_peerdb_synced_at'
              AND active
          ) AS projection_bytes`,
      query_params: { database },
      format: "JSONEachRow",
    });
    const [sizes] = sizeSchema.parse(await sizeResult.json());
    expect(sizes?.projection_bytes).toBeLessThan(sizes?.base_bytes ?? 0);
    expect(sizes?.projection_bytes).toBeLessThan(fullProjectionSize?.projection_bytes ?? 0);

    await client.command({
      query: `DELETE FROM ${database}.sensor_scalar_sample
        WHERE id = 1
        SETTINGS mutations_sync = 2`,
    });

    const explainResult = await client.query({
      query: `EXPLAIN projections = 1
        SELECT user_id, argMax(scalar, id)
        FROM ${database}.sensor_scalar_sample
        WHERE _peerdb_synced_at >= toDateTime64('2026-09-13 00:00:00', 3, 'UTC')
          AND _peerdb_synced_at < toDateTime64('2026-09-14 00:00:00', 3, 'UTC')
        GROUP BY user_id`,
      format: "JSONEachRow",
    });
    const plan = explainSchema.parse(await explainResult.json());
    expect(plan.map(({ explain }) => explain).join("\n")).toContain("by_peerdb_synced_at");
  });
});
