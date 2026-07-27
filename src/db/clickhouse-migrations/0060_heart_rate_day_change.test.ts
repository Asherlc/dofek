import { describe, expect, it } from "vitest";
import { createMigration } from "./0060_heart_rate_day_change.ts";

describe("0060_heart_rate_day_change", () => {
  it("captures compact heart-rate day changes and creates exact sleep state", () => {
    const migration = createMigration();
    const sql = migration.statements.join("\n");

    expect(migration.id).toBe("0060_heart_rate_day_change");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS analytics.heart_rate_day_change");
    expect(sql).toContain(
      "CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.heart_rate_day_change_ingest",
    );
    expect(sql).toContain("FROM analytics.deduped_sensor");
    expect(sql).toContain("WHERE channel = 'heart_rate'");
    expect(sql).toContain("now64(9, 'UTC') AS changed_at");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS analytics.sleep_heart_rate_cutover");
    expect(sql).toContain("INSERT INTO analytics.sleep_heart_rate_cutover");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS analytics.sleep_heart_rate_window");
    expect(sql).toContain("eligible_sample_count UInt64");
    expect(sql).not.toContain("heart_rate_samples");
    expect(sql).not.toContain("INSERT INTO analytics.heart_rate_day_change");
  });
});
