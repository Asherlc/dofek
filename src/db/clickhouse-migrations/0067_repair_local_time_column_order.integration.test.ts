import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../clickhouse.ts";
import { createMigration } from "./0067_repair_local_time_column_order.ts";

const columnRowsSchema = z.array(z.object({ name: z.string() }));

/**
 * Each scratch table reproduces the production physical layout: the columns in
 * their dbt-model order, but with the record-local time columns appended at the
 * end the way migration 0063's `ADD COLUMN` did. `expectedOrder` is the order
 * the model's final SELECT lists them in — what the repair must restore.
 */
const scratchTables = [
  {
    name: "activity_source_records",
    brokenColumns: [
      "timezone Nullable(String)",
      "raw Nullable(String)",
      "source_synced_at DateTime64(9, 'UTC')",
      "priority Nullable(Int32)",
      "refresh_version UInt64",
      "is_deleted UInt8",
      "refreshed_at DateTime64(9, 'UTC')",
      "start_utc_offset_minutes Nullable(Int16)",
      "end_utc_offset_minutes Nullable(Int16)",
      "local_time_source LowCardinality(String) DEFAULT 'unknown'",
    ],
    orderBy: "refresh_version",
    expectedOrder: [
      "timezone",
      "start_utc_offset_minutes",
      "end_utc_offset_minutes",
      "local_time_source",
      "raw",
      "source_synced_at",
      "priority",
      "refresh_version",
      "is_deleted",
      "refreshed_at",
    ],
  },
  {
    name: "deduped_activities",
    brokenColumns: [
      "timezone Nullable(String)",
      "raw Nullable(String)",
      "source_synced_at DateTime64(9, 'UTC')",
      "refresh_version UInt64",
      "is_deleted UInt8",
      "refreshed_at DateTime64(9, 'UTC')",
      "start_utc_offset_minutes Nullable(Int16)",
      "end_utc_offset_minutes Nullable(Int16)",
      "local_time_source LowCardinality(String) DEFAULT 'unknown'",
    ],
    orderBy: "refresh_version",
    expectedOrder: [
      "timezone",
      "start_utc_offset_minutes",
      "end_utc_offset_minutes",
      "local_time_source",
      "raw",
      "source_synced_at",
      "refresh_version",
      "is_deleted",
      "refreshed_at",
    ],
  },
  {
    name: "daily_sleep",
    brokenColumns: [
      "overlapping_sessions Array(Tuple(session_id UUID)) DEFAULT []",
      "started_at DateTime64(6, 'UTC')",
      "staging_available Nullable(UInt8)",
      "refresh_version UInt64",
      "is_deleted UInt8",
      "refreshed_at DateTime64(9, 'UTC')",
      "timezone Nullable(String)",
      "start_utc_offset_minutes Nullable(Int16)",
      "end_utc_offset_minutes Nullable(Int16)",
      "local_time_source LowCardinality(String) DEFAULT 'unknown'",
    ],
    orderBy: "refresh_version",
    expectedOrder: [
      "overlapping_sessions",
      "timezone",
      "start_utc_offset_minutes",
      "end_utc_offset_minutes",
      "local_time_source",
      "started_at",
      "staging_available",
      "refresh_version",
      "is_deleted",
      "refreshed_at",
    ],
  },
] as const;

describe("0067_repair_local_time_column_order", () => {
  const database = `repair_local_time_${randomUUID().replaceAll("-", "")}`;
  let client: ClickHouseClient;

  beforeAll(async () => {
    client = createClickHouseClientFromEnv();
    await client.command({ query: `CREATE DATABASE ${database}` });
  });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await client.close?.();
  });

  async function physicalColumnOrder(table: string): Promise<string[]> {
    const result = await client.query({
      query: `SELECT name FROM system.columns
        WHERE database = {database:String} AND table = {table:String}
        ORDER BY position`,
      query_params: { database, table },
      format: "JSONEachRow",
    });
    return columnRowsSchema.parse(await result.json()).map((row) => row.name);
  }

  it("restores the model column order on serving tables that appended the columns", async () => {
    for (const table of scratchTables) {
      await client.command({
        query: `CREATE TABLE ${database}.${table.name} (
          ${table.brokenColumns.join(",\n          ")}
        )
        ENGINE = ReplacingMergeTree(refresh_version)
        ORDER BY ${table.orderBy}`,
      });
    }

    for (const statement of createMigration().statements) {
      await client.command({ query: statement.replaceAll("analytics.", `${database}.`) });
    }

    for (const table of scratchTables) {
      expect(await physicalColumnOrder(table.name)).toEqual(table.expectedOrder);
    }
  });

  it("makes the positional dbt insert stop overflowing once the order is repaired", async () => {
    const definition = scratchTables.find((entry) => entry.name === "activity_source_records");
    if (!definition) {
      throw new Error("Missing activity_source_records scratch definition");
    }
    const table = `${database}.activity_source_records`;
    // dbt-clickhouse writes `INSERT INTO <table> (<physical order>) <model SELECT>`.
    // The SELECT always emits columns in the model's order.
    const modelOrderSelect = `SELECT
      CAST('UTC' AS Nullable(String)) AS timezone,
      CAST(30 AS Nullable(Int16)) AS start_utc_offset_minutes,
      CAST(60 AS Nullable(Int16)) AS end_utc_offset_minutes,
      CAST('device_timezone' AS LowCardinality(String)) AS local_time_source,
      CAST('{}' AS Nullable(String)) AS raw,
      CAST(now64(9) AS DateTime64(9, 'UTC')) AS source_synced_at,
      CAST(100 AS Nullable(Int32)) AS priority,
      toUInt64(1) AS refresh_version,
      CAST(0 AS UInt8) AS is_deleted,
      CAST(now64(9) AS DateTime64(9, 'UTC')) AS refreshed_at`;

    // Recreate the appended layout in isolation so the failure is observable
    // before the repair statements run.
    await client.command({ query: `DROP TABLE IF EXISTS ${table}` });
    await client.command({
      query: `CREATE TABLE ${table} (
        ${definition.brokenColumns.join(",\n        ")}
      )
      ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY refresh_version`,
    });
    const appendedOrder = await physicalColumnOrder("activity_source_records");

    await expect(
      client.command({
        query: `INSERT INTO ${table} (${appendedOrder.join(", ")}) ${modelOrderSelect}`,
      }),
    ).rejects.toThrow();

    for (const statement of createMigration().statements.filter((statement) =>
      statement.includes("analytics.activity_source_records"),
    )) {
      await client.command({ query: statement.replaceAll("analytics.", `${database}.`) });
    }

    const repairedOrder = await physicalColumnOrder("activity_source_records");
    expect(repairedOrder).toEqual(definition.expectedOrder);
    expect(repairedOrder).not.toEqual(appendedOrder);

    await client.command({
      query: `INSERT INTO ${table} (${repairedOrder.join(", ")}) ${modelOrderSelect}`,
    });

    const countResult = await client.query({
      query: `SELECT count() AS count FROM ${table}`,
      format: "JSONEachRow",
    });
    expect(z.array(z.object({ count: z.coerce.number() })).parse(await countResult.json())).toEqual(
      [{ count: 1 }],
    );
  });
});
