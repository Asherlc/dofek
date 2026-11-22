import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClickHouseClientFromEnv } from "./clickhouse.ts";
import { buildPostgresFitnessRawTableStatements } from "./clickhouse-raw-tables.ts";
import { buildDailyMetricsReadModelRefreshStatements } from "./clickhouse-read-models.ts";

describe("analytics.v_daily_metrics catalog-only parents", () => {
  const database = `daily_metrics_catalog_parents_${randomUUID().replaceAll("-", "")}`;
  const client = createClickHouseClientFromEnv();
  const userId = randomUUID();

  const isolate = (statement: string) =>
    statement
      .replaceAll("analytics.", `${database}.`)
      .replaceAll("postgres_fitness.", `${database}.`);

  beforeAll(async () => {
    await client.command({ query: `CREATE DATABASE ${database}` });
    for (const statement of buildPostgresFitnessRawTableStatements().filter(
      (candidate) =>
        candidate.includes("postgres_fitness.daily_metrics") ||
        candidate.includes("postgres_fitness.provider_priority") ||
        candidate.includes("postgres_fitness.device_priority"),
    )) {
      await client.command({ query: isolate(statement) });
    }
    // 2026-03-01: a native steps row plus a catalog-only parent (every projected column NULL).
    // 2026-03-02: a catalog-only parent alone.
    await client.command({
      query: `INSERT INTO ${database}.daily_metrics (id, date, provider_id, user_id, steps, created_at) VALUES
        ('${randomUUID()}', '2026-03-01', 'apple_health', '${userId}', 4000, now()),
        ('${randomUUID()}', '2026-03-01', 'intervals.icu', '${userId}', NULL, now()),
        ('${randomUUID()}', '2026-03-02', 'intervals.icu', '${userId}', NULL, now())`,
    });
    for (const statement of buildDailyMetricsReadModelRefreshStatements()) {
      await client.command({ query: isolate(statement) });
    }
  });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await client.close?.();
  });

  it("keeps catalog-only parents out of dates and source providers", async () => {
    const result = await client.query({
      query: `SELECT toString(date) AS date, steps, source_providers FROM ${database}.v_daily_metrics ORDER BY date`,
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([
      { date: "2026-03-01", steps: 4000, source_providers: ["apple_health"] },
    ]);
  });
});
