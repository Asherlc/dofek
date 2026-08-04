import type { ClickHouseCommandClient } from "../clickhouse.ts";
import { buildActivitySummaryViewSql } from "../clickhouse-activity-summary.ts";
import { buildActivityReadModelRefreshStatements } from "../clickhouse-read-models.ts";
import { hasClickHouseColumn } from "./column-introspection.ts";
import { runClickHouseMigrationStatement } from "./statement-runner.ts";
import type { ClickHouseMigration } from "./types.ts";

const PROVENANCE_LOOKUP_TABLE = "analytics.activity_provenance_backfill";

/**
 * Serving tables that 0069 gave `provider_type` and `modality` columns without a value.
 * Each one keys provenance by the canonical activity id, so a single lookup fills them all.
 */
const provenanceServingTables = [
  "activity_source_records",
  "activity_summary_rows",
  "cycling_activity",
  "deduped_activities",
] as const;

/**
 * ClickHouse views store the query text they were created with. 0069 renamed
 * `activity_type` to `canonical_type` underneath views that were created with
 * `CREATE VIEW IF NOT EXISTS`, so the recreate was a no-op and their stored bodies kept
 * selecting a column that no longer exists. Dropping first is what makes the recreate land.
 */
function buildStaleActivityViewRepairStatements(): string[] {
  return [
    ...buildActivityReadModelRefreshStatements(),
    "DROP VIEW IF EXISTS analytics.activity_summary",
    buildActivitySummaryViewSql(),
  ];
}

function buildActivityProvenanceLookupStatements(): string[] {
  return [
    `DROP TABLE IF EXISTS ${PROVENANCE_LOOKUP_TABLE}`,
    `CREATE TABLE ${PROVENANCE_LOOKUP_TABLE} (
  activity_id UUID,
  provider_type String,
  modality Nullable(String)
)
ENGINE = Join(ANY, LEFT, activity_id)`,
    `INSERT INTO ${PROVENANCE_LOOKUP_TABLE}
SELECT
  id AS activity_id,
  provider_type,
  modality
FROM postgres_fitness.activity FINAL
WHERE _peerdb_is_deleted = 0`,
  ];
}

/**
 * `joinGet` yields the column default for an activity the lookup does not cover, so a
 * missing provider type arrives as an empty string and is stored as null instead.
 */
function buildActivityProvenanceBackfillStatement(table: string): string {
  return `ALTER TABLE analytics.${table}
  UPDATE
    provider_type = nullIf(joinGet('${PROVENANCE_LOOKUP_TABLE}', 'provider_type', activity_id), ''),
    modality = joinGet('${PROVENANCE_LOOKUP_TABLE}', 'modality', activity_id)
  WHERE provider_type IS NULL
    AND is_deleted = 0
  SETTINGS mutations_sync = 2`;
}

async function assertProvenanceSourceIsCanonical(client: ClickHouseCommandClient): Promise<void> {
  const hasProviderType = await hasClickHouseColumn(
    client,
    "postgres_fitness",
    "activity",
    "provider_type",
  );
  const hasModality = await hasClickHouseColumn(client, "postgres_fitness", "activity", "modality");
  if (!hasProviderType || !hasModality) {
    throw new Error(
      "postgres_fitness.activity is missing provider_type or modality; apply 0069_canonical_activity_types first",
    );
  }
}

async function backfillActivityProvenance(client: ClickHouseCommandClient): Promise<void> {
  const tablesToBackfill: string[] = [];
  for (const table of provenanceServingTables) {
    if (await hasClickHouseColumn(client, "analytics", table, "provider_type")) {
      tablesToBackfill.push(table);
    }
  }
  if (tablesToBackfill.length === 0) {
    return;
  }

  for (const statement of buildActivityProvenanceLookupStatements()) {
    await runClickHouseMigrationStatement(client, statement);
  }
  for (const table of tablesToBackfill) {
    await runClickHouseMigrationStatement(client, buildActivityProvenanceBackfillStatement(table));
  }
  await runClickHouseMigrationStatement(client, `DROP TABLE IF EXISTS ${PROVENANCE_LOOKUP_TABLE}`);
}

export function createMigration(): ClickHouseMigration {
  return {
    id: "0071_repair_canonical_activity_type_reads",
    statements: [
      ...buildStaleActivityViewRepairStatements(),
      ...buildActivityProvenanceLookupStatements(),
      ...provenanceServingTables.map((table) => buildActivityProvenanceBackfillStatement(table)),
      `DROP TABLE IF EXISTS ${PROVENANCE_LOOKUP_TABLE}`,
    ],
    run: async (client) => {
      await assertProvenanceSourceIsCanonical(client);
      for (const statement of buildStaleActivityViewRepairStatements()) {
        await runClickHouseMigrationStatement(client, statement);
      }
      await backfillActivityProvenance(client);
    },
  };
}
