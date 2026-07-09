import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClickHouseCommandClient } from "../clickhouse.ts";

const { mockRunClickHouseMigrationStatement } = vi.hoisted(() => ({
  mockRunClickHouseMigrationStatement: vi.fn(),
}));

vi.mock("./statement-runner.ts", () => ({
  runClickHouseMigrationStatement: mockRunClickHouseMigrationStatement,
}));

import { createMigration } from "./0043_activity_stream_lifecycle_columns.ts";

type QueryOptions = Parameters<NonNullable<ClickHouseCommandClient["query"]>>[0];
type TableCountRow = { count: number | string };
type QueryRows = readonly TableCountRow[];

class TestClickHouseClient implements ClickHouseCommandClient {
  readonly command = vi.fn(async () => undefined);
  readonly queryCalls: QueryOptions[] = [];
  #queryCount = 0;

  constructor(readonly queryResponses: readonly QueryRows[]) {}

  static withTableCounts(tableCounts: readonly number[]): TestClickHouseClient {
    return new TestClickHouseClient(tableCounts.map((count) => [{ count }]));
  }

  async query<TRow extends object>(options: QueryOptions): Promise<{ json(): Promise<TRow[]> }> {
    this.queryCalls.push(options);
    const rows = this.queryResponses[this.#queryCount] ?? [];
    this.#queryCount += 1;
    return {
      json: async () => JSON.parse(JSON.stringify(rows)),
    };
  }
}

describe("0043_activity_stream_lifecycle_columns", () => {
  beforeEach(() => {
    mockRunClickHouseMigrationStatement.mockReset();
  });

  it("exposes the guarded lifecycle column statements", () => {
    expect(createMigration().statements).toEqual([
      "ALTER TABLE analytics.activity_stream_points ADD COLUMN IF NOT EXISTS is_deleted UInt8 AFTER refresh_version",
      "ALTER TABLE analytics.activity_stream_points ADD COLUMN IF NOT EXISTS refreshed_at DateTime64(9, 'UTC') AFTER is_deleted",
      "ALTER TABLE analytics.activity_heart_rate_zones ADD COLUMN IF NOT EXISTS is_deleted UInt8 AFTER refresh_version",
      "ALTER TABLE analytics.activity_heart_rate_zones ADD COLUMN IF NOT EXISTS refreshed_at DateTime64(9, 'UTC') AFTER is_deleted",
    ]);
  });

  it("checks lifecycle tables through query parameters", async () => {
    const client = TestClickHouseClient.withTableCounts([1, 1]);

    await createMigration().run?.(client, "postgres://test");

    expect(client.queryCalls).toEqual([
      expect.objectContaining({
        query:
          "SELECT count() AS count FROM system.tables WHERE database = 'analytics' AND name = {name:String}",
        query_params: { name: "activity_stream_points" },
      }),
      expect.objectContaining({
        query:
          "SELECT count() AS count FROM system.tables WHERE database = 'analytics' AND name = {name:String}",
        query_params: { name: "activity_heart_rate_zones" },
      }),
    ]);
    expect(mockRunClickHouseMigrationStatement).toHaveBeenNthCalledWith(
      1,
      client,
      "ALTER TABLE analytics.activity_stream_points ADD COLUMN IF NOT EXISTS is_deleted UInt8 AFTER refresh_version",
    );
    expect(mockRunClickHouseMigrationStatement).toHaveBeenNthCalledWith(
      2,
      client,
      "ALTER TABLE analytics.activity_stream_points ADD COLUMN IF NOT EXISTS refreshed_at DateTime64(9, 'UTC') AFTER is_deleted",
    );
    expect(mockRunClickHouseMigrationStatement).toHaveBeenNthCalledWith(
      3,
      client,
      "ALTER TABLE analytics.activity_heart_rate_zones ADD COLUMN IF NOT EXISTS is_deleted UInt8 AFTER refresh_version",
    );
    expect(mockRunClickHouseMigrationStatement).toHaveBeenNthCalledWith(
      4,
      client,
      "ALTER TABLE analytics.activity_heart_rate_zones ADD COLUMN IF NOT EXISTS refreshed_at DateTime64(9, 'UTC') AFTER is_deleted",
    );
  });

  it("skips lifecycle statements when the table does not exist", async () => {
    const client = TestClickHouseClient.withTableCounts([0, 0]);

    await createMigration().run?.(client, "postgres://test");

    expect(client.queryCalls).toHaveLength(2);
    expect(mockRunClickHouseMigrationStatement).not.toHaveBeenCalled();
  });

  it("runs only stream point statements when the zone table does not exist", async () => {
    const client = TestClickHouseClient.withTableCounts([1, 0]);

    await createMigration().run?.(client, "postgres://test");

    expect(mockRunClickHouseMigrationStatement).toHaveBeenCalledTimes(2);
    expect(mockRunClickHouseMigrationStatement).toHaveBeenNthCalledWith(
      1,
      client,
      "ALTER TABLE analytics.activity_stream_points ADD COLUMN IF NOT EXISTS is_deleted UInt8 AFTER refresh_version",
    );
    expect(mockRunClickHouseMigrationStatement).toHaveBeenNthCalledWith(
      2,
      client,
      "ALTER TABLE analytics.activity_stream_points ADD COLUMN IF NOT EXISTS refreshed_at DateTime64(9, 'UTC') AFTER is_deleted",
    );
  });

  it("runs only heart-rate zone statements when the stream point table does not exist", async () => {
    const client = TestClickHouseClient.withTableCounts([0, 1]);

    await createMigration().run?.(client, "postgres://test");

    expect(mockRunClickHouseMigrationStatement).toHaveBeenCalledTimes(2);
    expect(mockRunClickHouseMigrationStatement).toHaveBeenNthCalledWith(
      1,
      client,
      "ALTER TABLE analytics.activity_heart_rate_zones ADD COLUMN IF NOT EXISTS is_deleted UInt8 AFTER refresh_version",
    );
    expect(mockRunClickHouseMigrationStatement).toHaveBeenNthCalledWith(
      2,
      client,
      "ALTER TABLE analytics.activity_heart_rate_zones ADD COLUMN IF NOT EXISTS refreshed_at DateTime64(9, 'UTC') AFTER is_deleted",
    );
  });

  it("requires a query-capable client", async () => {
    const client: ClickHouseCommandClient = {
      command: vi.fn(async () => undefined),
    };

    await expect(createMigration().run?.(client, "postgres://test")).rejects.toThrow(
      "ClickHouse migrations require a query-capable client",
    );
  });
});
