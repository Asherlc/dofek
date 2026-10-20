import { z } from "zod";
import { buildActivityOriginReadModelRefreshStatements } from "../clickhouse-read-models.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  const statements = [
    "ALTER TABLE analytics.deduped_activities RENAME COLUMN primary_activity_id TO representative_activity_id",
    "ALTER TABLE analytics.deduped_activities ADD COLUMN IF NOT EXISTS primary_activity_id Nullable(UUID) DEFAULT NULL AFTER user_id",
    "ALTER TABLE analytics.deduped_activities MODIFY COLUMN representative_activity_id UUID AFTER member_activity_ids",
    "ALTER TABLE analytics.deduped_activities ADD COLUMN IF NOT EXISTS primary_provider_id Nullable(String) AFTER representative_activity_id",
    "ALTER TABLE analytics.deduped_activities ADD COLUMN IF NOT EXISTS primary_source_name Nullable(String) AFTER primary_provider_id",
    "ALTER TABLE analytics.deduped_activities ADD COLUMN IF NOT EXISTS origin_candidate_member_ids Array(UUID) DEFAULT member_activity_ids AFTER primary_source_name",
    "ALTER TABLE analytics.deduped_activities ADD COLUMN IF NOT EXISTS origin_evidence Array(Map(String, String)) AFTER origin_candidate_member_ids",
    ...buildActivityOriginReadModelRefreshStatements(),
  ];
  return {
    id: "0103_activity_origin",
    statements,
    run: async (client) => {
      if (!client.query)
        throw new Error("Activity origin migration requires a query-capable client");
      const result = await client.query({
        query:
          "SELECT name FROM system.columns WHERE database = 'analytics' AND table = 'deduped_activities'",
        format: "JSONEachRow",
      });
      const columns = z.array(z.object({ name: z.string() })).parse(await result.json());
      const renamed = columns.some((column) => column.name === "representative_activity_id");
      if (!renamed && !columns.some((column) => column.name === "primary_activity_id")) {
        throw new Error("Activity origin migration cannot preserve a missing representative");
      }
      for (const statement of statements.slice(renamed ? 1 : 0)) {
        await client.command({ query: statement });
      }
    },
  };
}
