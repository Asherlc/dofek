import { describe, expect, it } from "vitest";
import type { ClickHouseCommandClient } from "../clickhouse.ts";
import { hasClickHouseColumn } from "./column-introspection.ts";
import { makeFakeClickHouseMigrationClient } from "./test-helpers.ts";

describe("hasClickHouseColumn", () => {
  it("reports a column that system.columns knows about", async () => {
    const { client } = makeFakeClickHouseMigrationClient({
      "analytics.activity_summary_rows.provider_type": 1,
    });

    await expect(
      hasClickHouseColumn(client, "analytics", "activity_summary_rows", "provider_type"),
    ).resolves.toBe(true);
  });

  it("reports a column that system.columns does not know about", async () => {
    const { client } = makeFakeClickHouseMigrationClient();

    await expect(
      hasClickHouseColumn(client, "analytics", "activity_summary_rows", "provider_type"),
    ).resolves.toBe(false);
  });

  it("treats an empty metadata response as a missing column", async () => {
    const client: ClickHouseCommandClient = {
      command: async () => {},
      query: async () => ({ json: async () => [] }),
    };

    await expect(hasClickHouseColumn(client, "analytics", "any_table", "any_column")).resolves.toBe(
      false,
    );
  });

  it("requires a query-capable client", async () => {
    const client: ClickHouseCommandClient = {
      command: async () => {},
    };

    await expect(
      hasClickHouseColumn(client, "analytics", "any_table", "any_column"),
    ).rejects.toThrow("ClickHouse migrations require a query-capable client");
  });
});
