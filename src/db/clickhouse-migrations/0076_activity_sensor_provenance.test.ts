import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClickHouseCommandClient } from "../clickhouse.ts";

const { runStatement } = vi.hoisted(() => ({ runStatement: vi.fn() }));

vi.mock("./statement-runner.ts", () => ({
  runClickHouseMigrationStatement: runStatement,
}));

import { createMigration } from "./0076_activity_sensor_provenance.ts";

type QueryOptions = Parameters<NonNullable<ClickHouseCommandClient["query"]>>[0];

class TestClickHouseClient implements ClickHouseCommandClient {
  readonly command = vi.fn(async () => undefined);
  #queryIndex = 0;

  constructor(readonly tableCounts: readonly (number | string | undefined)[]) {}

  async query<TRow extends object>(_options: QueryOptions): Promise<{ json(): Promise<TRow[]> }> {
    const count = this.tableCounts[this.#queryIndex];
    this.#queryIndex += 1;
    const rows = count === undefined ? [] : [{ count }];
    return { json: async () => JSON.parse(JSON.stringify(rows)) };
  }
}

describe("0076_activity_sensor_provenance", () => {
  beforeEach(() => {
    runStatement.mockReset();
  });

  it("contains only schema changes for provenance columns", () => {
    const migration = createMigration();
    const sql = migration.statements.join("\n");

    expect(migration.id).toBe("0076_activity_sensor_provenance");
    expect(sql).toContain("ALTER TABLE analytics.sensor_scalar_sample");
    expect(sql).toContain("ALTER TABLE analytics.deduped_sensor");
    expect(sql).toContain("ALTER TABLE analytics.activity_sensor_sample");
    expect(sql).toContain("ALTER TABLE analytics.activity_location_sample");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS measurement_kind");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS member_activity_id");
    expect(sql).not.toContain("INSERT INTO");
  });

  it("alters only dbt tables that already exist", async () => {
    const client = new TestClickHouseClient([1, 1, 0, 1]);
    const statements = createMigration().statements;

    await createMigration().run?.(client, "postgres://unused");

    expect(runStatement.mock.calls).toEqual([
      [client, statements[0]],
      [client, statements[1]],
      [client, statements[3]],
    ]);
  });

  it("fails loudly when table introspection returns no row", async () => {
    const client = new TestClickHouseClient([undefined]);

    await expect(createMigration().run?.(client, "postgres://unused")).rejects.toThrow(
      "Expected one ClickHouse table count row",
    );
  });
});
