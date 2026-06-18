import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0031_deduped_activities_absent_source_links",
    statements: [
      `ALTER TABLE analytics.deduped_activities
ADD COLUMN IF NOT EXISTS absent_source_external_ids Array(Map(String, String)) DEFAULT []`,
    ],
  };
}
