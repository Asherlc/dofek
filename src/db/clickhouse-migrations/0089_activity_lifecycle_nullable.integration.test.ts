import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createClickHouseClientFromEnv } from "../clickhouse.ts";
import { clickHouseMigrations } from "./registry.ts";

const columnRowsSchema = z.array(
  z.object({
    name: z.string(),
    type: z.string(),
  }),
);

describe("0089_activity_lifecycle_nullable migration", () => {
  const database = `activity_lifecycle_nullable_${randomUUID().replaceAll("-", "")}`;
  const client = createClickHouseClientFromEnv();

  beforeAll(async () => {
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: `CREATE TABLE ${database}.activity (
        id UUID,
        provider_absent_at DateTime64(6, 'UTC'),
        deleted_at DateTime64(6, 'UTC')
      ) ENGINE = ReplacingMergeTree ORDER BY id`,
    });
  });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await client.close?.();
  });

  it("preserves null lifecycle timestamps from the PeerDB activity mirror", async () => {
    const migration = clickHouseMigrations("postgres://unused").find(
      (candidate) => candidate.id === "0089_activity_lifecycle_nullable",
    );

    expect(migration).toBeDefined();
    if (!migration) return;

    for (const statement of migration.statements) {
      await client.command({
        query: statement.replaceAll("postgres_fitness.", `${database}.`),
      });
    }

    const result = await client.query({
      query: `SELECT name, type
        FROM system.columns
        WHERE database = {database:String}
          AND table = 'activity'
          AND name IN ('provider_absent_at', 'deleted_at')
        ORDER BY name`,
      query_params: { database },
      format: "JSONEachRow",
    });

    expect(columnRowsSchema.parse(await result.json())).toEqual([
      { name: "deleted_at", type: "Nullable(DateTime64(6, 'UTC'))" },
      { name: "provider_absent_at", type: "Nullable(DateTime64(6, 'UTC'))" },
    ]);
  });
});
