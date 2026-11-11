import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildPostgresFitnessActivityRawTableStatement } from "./clickhouse-raw-tables.ts";

const activityRowsSchema = z.array(
  z.object({
    id: z.string().uuid(),
    fit_recovery_error: z.string().nullable(),
  }),
);

describe("Postgres fitness activity raw table", () => {
  const database = `activity_raw_recovery_${randomUUID().replaceAll("-", "")}`;
  const clickHouseUrl = process.env.CLICKHOUSE_URL;
  if (!clickHouseUrl) throw new Error("CLICKHOUSE_URL is required");
  const client = createClient({ url: clickHouseUrl });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close();
  });

  it("accepts recovered and clean FIT recovery states on a fresh table", async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.command({ query: `CREATE DATABASE ${database}` });
    const table = `${database}.activity`;
    await client.command({
      query: buildPostgresFitnessActivityRawTableStatement({ tableName: table }),
    });

    const columnResult = await client.query({
      query: `SELECT name, type FROM system.columns
        WHERE database = {database:String}
          AND table = 'activity'
          AND name = 'fit_recovery_error'`,
      query_params: { database },
      format: "JSONEachRow",
    });
    expect(
      z.array(z.object({ name: z.string(), type: z.string() })).parse(await columnResult.json()),
    ).toEqual([{ name: "fit_recovery_error", type: "Nullable(String)" }]);

    const recoveredId = randomUUID();
    const cleanId = randomUUID();
    await client.insert({
      table,
      format: "JSONEachRow",
      values: [
        {
          id: recoveredId,
          provider_id: "wahoo",
          user_id: randomUUID(),
          canonical_type: "running",
          provider_type: "run",
          started_at: "2026-11-11 12:00:00",
          raw: '{"source":"fit"}',
          fit_recovery_error: "Malformed final FIT record",
          created_at: "2026-11-11 12:00:00",
        },
        {
          id: cleanId,
          provider_id: "wahoo",
          user_id: randomUUID(),
          canonical_type: "running",
          provider_type: "run",
          started_at: "2026-11-11 13:00:00",
          raw: '{"source":"fit"}',
          fit_recovery_error: null,
          created_at: "2026-11-11 13:00:00",
        },
      ],
    });

    const result = await client.query({
      query: `SELECT id, fit_recovery_error FROM ${table} FINAL ORDER BY id`,
      format: "JSONEachRow",
    });

    expect(activityRowsSchema.parse(await result.json())).toEqual(
      expect.arrayContaining([
        { id: recoveredId, fit_recovery_error: "Malformed final FIT record" },
        { id: cleanId, fit_recovery_error: null },
      ]),
    );
  });
});
