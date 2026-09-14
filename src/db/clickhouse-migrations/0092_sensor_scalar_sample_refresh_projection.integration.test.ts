import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createClickHouseClientFromEnv } from "../clickhouse.ts";
import { createMigration } from "./0092_sensor_scalar_sample_refresh_projection.ts";

const materializedProjectionSchema = z.array(z.object({ rows: z.number(), bytes: z.number() }));
const explainSchema = z.array(z.object({ explain: z.string() }));

describe("0092_sensor_scalar_sample_refresh_projection", () => {
  const database = `sensor_refresh_projection_${randomUUID().replaceAll("-", "")}`;
  const client = createClickHouseClientFromEnv();

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await client.close?.();
  });

  it("materializes an idempotent refresh-ordered projection used by filtered aggregates", async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: `CREATE TABLE ${database}.sensor_scalar_sample (
        id UInt64,
        user_id UInt64,
        scalar Float64,
        _peerdb_synced_at DateTime64(3, 'UTC')
      ) ENGINE = MergeTree ORDER BY (user_id, id)`,
    });
    await client.command({
      query: `INSERT INTO ${database}.sensor_scalar_sample
        SELECT
          number,
          number % 1000,
          toFloat64(number),
          if(
            number % 100 = 0,
            toDateTime64('2026-09-13 12:00:00', 3, 'UTC'),
            toDateTime64('2026-09-01 12:00:00', 3, 'UTC')
          )
        FROM numbers(1000000)`,
    });

    for (const statement of createMigration().statements) {
      const scopedStatement = statement.replaceAll("analytics.", `${database}.`);
      await client.command({ query: scopedStatement });
      await client.command({ query: scopedStatement });
    }

    const projectionResult = await client.query({
      query: `SELECT name, sorting_key
        FROM system.projections
        WHERE database = {database:String}
          AND table = 'sensor_scalar_sample'`,
      query_params: { database },
      format: "JSONEachRow",
    });
    expect(await projectionResult.json()).toEqual([
      {
        name: "by_peerdb_synced_at",
        sorting_key: ["_peerdb_synced_at"],
      },
    ]);

    const materializedResult = await client.query({
      query: `SELECT sum(rows) AS rows, sum(bytes_on_disk) AS bytes
        FROM system.projection_parts
        WHERE database = {database:String}
          AND table = 'sensor_scalar_sample'
          AND name = 'by_peerdb_synced_at'
          AND active`,
      query_params: { database },
      format: "JSONEachRow",
    });
    const materialized = materializedProjectionSchema.parse(await materializedResult.json());
    expect(materialized).toEqual([{ rows: 1000000, bytes: expect.any(Number) }]);
    expect(materialized[0]?.bytes).toBeGreaterThan(0);

    const explainResult = await client.query({
      query: `EXPLAIN indexes = 1
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
