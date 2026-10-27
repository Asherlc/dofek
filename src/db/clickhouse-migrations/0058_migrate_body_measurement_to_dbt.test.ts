import { describe, expect, it, vi } from "vitest";
import { createMigration } from "./0058_migrate_body_measurement_to_dbt.ts";

describe("0058_migrate_body_measurement_to_dbt", () => {
  it("bootstraps the dbt table before replacing the existing serving view", async () => {
    const command = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockReturnValue({
      json: vi.fn().mockResolvedValue([{ count: 1 }]),
    });
    const migration = createMigration();

    await migration.run?.({ command, query }, "postgres://test");

    expect(migration.id).toBe("0058_migrate_body_measurement_to_dbt");
    expect(query).toHaveBeenCalledWith({
      query: `SELECT count() AS count
FROM system.tables
WHERE database = {database:String}
  AND name = {name:String}`,
      query_params: { database: "analytics", name: "v_body_measurement" },
      format: "JSONEachRow",
    });
    expect(command.mock.calls.map(([options]) => options.query)).toEqual([
      expect.stringContaining("CREATE TABLE IF NOT EXISTS analytics.body_measurement"),
      expect.stringContaining("INSERT INTO analytics.body_measurement"),
      "DROP VIEW IF EXISTS analytics.v_body_measurement",
      "DROP TABLE IF EXISTS analytics.v_body_measurement",
      expect.stringContaining("CREATE VIEW IF NOT EXISTS analytics.v_body_measurement"),
    ]);
  });

  it("creates an empty canonical table when no legacy view exists", async () => {
    const command = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockReturnValue({
      json: vi.fn().mockResolvedValue([{ count: 0 }]),
    });
    const migration = createMigration();

    await migration.run?.({ command, query }, "postgres://test");

    expect(command.mock.calls.map(([options]) => options.query)).not.toEqual(
      expect.arrayContaining([expect.stringContaining("INSERT INTO analytics.body_measurement")]),
    );
    expect(command.mock.calls.at(-1)?.[0].query).toContain(
      "CREATE VIEW IF NOT EXISTS analytics.v_body_measurement",
    );
  });

  it("requires a query-capable migration client", async () => {
    const migration = createMigration();

    await expect(
      migration.run?.({ command: vi.fn().mockResolvedValue(undefined) }, "postgres://test"),
    ).rejects.toThrow("ClickHouse migrations require a query-capable client");
  });

  it("rejects a missing object-existence result row", async () => {
    const query = vi.fn().mockReturnValue({
      json: vi.fn().mockResolvedValue([]),
    });
    const migration = createMigration();

    await expect(
      migration.run?.({ command: vi.fn().mockResolvedValue(undefined), query }, "postgres://test"),
    ).rejects.toThrow();
  });
});
