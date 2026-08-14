import { addDedupedActivitiesAbsentSourceLinks } from "./custom-runs.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0032_deduped_activities_absent_source_links",
    statements: [],
    run: addDedupedActivitiesAbsentSourceLinks,
  };
}
