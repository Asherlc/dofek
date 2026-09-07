import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMigration } from "./0076_stable_activity_group_id.ts";

describe("stable activity group column migration", () => {
  const database = `activity_group_migration_${randomUUID().replaceAll("-", "")}`;
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    const url = process.env.CLICKHOUSE_URL;
    if (!url) throw new Error("CLICKHOUSE_URL is required");
    client = createClient({ url });
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: `CREATE TABLE ${database}.activity (id UUID) ENGINE = MergeTree ORDER BY id`,
    });
  });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close();
  });

  it("handles fresh and existing dbt tables and preserves explicitly supplied UUIDs", async () => {
    const applyMigration = async () => {
      const run = createMigration().run;
      if (!run) throw new Error("Migration must handle absent dbt tables");
      const scope = (query: string) =>
        query
          .replaceAll("postgres_fitness.", `${database}.`)
          .replaceAll("analytics.", `${database}.`)
          .replaceAll("database = 'analytics'", `database = '${database}'`);
      await run(
        {
          command: async (options) => {
            await client.command({ ...options, query: scope(options.query) });
          },
          query: (options) => client.query({ ...options, query: scope(options.query) }),
        },
        "postgres://test",
      );
    };
    await applyMigration();
    await client.command({
      query: `CREATE TABLE ${database}.activity_source_records
      (activity_id UUID, provider_id String) ENGINE = MergeTree ORDER BY activity_id`,
    });
    await applyMigration();
    await applyMigration();
    const id = "00000000-0000-0000-0000-000000000101";
    const group = "00000000-0000-0000-0000-000000000901";
    await client.command({
      query: `INSERT INTO ${database}.activity VALUES ('${id}', '${group}')`,
    });
    await client.command({
      query: `INSERT INTO ${database}.activity_source_records
      SELECT id, group_id, 'whoop' FROM ${database}.activity`,
    });
    const result = await client.query({
      query: `SELECT toString(group_id) AS groupId FROM ${database}.activity_source_records`,
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([{ groupId: group }]);
  });
});
