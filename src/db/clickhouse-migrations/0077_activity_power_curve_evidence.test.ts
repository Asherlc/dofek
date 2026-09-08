import { describe, expect, it, vi } from "vitest";
import type { ClickHouseCommandClient } from "../clickhouse.ts";
import { createMigration } from "./0077_activity_power_curve_evidence.ts";

type QueryOptions = Parameters<NonNullable<ClickHouseCommandClient["query"]>>[0];
type CommandOptions = Parameters<ClickHouseCommandClient["command"]>[0];

class TestClickHouseClient implements ClickHouseCommandClient {
  readonly command = vi.fn(async (_options: CommandOptions) => undefined);

  constructor(readonly tableCount: number | string | undefined) {}

  async query<TRow extends object>(_options: QueryOptions): Promise<{ json(): Promise<TRow[]> }> {
    const rows = this.tableCount === undefined ? [] : [{ count: this.tableCount }];
    return { json: async () => JSON.parse(JSON.stringify(rows)) };
  }
}

describe("0077_activity_power_curve_evidence", () => {
  it("adds nullable quality and provenance fields without rewriting history", () => {
    const migration = createMigration();
    const sql = migration.statements.join("\n");

    expect(migration.id).toBe("0077_activity_power_curve_evidence");
    expect(sql).toContain("ALTER TABLE analytics.activity_power_curve");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS start_offset_seconds Nullable(Float64)");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS observed_samples Nullable(UInt64)");
    expect(sql).toContain(
      "ADD COLUMN IF NOT EXISTS median_sample_interval_seconds Nullable(Float64)",
    );
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS largest_gap_seconds Nullable(Float64)");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS coverage_pct Nullable(Float64)");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS power_measurement_kind Nullable(String)");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS source_providers Array(String)");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS source_devices Array(String)");
    expect(sql).not.toContain("INSERT INTO");
    expect(sql).not.toContain("UPDATE");
  });

  it("skips the schema change when dbt has not created the read model yet", async () => {
    const client = new TestClickHouseClient(0);

    const migration = createMigration();
    expect(migration.run).toBeTypeOf("function");
    await migration.run?.(client, "postgres://unused");

    expect(client.command).not.toHaveBeenCalled();
  });

  it("alters an existing dbt read model through the migration statement runner", async () => {
    const client = new TestClickHouseClient("1");

    await createMigration().run?.(client, "postgres://unused");

    expect(client.command).toHaveBeenCalledOnce();
    expect(client.command.mock.calls[0]?.[0]).toMatchObject({
      query: expect.stringContaining("ALTER TABLE analytics.activity_power_curve"),
    });
  });

  it("fails loudly when table introspection returns no row", async () => {
    const client = new TestClickHouseClient(undefined);

    await expect(createMigration().run?.(client, "postgres://unused")).rejects.toThrow(
      "Expected one ClickHouse table count row",
    );
  });
});
