import { describe, expect, it } from "vitest";
import { createMigration } from "./0059_provider_change_state.ts";

describe("0059_provider_change_state", () => {
  it("captures each provider-bearing source at insert time", () => {
    const migration = createMigration();
    const sql = migration.statements.join("\n");
    const sources = [
      {
        providerIdColumn: "id",
        sourceTable: "postgres_fitness.provider",
        viewName: "provider",
      },
      {
        providerIdColumn: "provider_id",
        sourceTable: "postgres_fitness.provider_connection",
        viewName: "provider_connection",
      },
      {
        providerIdColumn: "provider_id",
        sourceTable: "postgres_fitness.activity",
        viewName: "activity",
      },
      {
        providerIdColumn: "provider_id",
        sourceTable: "postgres_fitness.daily_metrics",
        viewName: "daily_metrics",
      },
      {
        providerIdColumn: "provider_id",
        sourceTable: "postgres_fitness.sleep_session",
        viewName: "sleep_session",
      },
      {
        providerIdColumn: "provider_id",
        sourceTable: "ingest.metric_stream",
        viewName: "metric_stream",
      },
      {
        providerIdColumn: "provider_id",
        sourceTable: "analytics.body_measurement_sample",
        viewName: "body_measurement_sample",
      },
      {
        providerIdColumn: "provider_id",
        sourceTable: "postgres_fitness.food_entry",
        viewName: "food_entry",
      },
      {
        providerIdColumn: "provider_id",
        sourceTable: "postgres_fitness.health_event",
        viewName: "health_event",
      },
      {
        providerIdColumn: "provider_id",
        sourceTable: "postgres_fitness.lab_panel",
        viewName: "lab_panel",
      },
      {
        providerIdColumn: "provider_id",
        sourceTable: "postgres_fitness.lab_result",
        viewName: "lab_result",
      },
      {
        providerIdColumn: "provider_id",
        sourceTable: "postgres_fitness.journal_entry",
        viewName: "journal_entry",
      },
    ] as const;

    expect(migration.id).toBe("0059_provider_change_state");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS analytics.provider_change_state");
    for (const [index, source] of sources.entries()) {
      const statement = migration.statements[index + 1];

      expect(statement).toContain(
        `CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.provider_change_from_${source.viewName}`,
      );
      expect(statement).toContain(`FROM ${source.sourceTable}`);
      expect(statement).toContain(`${source.providerIdColumn} AS provider_id`);
      if (source.sourceTable === "postgres_fitness.provider") {
        expect(statement).toContain("assumeNotNull(user_id) AS user_id");
        expect(statement).toContain("WHERE user_id IS NOT NULL");
      } else {
        expect(statement).toContain("user_id AS user_id");
        expect(statement).not.toContain("assumeNotNull(user_id)");
        expect(statement).not.toContain("WHERE user_id IS NOT NULL");
      }
    }
    expect(sql.match(/CREATE MATERIALIZED VIEW IF NOT EXISTS/g)).toHaveLength(12);
    expect(sql.match(/max\(now64\(9\)\) AS changed_at/g)).toHaveLength(12);
    expect(sql).not.toContain("max(ingested_at)");
    expect(sql).not.toContain("max(_peerdb_synced_at)");
  });

  it("bootstraps only the bounded provider catalogs", () => {
    const migration = createMigration();
    const bootstrapStatements = migration.statements.filter((statement) =>
      statement.startsWith("INSERT INTO analytics.provider_change_state"),
    );
    const bootstrapSql = bootstrapStatements.join("\n");
    const providerBootstrap = bootstrapStatements[0];
    const connectionBootstrap = bootstrapStatements[1];

    expect(providerBootstrap).toContain("assumeNotNull(user_id) AS user_id");
    expect(providerBootstrap).toContain("id AS provider_id");
    expect(providerBootstrap).toContain("FROM postgres_fitness.provider FINAL");
    expect(providerBootstrap).toContain("WHERE user_id IS NOT NULL");
    expect(connectionBootstrap).toContain("user_id AS user_id");
    expect(connectionBootstrap).toContain("provider_id AS provider_id");
    expect(connectionBootstrap).toContain("FROM postgres_fitness.provider_connection FINAL");
    expect(connectionBootstrap).not.toContain("assumeNotNull(user_id)");
    expect(connectionBootstrap).not.toContain("WHERE user_id IS NOT NULL");
    expect(bootstrapSql.match(/now64\(9\) AS changed_at/g)).toHaveLength(2);
    expect(bootstrapSql).not.toContain("max(_peerdb_synced_at)");
    expect(bootstrapSql).not.toContain("metric_stream");
    expect(bootstrapSql).not.toContain("postgres_fitness.activity");
  });
});
