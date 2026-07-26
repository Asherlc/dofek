import { describe, expect, it, vi } from "vitest";
import { createMigration } from "./0055_bound_body_measurement_refresh.ts";

describe("0055_migrate_body_measurement_to_dbt", () => {
  it("bootstraps the dbt table before replacing the existing serving view", async () => {
    const command = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockReturnValue({
      json: vi.fn().mockResolvedValue([{ count: 1 }]),
    });
    const migration = createMigration();

    await migration.run?.({ command, query }, "postgres://test");

    expect(migration.id).toBe("0055_migrate_body_measurement_to_dbt");
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
});
