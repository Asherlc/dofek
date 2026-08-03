import { LEGACY_ACTIVITY_TYPE_CLASSIFICATIONS } from "@dofek/training/activity-types";
import type { ClickHouseCommandClient } from "../clickhouse.ts";
import { runClickHouseMigrationStatement } from "./statement-runner.ts";
import type { ClickHouseMigration } from "./types.ts";

interface ColumnCountRow {
  column_count: number | string;
}

function canonicalCase(): string {
  return classificationCase("canonicalType", "canonical_type");
}

function modalityCase(): string {
  return classificationCase("modality", "NULL");
}

const servingTables = [
  "activity_aerobic_efficiency",
  "activity_polarization_zones",
  "activity_power_curve",
  "activity_source_records",
  "activity_summary_rows",
  "activity_vo2max_estimate",
  "cycling_activity",
  "daily_endurance_load",
  "deduped_activities",
  "hiking_activity",
] as const;

function clickHouseString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function classificationCase(
  property: "canonicalType" | "modality",
  nullExpression: string,
): string {
  const cases = Object.entries(LEGACY_ACTIVITY_TYPE_CLASSIFICATIONS)
    .map(([legacyType, classification]) => {
      const value = classification[property];
      return `WHEN ${clickHouseString(legacyType)} THEN ${
        value === null ? nullExpression : clickHouseString(value)
      }`;
    })
    .join("\n      ");
  return `CASE canonical_type\n      ${cases}\n      ELSE ${nullExpression}\n    END`;
}

async function hasColumn(
  client: ClickHouseCommandClient,
  database: string,
  table: string,
  column: string,
): Promise<boolean> {
  if (!client.query) {
    throw new Error("Canonical activity type migration requires a query-capable client");
  }
  const result = await client.query<ColumnCountRow>({
    query: `SELECT count() AS column_count
FROM system.columns
WHERE database = {database:String}
  AND table = {table:String}
  AND name = {column:String}`,
    format: "JSONEachRow",
    query_params: { database, table, column },
  });
  const rows = await result.json();
  return Number(rows[0]?.column_count ?? 0) > 0;
}

async function runStatement(client: ClickHouseCommandClient, statement: string): Promise<void> {
  await runClickHouseMigrationStatement(client, statement);
}

async function migrateReplicatedActivity(client: ClickHouseCommandClient): Promise<void> {
  const hasLegacyColumn = await hasColumn(client, "postgres_fitness", "activity", "activity_type");
  let hasCanonicalColumn = await hasColumn(
    client,
    "postgres_fitness",
    "activity",
    "canonical_type",
  );
  const hadBothColumns = hasLegacyColumn && hasCanonicalColumn;

  if (hasLegacyColumn && !hasCanonicalColumn) {
    await runStatement(
      client,
      "ALTER TABLE postgres_fitness.activity RENAME COLUMN activity_type TO canonical_type",
    );
    hasCanonicalColumn = true;
  }
  if (!hasCanonicalColumn) {
    throw new Error("postgres_fitness.activity has neither activity_type nor canonical_type");
  }

  const providerSource = hadBothColumns ? "activity_type" : "canonical_type";
  const hasProviderColumn = await hasColumn(
    client,
    "postgres_fitness",
    "activity",
    "provider_type",
  );
  if (!hasProviderColumn) {
    await runStatement(
      client,
      `ALTER TABLE postgres_fitness.activity
  ADD COLUMN IF NOT EXISTS provider_type String DEFAULT ${providerSource} AFTER canonical_type`,
    );
    await runStatement(
      client,
      "ALTER TABLE postgres_fitness.activity MATERIALIZE COLUMN provider_type",
    );
  }
  await runStatement(
    client,
    `ALTER TABLE postgres_fitness.activity
  ADD COLUMN IF NOT EXISTS modality Nullable(String) AFTER provider_type`,
  );

  if (hadBothColumns) {
    await runStatement(
      client,
      `ALTER TABLE postgres_fitness.activity
  UPDATE
    provider_type = if(provider_type = '', activity_type, provider_type),
    modality = if(modality IS NULL, ${modalityCase().replaceAll("canonical_type", "activity_type")}, modality),
    canonical_type = if(canonical_type = '', ${canonicalCase().replaceAll("canonical_type", "activity_type")}, canonical_type)
  WHERE true
  SETTINGS mutations_sync = 2`,
    );
    await runStatement(client, "ALTER TABLE postgres_fitness.activity DROP COLUMN activity_type");
  } else {
    await runStatement(
      client,
      `ALTER TABLE postgres_fitness.activity
  UPDATE
    modality = if(modality IS NULL, ${modalityCase()}, modality),
    canonical_type = ${canonicalCase()}
  WHERE true
  SETTINGS mutations_sync = 2`,
    );
  }

  await runStatement(
    client,
    "ALTER TABLE postgres_fitness.activity MODIFY COLUMN provider_type String",
  );
  await runStatement(
    client,
    `SELECT throwIf(countIf(canonical_type = '') > 0 OR countIf(provider_type = '') > 0,
  'Canonical activity type backfill left unmapped rows')
FROM postgres_fitness.activity
WHERE _peerdb_is_deleted = 0`,
  );
}

