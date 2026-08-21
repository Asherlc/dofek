import { describe, expect, it, vi } from "vitest";
import type { ClickHouseCommandClient } from "../clickhouse.ts";
import {
  countFromLegacyTableRows,
  createMigration,
  parseLegacyTableCount,
} from "./0034_move_metric_stream_to_ingest.ts";

const postgresConnectionString = "postgres://test:test@localhost:5432/test";

function createClient(count: string): ClickHouseCommandClient {
  const command = vi.fn();
  return {
    command,
    query: vi.fn().mockResolvedValue({
      json: async () => [{ count }],
    }),
  };
}

describe("0034_move_metric_stream_to_ingest", () => {
  it("parses numeric and string ClickHouse count rows", () => {
    expect(parseLegacyTableCount([{ count: 2 }])).toBe(2);
    expect(parseLegacyTableCount([{ count: "0" }])).toBe(0);
    expect(countFromLegacyTableRows([{ count: "3" }])).toBe(3);
    expect(() => countFromLegacyTableRows([])).toThrow(
      /Expected at least one row from system.tables count query/,
    );
  });

  it("skips copying when the legacy metric_stream table does not exist", async () => {
    const client = createClient("0");
    const migration = createMigration();
    expect(migration.run).toBeDefined();

    await migration.run?.(client, postgresConnectionString);

    expect(client.command).not.toHaveBeenCalled();
  });

  it("copies and drops the legacy table when it exists", async () => {
    const client = createClient("1");
    const migration = createMigration();
    expect(migration.run).toBeDefined();

    await migration.run?.(client, postgresConnectionString);

    expect(client.command).toHaveBeenCalledTimes(2);
    expect(vi.mocked(client.command).mock.calls[0]?.[0]?.query).toContain("INSERT INTO");
    expect(vi.mocked(client.command).mock.calls[1]?.[0]?.query).toContain("DROP TABLE IF EXISTS");
  });
});
