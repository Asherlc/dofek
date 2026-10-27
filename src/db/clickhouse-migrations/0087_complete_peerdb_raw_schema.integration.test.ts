import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createClickHouseClientFromEnv } from "../clickhouse.ts";
import { createMigration } from "./0087_complete_peerdb_raw_schema.ts";

const columnRowsSchema = z.array(
  z.object({
    name: z.string(),
    table: z.string(),
    type: z.string(),
  }),
);

describe("0087_complete_peerdb_raw_schema migration", () => {
  const database = `complete_peerdb_raw_schema_${randomUUID().replaceAll("-", "")}`;
  const client = createClickHouseClientFromEnv();

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await client.close?.();
  });

  it("adds every required destination column idempotently", async () => {
    await client.command({ query: `CREATE DATABASE IF NOT EXISTS ${database}` });
    for (const table of ["food_entry", "health_event"]) {
      await client.command({
        query: `CREATE TABLE IF NOT EXISTS ${database}.${table} (id UInt8) ENGINE = MergeTree ORDER BY id`,
      });
    }

    for (const statement of createMigration().statements) {
      const scopedStatement = statement.replaceAll("postgres_fitness.", `${database}.`);
      await client.command({ query: scopedStatement });
      await client.command({ query: scopedStatement });
    }

    const result = await client.query({
      query: `SELECT table, name, type
        FROM system.columns
        WHERE database = {database:String}
          AND name != 'id'
        ORDER BY table, name`,
      query_params: { database },
      format: "JSONEachRow",
    });

    expect(columnRowsSchema.parse(await result.json())).toEqual([
      { name: "nutrition_grain", table: "food_entry", type: "Nullable(String)" },
      { name: "metadata", table: "health_event", type: "Nullable(String)" },
      { name: "source_bundle", table: "health_event", type: "Nullable(String)" },
    ]);
  });
});
