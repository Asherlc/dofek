import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildIngestMetricStreamCreateTableSql } from "../../metric-stream/clickhouse-table.ts";
import { createClickHouseClientFromEnv } from "../clickhouse.ts";
import { clickHouseMigrations } from "./registry.ts";

describe("0098_heart_rate_source_access", () => {
  const database = `heart_rate_migration_${randomUUID().replaceAll("-", "")}`;
  const client = createClickHouseClientFromEnv();
  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await client.close?.();
  });
  it("adds a schema-only idempotent projection while preserving raw replacement settings", async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await client.command({ query: `CREATE DATABASE ${database}` });
    const table = `${database}.metric_stream`;
    await client.command({
      query: buildIngestMetricStreamCreateTableSql().replaceAll("ingest.metric_stream", table),
    });
    await client.command({
      query: `ALTER TABLE ${table} DROP PROJECTION IF EXISTS by_user_channel_recorded_at`,
    });
    await client.command({
      query: `INSERT INTO ${table} (id, user_id, channel, recorded_at, scalar) VALUES ('${randomUUID()}', '${randomUUID()}', 'heart_rate', '2026-04-12 10:00:00', 60)`,
    });
    const migration = clickHouseMigrations("postgres://test").find(
      ({ id }) => id === "0098_heart_rate_source_access",
    );
    expect(migration).toBeDefined();
    if (!migration) throw new Error("Missing heart-rate access migration");
    for (let attempt = 0; attempt < 2; attempt++)
      for (const statement of migration.statements)
        await client.command({ query: statement.replaceAll("ingest.metric_stream", table) });
    const projections = await client.query({
      query: `SELECT name, sorting_key FROM system.projections WHERE database = {database:String} AND table = 'metric_stream' AND name = 'by_user_channel_recorded_at'`,
      query_params: { database },
      format: "JSONEachRow",
    });
    expect(
      z
        .array(z.object({ name: z.string(), sorting_key: z.array(z.string()) }))
        .parse(await projections.json()),
    ).toEqual([
      {
        name: "by_user_channel_recorded_at",
        sorting_key: ["user_id", "channel", "recorded_at", "activity_id", "id"],
      },
    ]);
    const countParts = async () => {
      const result = await client.query({
        query: `SELECT count() AS count FROM system.projection_parts WHERE database = {database:String} AND table = 'metric_stream' AND name = 'by_user_channel_recorded_at' AND active`,
        query_params: { database },
        format: "JSONEachRow",
      });
      return z.array(z.object({ count: z.coerce.number() })).parse(await result.json())[0]?.count;
    };
    expect(await countParts()).toBe(0);
    await client.command({
      query: `ALTER TABLE ${table} MATERIALIZE PROJECTION by_user_channel_recorded_at SETTINGS mutations_sync = 2`,
    });
    expect(await countParts()).toBe(1);
    const settings = await client.query({
      query: `SHOW CREATE TABLE ${table}`,
      format: "JSONEachRow",
    });
    const ddl = z
      .array(z.object({ statement: z.string() }))
      .parse(await settings.json())[0]?.statement;
    expect(ddl).toContain("ReplacingMergeTree(version)");
    expect(ddl).toContain("ORDER BY (user_id, activity_id, channel, recorded_at, id)");
    expect(ddl).toContain("deduplicate_merge_projection_mode = 'rebuild'");
  });
});