async function migrateServingTables(client: ClickHouseCommandClient): Promise<void> {
  for (const table of servingTables) {
    const hasLegacyColumn = await hasColumn(client, "analytics", table, "activity_type");
    const hasCanonicalColumn = await hasColumn(client, "analytics", table, "canonical_type");
    if (hasLegacyColumn && !hasCanonicalColumn) {
      await runStatement(
        client,
        `ALTER TABLE analytics.${table} RENAME COLUMN activity_type TO canonical_type`,
      );
    }
    if (hasLegacyColumn || hasCanonicalColumn) {
      await runStatement(
        client,
        `ALTER TABLE analytics.${table}
  UPDATE canonical_type = ${canonicalCase()}
  WHERE canonical_type IN (${Object.keys(LEGACY_ACTIVITY_TYPE_CLASSIFICATIONS)
    .map(clickHouseString)
    .join(", ")})
  SETTINGS mutations_sync = 2`,
      );
    }
  }

  for (const table of [
    "activity_source_records",
    "deduped_activities",
    "activity_summary_rows",
    "cycling_activity",
  ]) {
    if (await hasColumn(client, "analytics", table, "canonical_type")) {
      await runStatement(
        client,
        `ALTER TABLE analytics.${table}
  ADD COLUMN IF NOT EXISTS provider_type Nullable(String) AFTER canonical_type`,
      );
      await runStatement(
        client,
        `ALTER TABLE analytics.${table}
  ADD COLUMN IF NOT EXISTS modality Nullable(String) AFTER provider_type`,
      );
    }
  }
}

export function createMigration(): ClickHouseMigration {
  return {
    id: "0069_canonical_activity_types",
    statements: [
      "ALTER TABLE postgres_fitness.activity RENAME COLUMN activity_type TO canonical_type",
      `ALTER TABLE postgres_fitness.activity
  ADD COLUMN IF NOT EXISTS provider_type String DEFAULT canonical_type AFTER canonical_type`,
      "ALTER TABLE postgres_fitness.activity MATERIALIZE COLUMN provider_type",
      `ALTER TABLE postgres_fitness.activity
  ADD COLUMN IF NOT EXISTS modality Nullable(String) AFTER provider_type`,
      `ALTER TABLE postgres_fitness.activity
  UPDATE modality = if(modality IS NULL, ${modalityCase()}, modality), canonical_type = ${canonicalCase()}
  WHERE true
  SETTINGS mutations_sync = 2`,
      "ALTER TABLE analytics.activity_summary_rows RENAME COLUMN activity_type TO canonical_type",
      `SELECT throwIf(countIf(canonical_type = '') > 0 OR countIf(provider_type = '') > 0,
  'Canonical activity type backfill left unmapped rows')
FROM postgres_fitness.activity
WHERE _peerdb_is_deleted = 0`,
    ],
    run: async (client) => {
      await migrateReplicatedActivity(client);
      await migrateServingTables(client);
    },
  };
}
