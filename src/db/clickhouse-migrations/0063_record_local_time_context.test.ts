import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClickHouseCommandClient } from "../clickhouse.ts";

const { mockRunClickHouseMigrationStatement } = vi.hoisted(() => ({
  mockRunClickHouseMigrationStatement: vi.fn(),
}));

vi.mock("./statement-runner.ts", () => ({
  runClickHouseMigrationStatement: mockRunClickHouseMigrationStatement,
}));

import { createMigration } from "./0063_record_local_time_context.ts";

type QueryOptions = Parameters<NonNullable<ClickHouseCommandClient["query"]>>[0];

class TestClickHouseClient implements ClickHouseCommandClient {
  readonly #existingTables: readonly string[];
  readonly #tableCountOverride: number | string | undefined;
  readonly command = vi.fn(async () => undefined);
  readonly queryCalls: QueryOptions[] = [];

  constructor(existingTables: readonly string[], tableCountOverride?: number | string) {
    this.#existingTables = existingTables;
    this.#tableCountOverride = tableCountOverride;
  }

  async query<TRow extends object>(options: QueryOptions): Promise<{ json(): Promise<TRow[]> }> {
    this.queryCalls.push(options);
    const tableName = String(options.query_params?.name);
    const count = this.#tableCountOverride ?? (this.#existingTables.includes(tableName) ? 1 : 0);
    return {
      json: async () => JSON.parse(JSON.stringify([{ count }])),
    };
  }
}

describe("0063_record_local_time_context", () => {
  beforeEach(() => {
    mockRunClickHouseMigrationStatement.mockReset();
  });

  it("adds record-local time context to raw mirrors and serving tables", () => {
    const migration = createMigration();

    expect(migration.id).toBe("0063_record_local_time_context");
    expect(migration.statements).toEqual([
      `ALTER TABLE postgres_fitness.activity
  ADD COLUMN IF NOT EXISTS start_utc_offset_minutes Nullable(Int16),
  ADD COLUMN IF NOT EXISTS end_utc_offset_minutes Nullable(Int16),
  ADD COLUMN IF NOT EXISTS local_time_source LowCardinality(String) DEFAULT 'unknown'`,
      `ALTER TABLE postgres_fitness.sleep_session
  ADD COLUMN IF NOT EXISTS timezone Nullable(String),
  ADD COLUMN IF NOT EXISTS start_utc_offset_minutes Nullable(Int16),
  ADD COLUMN IF NOT EXISTS end_utc_offset_minutes Nullable(Int16),
  ADD COLUMN IF NOT EXISTS local_time_source LowCardinality(String) DEFAULT 'unknown'`,
      `ALTER TABLE analytics.activity_source_records
  ADD COLUMN IF NOT EXISTS start_utc_offset_minutes Nullable(Int16),
  ADD COLUMN IF NOT EXISTS end_utc_offset_minutes Nullable(Int16),
  ADD COLUMN IF NOT EXISTS local_time_source LowCardinality(String) DEFAULT 'unknown'`,
      `ALTER TABLE analytics.deduped_activities
  ADD COLUMN IF NOT EXISTS start_utc_offset_minutes Nullable(Int16),
  ADD COLUMN IF NOT EXISTS end_utc_offset_minutes Nullable(Int16),
  ADD COLUMN IF NOT EXISTS local_time_source LowCardinality(String) DEFAULT 'unknown'`,
      `ALTER TABLE analytics.daily_sleep
  ADD COLUMN IF NOT EXISTS timezone Nullable(String),
  ADD COLUMN IF NOT EXISTS start_utc_offset_minutes Nullable(Int16),
  ADD COLUMN IF NOT EXISTS end_utc_offset_minutes Nullable(Int16),
  ADD COLUMN IF NOT EXISTS local_time_source LowCardinality(String) DEFAULT 'unknown'`,
    ]);
    expect(migration.statements.join("\n")).toContain("start_utc_offset_minutes Nullable(Int16)");
    expect(migration.statements.join("\n")).toContain("end_utc_offset_minutes Nullable(Int16)");
    expect(migration.statements.join("\n")).toContain(
      "local_time_source LowCardinality(String) DEFAULT 'unknown'",
    );
  });

  it("upgrades raw mirrors and only serving tables that dbt has already created", async () => {
    const client = new TestClickHouseClient(["activity_source_records", "daily_sleep"]);
    const migration = createMigration();

    await migration.run?.(client, "postgres://test");

    expect(
      mockRunClickHouseMigrationStatement.mock.calls.map(([, statement]) => statement),
    ).toEqual([
      migration.statements[0],
      migration.statements[1],
      migration.statements[2],
      migration.statements[4],
    ]);
    expect(client.queryCalls.map((call) => call.query_params)).toEqual([
      { name: "activity_source_records" },
      { name: "deduped_activities" },
      { name: "daily_sleep" },
    ]);
  });

  it("requires a query-capable client before checking dbt-owned tables", async () => {
    const client: ClickHouseCommandClient = { command: vi.fn(async () => undefined) };

    await expect(createMigration().run?.(client, "postgres://test")).rejects.toThrow(
      "ClickHouse migrations require a query-capable client",
    );
  });

  it("rejects a malformed serving-table count", async () => {
    const client = new TestClickHouseClient([], "not-a-count");

    await expect(createMigration().run?.(client, "postgres://test")).rejects.toThrow();
  });
});
