import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ClickHouseCommandClient } from "../clickhouse.ts";
import { createMigration } from "./0101_activity_end_time_nullability.ts";

describe("activity end time nullability migration", () => {
  const database = `end_time_migration_${randomUUID().replaceAll("-", "")}`;
  const url = process.env.CLICKHOUSE_URL;
  if (!url) throw new Error("CLICKHOUSE_URL is required");
  const client = createClient({ url });
  const mapQuery = (query: string) =>
    query
      .replaceAll("postgres_fitness.", `${database}.`)
      .replaceAll("analytics.", `${database}.`)
      .replaceAll("database = 'analytics'", `database = '${database}'`);
  const scopedClient: ClickHouseCommandClient = {
    command: (options) => client.command({ ...options, query: mapQuery(options.query) }),
    query: async <TRow extends object>(
      options: Parameters<NonNullable<ClickHouseCommandClient["query"]>>[0],
    ) => {
      const result = await client.query({ ...options, query: mapQuery(options.query) });
      return { json: () => result.json<TRow>() };
    },
  };
  async function applyMigration() {
    const migration = createMigration();
    if (migration.run) await migration.run(scopedClient, "postgres://test");
    else for (const query of migration.statements) await scopedClient.command({ query });
  }
  beforeAll(async () => {
    await client.command({ query: `CREATE DATABASE ${database}` });
  });
  beforeEach(async () => {
    await client.command({ query: `DROP TABLE IF EXISTS ${database}.activity SYNC` });
    await client.command({ query: `DROP TABLE IF EXISTS ${database}.deduped_activities SYNC` });
    await client.command({
      query: `CREATE TABLE ${database}.activity (
      id UUID, ended_at DateTime64(6, 'UTC')
    ) ENGINE = MergeTree ORDER BY id`,
    });
  });
  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close();
  });

  it("preserves source NULLs before dbt creates the deduplicated table", async () => {
    await applyMigration();
    await client.insert({
      table: `${database}.activity`,
      format: "JSONEachRow",
      values: [{ id: randomUUID(), ended_at: null }],
    });
    const result = await client.query({
      query: `SELECT ended_at FROM ${database}.activity`,
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([{ ended_at: null }]);
  });

  it("alters an existing deduplicated table without rewriting historical end values", async () => {
    await client.command({
      query: `CREATE TABLE ${database}.deduped_activities (
      id UUID, ended_at DateTime64(6, 'UTC')
    ) ENGINE = MergeTree ORDER BY id`,
    });
    const id = randomUUID();
    await client.insert({
      table: `${database}.deduped_activities`,
      format: "JSONEachRow",
      values: [{ id, ended_at: "1970-01-01 00:00:00" }],
    });
    await applyMigration();
    await applyMigration();
    await client.insert({
      table: `${database}.deduped_activities`,
      format: "JSONEachRow",
      values: [{ id: randomUUID(), ended_at: null }],
    });
    const result = await client.query({
      query: `SELECT ended_at FROM ${database}.deduped_activities ORDER BY ended_at NULLS FIRST`,
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([
      { ended_at: null },
      { ended_at: "1970-01-01 00:00:00.000000" },
    ]);
  });
});
