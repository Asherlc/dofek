import { beforeEach, describe, expect, it, vi } from "vitest";

const { buildPostgresFitnessRawTableStatements } = vi.hoisted(() => ({
  buildPostgresFitnessRawTableStatements: vi.fn<() => string[]>(),
}));

vi.mock("../clickhouse-raw-tables.ts", () => ({
  buildPostgresFitnessRawTableStatements,
}));

import { createMigration } from "./0052_processing_flow_markers.ts";

describe("0052 processing flow markers migration", () => {
  beforeEach(() => {
    buildPostgresFitnessRawTableStatements.mockReset();
  });

  it("selects both processing marker definitions in flow order", () => {
    const analyticsMarker =
      "CREATE TABLE IF NOT EXISTS postgres_fitness.processing_flow_marker (operation_id UUID)";
    const providerInventoryMarker =
      "CREATE TABLE IF NOT EXISTS postgres_fitness.processing_flow_marker_provider_inventory (operation_id UUID)";
    buildPostgresFitnessRawTableStatements.mockReturnValue([
      "CREATE TABLE IF NOT EXISTS postgres_fitness.activity (id UUID)",
      providerInventoryMarker,
      analyticsMarker,
    ]);

    expect(createMigration()).toEqual({
      id: "0052_processing_flow_markers",
      statements: [analyticsMarker, providerInventoryMarker],
    });
  });

  it("rejects a missing processing marker definition", () => {
    buildPostgresFitnessRawTableStatements.mockReturnValue([
      "CREATE TABLE IF NOT EXISTS postgres_fitness.processing_flow_marker (operation_id UUID)",
    ]);

    expect(() => createMigration()).toThrow(
      "Missing ClickHouse processing marker definition: CREATE TABLE IF NOT EXISTS postgres_fitness.processing_flow_marker_provider_inventory (",
    );
  });
});
