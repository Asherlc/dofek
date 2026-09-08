import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createClickHouseClientFromEnv } from "../clickhouse.ts";
import { createMigration } from "./0078_sensor_provider_priority_type.ts";

const columnSchema = z.array(
  z.object({
    table: z.string(),
    type: z.string(),
  }),
);

describe("0078_sensor_provider_priority_type", () => {
  const database = `sensor_priority_type_${randomUUID().replaceAll("-", "")}`;
  const client = createClickHouseClientFromEnv();

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await client.close?.();
  });

  it("converts both existing sensor targets to Int32 idempotently", async () => {
    await client.command({ query: `CREATE DATABASE ${database}` });
    for (const table of ["sensor_scalar_sample", "deduped_sensor"]) {
      await client.command({
        query: `CREATE TABLE ${database}.${table} (
          id UInt8,
          provider_priority UInt16
        ) ENGINE = MergeTree ORDER BY id`,
      });
      await client.command({
        query: `INSERT INTO ${database}.${table} VALUES (1, 1000)`,
      });
    }

    for (const statement of createMigration().statements) {
      const scopedStatement = statement.replaceAll("analytics.", `${database}.`);
      await client.command({ query: scopedStatement });
      await client.command({ query: scopedStatement });
    }

    const result = await client.query({
      query: `SELECT table, type
        FROM system.columns
        WHERE database = {database:String}
          AND name = 'provider_priority'
        ORDER BY table`,
      query_params: { database },
      format: "JSONEachRow",
    });

    expect(columnSchema.parse(await result.json())).toEqual([
      { table: "deduped_sensor", type: "Int32" },
      { table: "sensor_scalar_sample", type: "Int32" },
    ]);
  });
});
