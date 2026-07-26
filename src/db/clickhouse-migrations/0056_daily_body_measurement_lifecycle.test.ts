import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClickHouseCommandClient } from "../clickhouse.ts";

const { mockRunClickHouseMigrationStatement } = vi.hoisted(() => ({
  mockRunClickHouseMigrationStatement: vi.fn(),
}));

vi.mock("./statement-runner.ts", () => ({
  runClickHouseMigrationStatement: mockRunClickHouseMigrationStatement,
}));

import { createMigration } from "./0056_daily_body_measurement_lifecycle.ts";

type QueryOptions = Parameters<NonNullable<ClickHouseCommandClient["query"]>>[0];

class TestClickHouseClient implements ClickHouseCommandClient {
  readonly command = vi.fn(async () => undefined);
  readonly queryCalls: QueryOptions[] = [];

  constructor(readonly tableCount: number | string) {}

  async query<TRow extends object>(options: QueryOptions): Promise<{ json(): Promise<TRow[]> }> {
    this.queryCalls.push(options);
    return {
      json: async () => JSON.parse(JSON.stringify([{ count: this.tableCount }])),
    };
  }
}

describe("0056_daily_body_measurement_lifecycle", () => {
  beforeEach(() => {
    mockRunClickHouseMigrationStatement.mockReset();
  });

  it("adds lifecycle and source-watermark columns to the existing serving table", () => {
    expect(createMigration()).toMatchObject({
      id: "0056_daily_body_measurement_lifecycle",
      statements: [
        `ALTER TABLE analytics.daily_body_measurement
        ADD COLUMN IF NOT EXISTS is_deleted UInt8 DEFAULT 0 AFTER body_fat_pct`,
        `ALTER TABLE analytics.daily_body_measurement
        ADD COLUMN IF NOT EXISTS source_synced_at DateTime64(9, 'UTC')
        DEFAULT toDateTime64('1970-01-01 00:00:00', 9, 'UTC') AFTER is_deleted`,
        `ALTER TABLE analytics.daily_body_measurement
        ADD INDEX IF NOT EXISTS refreshed_at_minmax refreshed_at TYPE minmax GRANULARITY 1`,
        `ALTER TABLE analytics.daily_body_measurement
        MATERIALIZE INDEX refreshed_at_minmax SETTINGS mutations_sync = 2`,
      ],
    });
  });

  it("skips the upgrade when dbt has not created the serving table yet", async () => {
    const client = new TestClickHouseClient(0);

    await createMigration().run?.(client, "postgres://test");

    expect(client.queryCalls[0]).toMatchObject({
      query:
        "SELECT count() AS count FROM system.tables WHERE database = 'analytics' AND name = {name:String}",
      query_params: { name: "daily_body_measurement" },
    });
    expect(mockRunClickHouseMigrationStatement).not.toHaveBeenCalled();
  });

  it("upgrades an existing serving table", async () => {
    const client = new TestClickHouseClient(1);
    const migration = createMigration();

    await migration.run?.(client, "postgres://test");

    expect(mockRunClickHouseMigrationStatement).toHaveBeenCalledTimes(4);
    expect(mockRunClickHouseMigrationStatement).toHaveBeenNthCalledWith(
      1,
      client,
      migration.statements[0],
    );
    expect(mockRunClickHouseMigrationStatement).toHaveBeenNthCalledWith(
      2,
      client,
      migration.statements[1],
    );
  });

  it("rejects a malformed serving-table count", async () => {
    const client = new TestClickHouseClient("not-a-count");

    await expect(createMigration().run?.(client, "postgres://test")).rejects.toThrow();
    expect(mockRunClickHouseMigrationStatement).not.toHaveBeenCalled();
  });
});
