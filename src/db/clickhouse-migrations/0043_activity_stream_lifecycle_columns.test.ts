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

class TestClickHouseClient implements ClickHouseCommandClient {
  readonly command = vi.fn(async () => undefined);
  readonly queryCalls: QueryOptions[] = [];
  #queryCount = 0;

  constructor(readonly tableCounts: readonly number[]) {}

  async query<TRow extends object>(options: QueryOptions): Promise<{ json(): Promise<TRow[]> }> {
    this.queryCalls.push(options);
    const count = this.tableCounts[this.#queryCount] ?? 0;
    this.#queryCount += 1;
    return {
      json: async () => JSON.parse(JSON.stringify([{ count }])),
    };
  }
}

describe("0043_activity_stream_lifecycle_columns", () => {
  beforeEach(() => {
    mockRunClickHouseMigrationStatement.mockReset();
  });

  it("checks lifecycle tables through query parameters", async () => {
    const client = new TestClickHouseClient([1, 1]);

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
    expect(mockRunClickHouseMigrationStatement).toHaveBeenCalledTimes(4);
  });
});
