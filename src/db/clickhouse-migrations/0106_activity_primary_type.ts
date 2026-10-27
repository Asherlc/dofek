import { buildActivityOriginReadModelRefreshStatements } from "../clickhouse-read-models.ts";
import { hasClickHouseColumn } from "./column-introspection.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  const cyclingStatement =
    "ALTER TABLE analytics.cycling_activity ADD COLUMN IF NOT EXISTS primary_canonical_type Nullable(String) DEFAULT NULL";
  const statements = [
    "ALTER TABLE analytics.deduped_activities ADD COLUMN IF NOT EXISTS primary_canonical_type Nullable(String) DEFAULT NULL",
    cyclingStatement,
    ...buildActivityOriginReadModelRefreshStatements(true),
  ];
  return {
    id: "0106_activity_primary_type",
    statements,
    run: async (client) => {
      const hasCyclingActivity = await hasClickHouseColumn(
        client,
        "analytics",
        "cycling_activity",
        "activity_id",
      );
      for (const statement of statements) {
        if (statement === cyclingStatement && !hasCyclingActivity) continue;
        await client.command({ query: statement });
      }
    },
  };
}
