import { describe, expect, it } from "vitest";
import { createMigration } from "./0062_daily_recovery_baseline_context.ts";

describe("0062_daily_recovery_baseline_context", () => {
  it("adds canonical baseline context to both daily recovery serving tables", () => {
    const migration = createMigration();

    expect(migration.id).toBe("0062_daily_recovery_baseline_context");
    expect(migration.statements).toHaveLength(2);
    for (const statement of migration.statements) {
      expect(statement).toContain("baseline_sample_count");
      expect(statement).toContain("baseline_coverage");
      expect(statement).toContain("mean_7d");
      expect(statement).toContain("mean_previous_28d");
      expect(statement).toContain("efficiency_mean_30d");
      expect(statement).toContain("efficiency_sd_30d");
    }
    expect(migration.statements[1]).toContain("hrv_z_score");
    expect(migration.statements[1]).toContain("resting_hr_z_score");
    expect(migration.statements[1]).toContain("respiratory_rate_z_score");
    expect(migration.statements[1]).toContain("efficiency_z_score");
  });
});
