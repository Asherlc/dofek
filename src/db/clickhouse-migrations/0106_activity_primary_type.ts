import { buildActivityOriginReadModelRefreshStatements } from "../clickhouse-read-models.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0106_activity_primary_type",
    statements: [
      "ALTER TABLE analytics.deduped_activities ADD COLUMN IF NOT EXISTS primary_canonical_type Nullable(String) DEFAULT NULL",
      "ALTER TABLE analytics.cycling_activity ADD COLUMN IF NOT EXISTS primary_canonical_type Nullable(String) DEFAULT NULL",
      ...buildActivityOriginReadModelRefreshStatements(true),
    ],
  };
}
