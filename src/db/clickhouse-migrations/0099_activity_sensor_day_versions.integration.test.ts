import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ClickHouseCommandClient } from "../clickhouse.ts";
import { clickHouseMigrations } from "./registry.ts";

describe("0099 activity sensor day versions migration", () => {
  const database = `activity_day_migration_${randomUUID().replaceAll("-", "")}`;
  const url = process.env.CLICKHOUSE_URL;
  if (!url) throw new Error("CLICKHOUSE_URL is required");
  const client = createClient({ url });
  const migration = clickHouseMigrations("postgres://test").find(
    ({ id }) => id === "0099_activity_sensor_day_versions",
  );
  async function applyMigration() {
    if (!migration) throw new Error("Missing activity day migration");
    for (const query of migration.statements)
      await client.command({
        query: query.replaceAll("analytics.deduped_sensor", `${database}.deduped_sensor`),
      });
  }
  async function insertSensor(deleted = 0) {
    await client.command({
      query: `INSERT INTO ${database}.deduped_sensor SELECT toUUID('00000000-0000-4000-8000-000000000001'), 'heart_rate', toDate('2026-09-01'), toDateTime64('2026-09-01 12:00:00', 6, 'UTC'), toUInt64(toUnixTimestamp64Nano(now64(9))), ${deleted}`,
    });
  }
  beforeAll(async () => {
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: `CREATE TABLE ${database}.deduped_sensor (user_id UUID, channel String, recorded_date Date, recorded_at DateTime64(6, 'UTC'), refresh_version UInt64, is_deleted UInt8) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, channel, recorded_date, recorded_at)`,
    });
  });
  beforeEach(async () => {
    await client.command({ query: `TRUNCATE TABLE ${database}.deduped_sensor` });
  });
  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close();
  });

  it("does not require dbt to have created the sensor table yet", async () => {
    if (!migration?.run) throw new Error("Missing query-aware activity day migration");
    const emptyDatabase = `${database}_empty`;
    await client.command({ query: `CREATE DATABASE ${emptyDatabase}` });
    try {
      const scopedClient: ClickHouseCommandClient = {
        command: (options) =>
          client.command({
            ...options,
            query: options.query.replaceAll(
              "analytics.deduped_sensor",
              `${emptyDatabase}.deduped_sensor`,
            ),
          }),
        query: async <TRow extends object>(
          options: Parameters<NonNullable<ClickHouseCommandClient["query"]>>[0],
        ) => {
          const result = await client.query({
            ...options,
            query: options.query.replaceAll(
              "database = 'analytics'",
              `database = '${emptyDatabase}'`,
            ),
          });
          return { json: () => result.json<TRow>() };
        },
      };
      await migration.run(scopedClient, "postgres://test");
      const tables = await client.query({
        query: `SELECT name FROM system.tables WHERE database = '${emptyDatabase}'`,
        format: "JSONEachRow",
      });
      expect(await tables.json()).toEqual([]);
    } finally {
      await client.command({ query: `DROP DATABASE IF EXISTS ${emptyDatabase} SYNC` });
    }
  });
  it("installs the compact index without rebuilding historical parts and preserves replacement", async () => {
    await client.command({
      query: `ALTER TABLE ${database}.deduped_sensor DROP PROJECTION IF EXISTS by_user_channel_day_refresh`,
    });
    await insertSensor();
    await applyMigration();
    const projection = await client.query({
      query: `SELECT name FROM system.projections
      WHERE database = '${database}' AND table = 'deduped_sensor'`,
      format: "JSONEachRow",
    });
    expect(await projection.json()).toContainEqual({ name: "by_user_channel_day_refresh" });
    const parts = await client.query({
      query: `SELECT count() AS count FROM system.projection_parts
      WHERE database = '${database}' AND table = 'deduped_sensor' AND active`,
      format: "JSONEachRow",
    });
    expect(await parts.json()).toEqual([{ count: 0 }]);
    await applyMigration();
    await client.command({
      query: `ALTER TABLE ${database}.deduped_sensor
      MATERIALIZE PROJECTION by_user_channel_day_refresh SETTINGS mutations_sync = 2`,
    });
    await insertSensor(1);
    const before = await client.query({
      query: `SELECT toString(max(refresh_version)) AS version
      FROM ${database}.deduped_sensor`,
      format: "JSONEachRow",
    });
    await client.command({ query: `OPTIMIZE TABLE ${database}.deduped_sensor FINAL` });
    const after = await client.query({
      query: `SELECT toString(max(refresh_version)) AS version,
      count() AS count, max(is_deleted) AS deleted FROM ${database}.deduped_sensor`,
      format: "JSONEachRow",
    });
    const expected = z.array(z.object({ version: z.string() })).parse(await before.json())[0];
    expect(await after.json()).toEqual([{ version: expected?.version, count: 1, deleted: 1 }]);
    const ddl = await client.query({
      query: `SHOW CREATE TABLE ${database}.deduped_sensor`,
      format: "JSONEachRow",
    });
    const statement = z
      .array(z.object({ statement: z.string() }))
      .parse(await ddl.json())[0]?.statement;
    expect(statement).toContain("ReplacingMergeTree(refresh_version)");
    expect(statement).toContain("deduplicate_merge_projection_mode = 'rebuild'");
    expect(statement).toContain("lightweight_mutation_projection_mode = 'rebuild'");
  });
});
