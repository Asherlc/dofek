import { describe, expect, it } from "vitest";
import {
  buildPostgresFitnessActivityRawTableStatement,
  buildPostgresFitnessProviderConnectionRawTableStatement,
  buildPostgresFitnessProviderRawTableStatement,
  buildPostgresFitnessRawTableStatements,
} from "./clickhouse-raw-tables.ts";

describe("buildPostgresFitnessActivityRawTableStatement", () => {
  it("mirrors rejected provider local-time evidence for repair verification", () => {
    const statement = buildPostgresFitnessActivityRawTableStatement();

    expect(statement).toContain("rejected_provider_timezone Nullable(String)");
    expect(statement).toContain("rejected_provider_start_utc_offset_minutes Nullable(Int16)");
    expect(statement).toContain("rejected_provider_end_utc_offset_minutes Nullable(Int16)");
  });
});

describe("buildPostgresFitnessProviderConnectionRawTableStatement", () => {
  it("builds the canonical provider connection mirror", () => {
    const statement = buildPostgresFitnessProviderConnectionRawTableStatement();

    expect(statement).toContain("CREATE TABLE IF NOT EXISTS postgres_fitness.provider_connection");
    expect(statement).toContain("ORDER BY (user_id, provider_id)");
    expect(statement).toContain("SETTINGS allow_nullable_key = 1");
  });
});

describe("buildPostgresFitnessProviderRawTableStatement", () => {
  it("builds the canonical provider table by default", () => {
    const statement = buildPostgresFitnessProviderRawTableStatement();

    expect(statement).toContain("CREATE TABLE IF NOT EXISTS postgres_fitness.provider");
    expect(statement).toContain("user_id Nullable(UUID)");
    expect(statement).toContain("ORDER BY (id)");
  });

  it("builds a required replacement table for migrations", () => {
    const statement = buildPostgresFitnessProviderRawTableStatement({
      tableName: "postgres_fitness.provider_catalog_next",
      ifNotExists: false,
    });

    expect(statement).toContain("CREATE TABLE postgres_fitness.provider_catalog_next");
    expect(statement).not.toContain("CREATE TABLE IF NOT EXISTS");
  });

  it("retains idempotent creation when explicitly requested", () => {
    const statement = buildPostgresFitnessProviderRawTableStatement({
      tableName: "postgres_fitness.provider_catalog_next",
      ifNotExists: true,
    });

    expect(statement).toContain(
      "CREATE TABLE IF NOT EXISTS postgres_fitness.provider_catalog_next",
    );
  });
});

describe("buildPostgresFitnessRawTableStatements", () => {
  it("creates the exact processing marker mirror used for relational CDC evidence", () => {
    const markerTable = buildPostgresFitnessRawTableStatements().find((statement) =>
      statement.includes("postgres_fitness.processing_flow_marker"),
    );

    expect(markerTable).toContain("operation_id UUID");
    expect(markerTable).toContain("dataset_key String");
    expect(markerTable).toContain("flow_name String");
    expect(markerTable).toContain("batch_key String");
    expect(markerTable).toContain("source_watermark String");
    expect(markerTable).toContain("_peerdb_synced_at DateTime64(9)");

    const providerInventoryMarkerTable = buildPostgresFitnessRawTableStatements().find(
      (statement) =>
        statement.includes("postgres_fitness.processing_flow_marker_provider_inventory"),
    );
    expect(providerInventoryMarkerTable).toContain("operation_id UUID");
    expect(providerInventoryMarkerTable).toContain("flow_name String");
  });
});
