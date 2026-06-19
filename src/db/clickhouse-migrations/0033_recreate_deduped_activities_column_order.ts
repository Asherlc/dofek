import { dedupedActivitiesTableSql } from "./0024_create_dbt_serving_read_model_tables.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0033_recreate_deduped_activities_column_order",
    statements: ["DROP TABLE IF EXISTS analytics.deduped_activities", dedupedActivitiesTableSql],
  };
}
