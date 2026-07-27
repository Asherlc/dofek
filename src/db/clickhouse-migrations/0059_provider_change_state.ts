import type { ClickHouseMigration } from "./types.ts";

const targetTable = "analytics.provider_change_state";

interface ProviderSource {
  providerIdColumn: string;
  sourceTable: string;
  viewName: string;
}

function getProviderSources(): readonly ProviderSource[] {
  return [
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
  ];
}

function buildChangeViewSql(source: ProviderSource): string {
  const nullableUserFilter =
    source.sourceTable === "postgres_fitness.provider" ? "\nWHERE user_id IS NOT NULL" : "";
  const userIdExpression =
    source.sourceTable === "postgres_fitness.provider" ? "assumeNotNull(user_id)" : "user_id";

  return `CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.provider_change_from_${source.viewName}
TO ${targetTable}
AS
SELECT
  ${userIdExpression} AS user_id,
  ${source.providerIdColumn} AS provider_id,
  max(now64(9)) AS changed_at
FROM ${source.sourceTable}${nullableUserFilter}
GROUP BY user_id, provider_id`;
}

function buildCatalogBootstrapSql(source: ProviderSource): string {
  const nullableUserFilter =
    source.sourceTable === "postgres_fitness.provider" ? "\nWHERE user_id IS NOT NULL" : "";
  const userIdExpression =
    source.sourceTable === "postgres_fitness.provider" ? "assumeNotNull(user_id)" : "user_id";

  return `INSERT INTO ${targetTable} (user_id, provider_id, changed_at)
SELECT
  ${userIdExpression} AS user_id,
  ${source.providerIdColumn} AS provider_id,
  now64(9) AS changed_at
FROM ${source.sourceTable} FINAL${nullableUserFilter}
GROUP BY user_id, provider_id`;
}

export function createMigration(): ClickHouseMigration {
  const providerSources = getProviderSources();

  return {
    id: "0059_provider_change_state",
    statements: [
      `CREATE TABLE IF NOT EXISTS ${targetTable} (
  user_id UUID,
  provider_id String,
  changed_at SimpleAggregateFunction(max, DateTime64(9, 'UTC'))
)
ENGINE = AggregatingMergeTree
ORDER BY (user_id, provider_id)`,
      ...providerSources.map(buildChangeViewSql),
      ...providerSources.slice(0, 2).map(buildCatalogBootstrapSql),
    ],
  };
}
