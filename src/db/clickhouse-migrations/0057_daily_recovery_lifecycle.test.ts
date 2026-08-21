import { describe, expect, it } from "vitest";
import { createMigration } from "./0057_daily_recovery_lifecycle.ts";

describe("0057_daily_recovery_lifecycle", () => {
  it("adds deletion markers to both recovery lifecycle tables", () => {
    const migration = createMigration();

    expect(migration).toEqual({
      id: "0057_daily_recovery_lifecycle",
      statements: [
        expect.stringContaining("ALTER TABLE analytics.daily_recovery_inputs"),
        expect.stringContaining("ALTER TABLE analytics.daily_recovery"),
      ],
    });
    expect(migration.statements).toEqual([
      expect.stringContaining("is_deleted UInt8 DEFAULT 0"),
      expect.stringContaining("is_deleted UInt8 DEFAULT 0"),
    ]);
  });
});
