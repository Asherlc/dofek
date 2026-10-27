import { buildPostgresFitnessRawTableStatements } from "../clickhouse-raw-tables.ts";
import type { ClickHouseMigration } from "./types.ts";

const processingMarkerTablePrefixes = [
  "CREATE TABLE IF NOT EXISTS postgres_fitness.processing_flow_marker (",
  "CREATE TABLE IF NOT EXISTS postgres_fitness.processing_flow_marker_provider_inventory (",
] as const;

export function createMigration(): ClickHouseMigration {
  const rawTableStatements = buildPostgresFitnessRawTableStatements();
  const statements = processingMarkerTablePrefixes.map((tablePrefix) => {
    const statement = rawTableStatements.find((candidate) => candidate.startsWith(tablePrefix));
    if (!statement) {
      throw new Error(`Missing ClickHouse processing marker definition: ${tablePrefix}`);
    }
    return statement;
  });

  return {
    id: "0052_processing_flow_markers",
    statements,
  };
}
