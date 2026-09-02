import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClickHouseCommandClient } from "../clickhouse.ts";

const { mockRunClickHouseMigrationStatement } = vi.hoisted(() => ({
  mockRunClickHouseMigrationStatement: vi.fn(),
}));

vi.mock("./statement-runner.ts", () => ({
  runClickHouseMigrationStatement: mockRunClickHouseMigrationStatement,
}));

import { createMigration } from "./0073_activity_sensor_summary_source_version.ts";

type QueryOptions = Parameters<NonNullable<ClickHouseCommandClient["query"]>>[0];

class TestClickHouseClient implements ClickHouseCommandClient {
  readonly command = vi.fn(async () => undefined);
  readonly queryCalls: QueryOptions[] = [];
  #queryCount = 0;
  readonly #tableCounts: readonly (number | undefined)[];

  constructor(tableCounts: readonly (number | undefined)[]) {
    this.#tableCounts = tableCounts;
  }

  async query<TRow extends object>(options: QueryOptions): Promise<{ json(): Promise<TRow[]> }> {
    this.queryCalls.push(options);
    const count = this.#tableCounts[this.#queryCount];
    this.#queryCount += 1;
    const rows = count === undefined ? [] : [{ count }];
    return { json: async () => JSON.parse(JSON.stringify(rows)) };
  }
}

const expectedTableQuery = (name: string): QueryOptions => ({
  query:
    "SELECT count() AS count FROM system.tables WHERE database = 'analytics' AND name = {name:String}",
  query_params: { name },
  format: "JSONEachRow",
});

describe("0073_activity_sensor_summary_source_version", () => {
  beforeEach(() => {
    mockRunClickHouseMigrationStatement.mockReset();
  });

  it("uses valid ALTER TABLE syntax for both tables", () => {
    expect(createMigration().statements).toEqual([
      `ALTER TABLE analytics.activity_sensor_summary_rows
ADD COLUMN IF NOT EXISTS source_refresh_version UInt64 DEFAULT 0 AFTER climbing_seconds`,
      `ALTER TABLE analytics.activity_sensor_sample
MODIFY SETTING deduplicate_merge_projection_mode = 'rebuild'`,
      `ALTER TABLE analytics.activity_sensor_sample ADD PROJECTION IF NOT EXISTS by_activity_source_refresh_version (
  SELECT
    activity_id,
    user_id,
    max(refresh_version) AS source_refresh_version
  GROUP BY activity_id, user_id
)`,
    ]);
  });

  it("skips statements when dbt-owned tables do not exist yet", async () => {
    const client = new TestClickHouseClient([0, 0]);

    await createMigration().run?.(client, "postgres://test");

    expect(client.queryCalls).toEqual([
      expectedTableQuery("activity_sensor_summary_rows"),
      expectedTableQuery("activity_sensor_sample"),
    ]);
    expect(mockRunClickHouseMigrationStatement).not.toHaveBeenCalled();
  });

  it("treats an empty table lookup result as absent", async () => {
    const client = new TestClickHouseClient([undefined, 0]);

    await createMigration().run?.(client, "postgres://test");

    expect(mockRunClickHouseMigrationStatement).not.toHaveBeenCalled();
  });

  it("alters each table only when it exists", async () => {
    const client = new TestClickHouseClient([1, 1]);
    const statements = createMigration().statements;

    await createMigration().run?.(client, "postgres://test");

    expect(mockRunClickHouseMigrationStatement.mock.calls).toEqual([
      [client, statements[0]],
      [client, statements[1]],
      [client, statements[2]],
    ]);
  });

  it("adds only the summary column when the sample table does not exist", async () => {
    const client = new TestClickHouseClient([1, 0]);

    await createMigration().run?.(client, "postgres://test");

    expect(mockRunClickHouseMigrationStatement.mock.calls).toEqual([
      [client, createMigration().statements[0]],
    ]);
  });

  it("adds only the sample projection when the summary table does not exist", async () => {
    const client = new TestClickHouseClient([0, 1]);
    const statements = createMigration().statements;

    await createMigration().run?.(client, "postgres://test");

    expect(mockRunClickHouseMigrationStatement.mock.calls).toEqual([
      [client, statements[1]],
      [client, statements[2]],
    ]);
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
