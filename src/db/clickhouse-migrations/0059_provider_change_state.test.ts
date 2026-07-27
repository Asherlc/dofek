import { describe, expect, it } from "vitest";
import { createMigration } from "./0059_provider_change_state.ts";

describe("0059_provider_change_state", () => {
  it("captures each provider-bearing source at insert time", () => {
    const migration = createMigration();
    const sql = migration.statements.join("\n");

    expect(migration.id).toBe("0059_provider_change_state");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS analytics.provider_change_state");
    for (const source of [
      "postgres_fitness.provider",
      "postgres_fitness.provider_connection",
      "postgres_fitness.activity",
      "postgres_fitness.daily_metrics",
      "postgres_fitness.sleep_session",
      "ingest.metric_stream",
      "analytics.body_measurement_sample",
      "postgres_fitness.food_entry",
      "postgres_fitness.health_event",
      "postgres_fitness.lab_panel",
      "postgres_fitness.lab_result",
      "postgres_fitness.journal_entry",
    ]) {
      expect(sql).toContain(`FROM ${source}`);
    }
    expect(sql.match(/CREATE MATERIALIZED VIEW IF NOT EXISTS/g)).toHaveLength(12);
    expect(sql.match(/max\(now64\(9\)\) AS changed_at/g)).toHaveLength(12);
    expect(sql).not.toContain("max(ingested_at)");
    expect(sql).not.toContain("max(_peerdb_synced_at)");
  });

  it("bootstraps only the bounded provider catalogs", () => {
    const migration = createMigration();
    const bootstrapSql = migration.statements
      .filter((statement) => statement.startsWith("INSERT INTO analytics.provider_change_state"))
      .join("\n");

    expect(bootstrapSql).toContain("FROM postgres_fitness.provider FINAL");
    expect(bootstrapSql).toContain("FROM postgres_fitness.provider_connection FINAL");
    expect(bootstrapSql.match(/now64\(9\) AS changed_at/g)).toHaveLength(2);
    expect(bootstrapSql).not.toContain("max(_peerdb_synced_at)");
    expect(bootstrapSql).not.toContain("metric_stream");
    expect(bootstrapSql).not.toContain("postgres_fitness.activity");
  });
});
