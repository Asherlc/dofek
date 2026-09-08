import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createClickHouseClientFromEnv } from "../clickhouse.ts";
import { createMigration } from "./0077_activity_power_curve_evidence.ts";

const columnSchema = z.array(
  z.object({
    name: z.string(),
    type: z.string(),
  }),
);

describe("0077_activity_power_curve_evidence", () => {
  const database = `power_curve_evidence_${randomUUID().replaceAll("-", "")}`;
  const client = createClickHouseClientFromEnv();

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await client.close?.();
  });

  it("adds the evidence columns idempotently to an existing read-model table", async () => {
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: `CREATE TABLE ${database}.activity_power_curve (
        activity_id UUID,
        user_id UUID,
        duration_seconds Int32,
        best_power Nullable(Int32),
        refresh_version UInt64
      ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, activity_id, duration_seconds)`,
    });

    for (const statement of createMigration().statements) {
      const scopedStatement = statement.replaceAll("analytics.", `${database}.`);
      await client.command({ query: scopedStatement });
      await client.command({ query: scopedStatement });
    }

    const result = await client.query({
      query: `SELECT name, type
        FROM system.columns
        WHERE database = {database:String}
          AND table = 'activity_power_curve'
          AND name IN (
            'start_offset_seconds',
            'observed_samples',
            'median_sample_interval_seconds',
            'largest_gap_seconds',
            'coverage_pct',
            'power_measurement_kind',
            'source_providers',
            'source_devices'
          )
        ORDER BY name`,
      query_params: { database },
      format: "JSONEachRow",
    });

    expect(columnSchema.parse(await result.json())).toEqual([
      { name: "coverage_pct", type: "Nullable(Float64)" },
      { name: "largest_gap_seconds", type: "Nullable(Float64)" },
      { name: "median_sample_interval_seconds", type: "Nullable(Float64)" },
      { name: "observed_samples", type: "Nullable(UInt64)" },
      { name: "power_measurement_kind", type: "Nullable(String)" },
      { name: "source_devices", type: "Array(String)" },
      { name: "source_providers", type: "Array(String)" },
      { name: "start_offset_seconds", type: "Nullable(Float64)" },
    ]);
  });
});
