import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createClickHouseClientFromEnv } from "../clickhouse.ts";
import { createMigration } from "./0095_food_entry_source_account_key.ts";

const columnRowsSchema = z.array(
  z.object({
    name: z.string(),
    type: z.string(),
  }),
);

describe("0095_food_entry_source_account_key migration", () => {
  const database = `food_entry_source_account_${randomUUID().replaceAll("-", "")}`;
  const client = createClickHouseClientFromEnv();

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await client.close?.();
  });

  it("adds the nullable destination column idempotently", async () => {
    await client.command({ query: `CREATE DATABASE IF NOT EXISTS ${database}` });
    await client.command({
      query: `CREATE TABLE ${database}.food_entry (id UInt8) ENGINE = MergeTree ORDER BY id`,
    });

    for (const statement of createMigration().statements) {
      const scopedStatement = statement.replaceAll("postgres_fitness.", `${database}.`);
      await client.command({ query: scopedStatement });
      await client.command({ query: scopedStatement });
    }

    const result = await client.query({
      query: `SELECT name, type
        FROM system.columns
        WHERE database = {database:String}
          AND table = 'food_entry'
          AND name = 'source_account_key'`,
      query_params: { database },
      format: "JSONEachRow",
    });

    expect(columnRowsSchema.parse(await result.json())).toEqual([
      { name: "source_account_key", type: "Nullable(String)" },
    ]);
  });
});
