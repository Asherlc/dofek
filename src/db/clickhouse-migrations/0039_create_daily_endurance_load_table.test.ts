import { describe, expect, it } from "vitest";
import { createMigration } from "./0039_create_daily_endurance_load_table.ts";

describe("0039_create_daily_endurance_load_table", () => {
  it("creates the daily endurance load table migration", () => {
    const migration = createMigration();

    expect(migration.id).toBe("0039_create_daily_endurance_load_table");
    expect(migration.statements).toHaveLength(1);
    expect(migration.statements[0]).toContain(
      "CREATE TABLE IF NOT EXISTS analytics.daily_endurance_load",
    );
    expect(migration.statements[0]).toContain("training_load Float64");
    expect(migration.statements[0]).toContain("ORDER BY (user_id, activity_id)");
  });
});
