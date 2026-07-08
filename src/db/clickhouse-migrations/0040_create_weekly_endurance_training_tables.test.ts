import { describe, expect, it } from "vitest";
import { createMigration } from "./0040_create_weekly_endurance_training_tables.ts";

describe("0040_create_weekly_endurance_training_tables", () => {
  it("creates weekly ramp rate and training monotony table migrations", () => {
    const migration = createMigration();

    expect(migration.id).toBe("0040_create_weekly_endurance_training_tables");
    expect(migration.statements).toHaveLength(2);
    expect(migration.statements[0]).toContain(
      "CREATE TABLE IF NOT EXISTS analytics.weekly_endurance_ramp_rate",
    );
    expect(migration.statements[0]).toContain("ramp_rate Float64");
    expect(migration.statements[0]).toContain("is_deleted UInt8");
    expect(migration.statements[1]).toContain(
      "CREATE TABLE IF NOT EXISTS analytics.weekly_training_monotony",
    );
    expect(migration.statements[1]).toContain("monotony Float64");
    expect(migration.statements[1]).toContain("is_deleted UInt8");
  });
});
