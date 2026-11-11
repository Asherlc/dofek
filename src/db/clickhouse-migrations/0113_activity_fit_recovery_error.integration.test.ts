import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { clickHouseMigrations } from "./registry.ts";

const columnRowsSchema = z.array(
  z.object({
    name: z.string(),
    type: z.string(),
  }),
);
const activityRowsSchema = z.array(
  z.object({
    id: z.string().uuid(),
    raw: z.string().nullable(),
    fit_recovery_error: z.string().nullable(),
  }),
);

describe("0113_activity_fit_recovery_error migration", () => {
  const database = `activity_fit_recovery_${randomUUID().replaceAll("-", "")}`;
  const clickHouseUrl = process.env.CLICKHOUSE_URL;
  if (!clickHouseUrl) throw new Error("CLICKHOUSE_URL is required");
  const client = createClient({ url: clickHouseUrl });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close();
  });

  it("upgrades an existing activity table without losing rows and applies twice", async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: `CREATE TABLE ${database}.activity (
        id UUID,
        raw Nullable(String)
      ) ENGINE = ReplacingMergeTree ORDER BY id`,
    });

    const existingId = randomUUID();
    const existingRaw = '{"original":"source payload"}';
    await client.insert({
      table: `${database}.activity`,
      format: "JSONEachRow",
      values: [{ id: existingId, raw: existingRaw }],
    });

    const migration = clickHouseMigrations("postgres://test").find(
      ({ id }) => id === "0113_activity_fit_recovery_error",
    );
    if (!migration) throw new Error("Missing activity FIT recovery migration");
    for (const statement of migration.statements) {
      const scopedStatement = statement.replaceAll("postgres_fitness.", `${database}.`);
      await client.command({ query: scopedStatement });
      await client.command({ query: scopedStatement });
    }

    const columnResult = await client.query({
      query: `SELECT name, type
        FROM system.columns
        WHERE database = {database:String}
          AND table = 'activity'
          AND name = 'fit_recovery_error'`,
      query_params: { database },
      format: "JSONEachRow",
    });
    expect(columnRowsSchema.parse(await columnResult.json())).toEqual([
      { name: "fit_recovery_error", type: "Nullable(String)" },
    ]);

    const recoveredId = randomUUID();
    const cleanId = randomUUID();
    await client.insert({
      table: `${database}.activity`,
      format: "JSONEachRow",
      values: [
        { id: recoveredId, raw: existingRaw, fit_recovery_error: "Damaged FIT tail" },
        { id: cleanId, raw: existingRaw, fit_recovery_error: null },
      ],
    });
    const result = await client.query({
      query: `SELECT id, raw, fit_recovery_error FROM ${database}.activity FINAL ORDER BY id`,
      format: "JSONEachRow",
    });
    expect(activityRowsSchema.parse(await result.json())).toEqual(
      expect.arrayContaining([
        { id: existingId, raw: existingRaw, fit_recovery_error: null },
        { id: recoveredId, raw: existingRaw, fit_recovery_error: "Damaged FIT tail" },
        { id: cleanId, raw: existingRaw, fit_recovery_error: null },
      ]),
    );
  });
});
