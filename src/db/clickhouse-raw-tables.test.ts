import { describe, expect, it } from "vitest";
import { buildPostgresFitnessRawTableStatements } from "./clickhouse-raw-tables.ts";

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
