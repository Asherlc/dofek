import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClickHouseClientFromEnv } from "../clickhouse.ts";
import { buildPostgresFitnessRawTableStatements } from "../clickhouse-raw-tables.ts";
import { createMigration } from "./0091_refresh_daily_metrics_view.ts";

describe("0091_refresh_daily_metrics_view migration", () => {
  const database = `refresh_daily_metrics_view_${randomUUID().replaceAll("-", "")}`;
  const client = createClickHouseClientFromEnv();

  const runIsolated = async (statement: string): Promise<void> => {
    await client.command({
      query: statement
        .replaceAll("analytics.", `${database}.`)
        .replaceAll("postgres_fitness.", `${database}.`),
    });
  };

  beforeAll(async () => {
    await client.command({ query: `CREATE DATABASE ${database}` });
    for (const statement of buildPostgresFitnessRawTableStatements().filter(
      (candidate) =>
        candidate.includes("postgres_fitness.daily_metrics") ||
        candidate.includes("postgres_fitness.provider_priority") ||
        candidate.includes("postgres_fitness.device_priority"),
    )) {
      await runIsolated(statement);
    }
    await client.command({
      query: `ALTER TABLE ${database}.daily_metrics ADD COLUMN active_energy_kcal Nullable(Float32)`,
    });
    await client.command({
      query: `CREATE VIEW ${database}.v_daily_metrics AS
        SELECT active_energy_kcal FROM ${database}.daily_metrics`,
    });
    await client.command({
      query: `ALTER TABLE ${database}.daily_metrics DROP COLUMN active_energy_kcal`,
    });
  });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await client.close?.();
  });

  it("replaces the stale view so reads do not reference removed energy columns", async () => {
    for (const statement of createMigration().statements) await runIsolated(statement);

    await expect(
      client.query({ query: `SELECT * FROM ${database}.v_daily_metrics`, format: "JSONEachRow" }),
    ).resolves.toBeDefined();
  });
});
