import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  acwrCte,
  bodyWeightDedupCte,
  heartRateZoneColumns,
  restingHeartRateLateral,
  sleepDedupCte,
  vitalsBaselineCte,
} from "./sql-fragments.ts";

describe("sleepDedupCte", () => {
  it("returns a SQL object with queryChunks", () => {
    const result = sleepDedupCte("user-1", "America/New_York", "2026-03-23", 30);
    expect(result.queryChunks).toBeDefined();
  });

  it("embeds userId and timezone in query chunks", () => {
    const result = sleepDedupCte("user-1", "America/New_York", "2026-03-23", 30);
    const chunks = JSON.stringify(result.queryChunks);
    expect(chunks).toContain("user-1");
    expect(chunks).toContain("America/New_York");
  });

  it("produces different SQL for different day values", () => {
    const fragmentA = sleepDedupCte("user-1", "UTC", "2026-03-23", 30);
    const fragmentB = sleepDedupCte("user-1", "UTC", "2026-03-23", 90);
    expect(fragmentA).not.toEqual(fragmentB);
  });

  it("includes both sleep_raw and sleep_deduped CTE names", () => {
    const result = sleepDedupCte("user-1", "UTC", "2026-03-23", 30);
    const chunks = JSON.stringify(result.queryChunks);
    expect(chunks).toContain("sleep_raw");
    expect(chunks).toContain("sleep_deduped");
  });
});

describe("bodyWeightDedupCte", () => {
  it("returns a SQL object with queryChunks", () => {
    const result = bodyWeightDedupCte("user-1", "UTC", "2026-03-23", 90);
    expect(result.queryChunks).toBeDefined();
  });

  it("embeds userId in query chunks", () => {
    const result = bodyWeightDedupCte("user-1", "UTC", "2026-03-23", 90);
    const chunks = JSON.stringify(result.queryChunks);
    expect(chunks).toContain("user-1");
  });

  it("includes the additional filter when provided", () => {
    const withFilter = bodyWeightDedupCte(
      "user-1",
      "UTC",
      "2026-03-23",
      90,
      sql`AND body_fat_pct IS NOT NULL`,
    );
    const without = bodyWeightDedupCte("user-1", "UTC", "2026-03-23", 90);
    expect(withFilter).not.toEqual(without);
  });

  it("includes weight_deduped CTE name", () => {
    const result = bodyWeightDedupCte("user-1", "UTC", "2026-03-23", 90);
    const chunks = JSON.stringify(result.queryChunks);
    expect(chunks).toContain("weight_deduped");
  });
});

describe("acwrCte", () => {
  it("returns a SQL object with queryChunks", () => {
    const result = acwrCte("user-1", "UTC", "2026-03-23", 30);
    expect(result.queryChunks).toBeDefined();
  });

  it("embeds userId in query chunks", () => {
    const result = acwrCte("user-1", "UTC", "2026-03-23", 30);
    const chunks = JSON.stringify(result.queryChunks);
    expect(chunks).toContain("user-1");
  });

  it("includes all five CTE names", () => {
    const result = acwrCte("user-1", "UTC", "2026-03-23", 30);
    const chunks = JSON.stringify(result.queryChunks);
    expect(chunks).toContain("acwr_date_series");
    expect(chunks).toContain("acwr_per_activity");
    expect(chunks).toContain("acwr_activity_load");
    expect(chunks).toContain("acwr_daily");
    expect(chunks).toContain("acwr_with_windows");
  });

  it("produces different SQL for different day values", () => {
    const fragmentA = acwrCte("user-1", "UTC", "2026-03-23", 7);
    const fragmentB = acwrCte("user-1", "UTC", "2026-03-23", 28);
    expect(fragmentA).not.toEqual(fragmentB);
  });
});

describe("vitalsBaselineCte", () => {
  it("returns a SQL object with queryChunks", () => {
    const result = vitalsBaselineCte("user-1", "2026-03-23", 30, 30);
    expect(result.queryChunks).toBeDefined();
  });

  it("embeds userId in query chunks", () => {
    const result = vitalsBaselineCte("user-1", "2026-03-23", 30, 30);
    const chunks = JSON.stringify(result.queryChunks);
    expect(chunks).toContain("user-1");
  });

  it("includes vitals_baseline CTE name", () => {
    const result = vitalsBaselineCte("user-1", "2026-03-23", 30, 30);
    const chunks = JSON.stringify(result.queryChunks);
    expect(chunks).toContain("vitals_baseline");
  });

  it("uses the correct window size in column names", () => {
    const result = vitalsBaselineCte("user-1", "2026-03-23", 30, 60);
    const chunks = JSON.stringify(result.queryChunks);
    expect(chunks).toContain("hrv_mean_60d");
    expect(chunks).toContain("hrv_stddev_60d");
    expect(chunks).toContain("resting_hr_mean_60d");
    expect(chunks).toContain("resting_hr_stddev_60d");
  });

  it("produces different SQL for different window sizes", () => {
    const fragmentA = vitalsBaselineCte("user-1", "2026-03-23", 30, 30);
    const fragmentB = vitalsBaselineCte("user-1", "2026-03-23", 30, 60);
    expect(fragmentA).not.toEqual(fragmentB);
  });
});

describe("heartRateZoneColumns", () => {
  const heartRate = sql`ms.heart_rate`;
  const maxHr = sql`up.max_hr`;
  const restingHr = sql`rhr.resting_hr`;
  const boundaries = [0.5, 0.6, 0.7, 0.8, 0.9] as const;

  it("returns an object with all five zone keys", () => {
    const zones = heartRateZoneColumns(heartRate, maxHr, restingHr, boundaries);
    expect(zones).toHaveProperty("zone1");
    expect(zones).toHaveProperty("zone2");
    expect(zones).toHaveProperty("zone3");
    expect(zones).toHaveProperty("zone4");
    expect(zones).toHaveProperty("zone5");
  });

  it("each zone is a SQL object", () => {
    const zones = heartRateZoneColumns(heartRate, maxHr, restingHr, boundaries);
    for (const zone of Object.values(zones)) {
      expect(zone.queryChunks).toBeDefined();
    }
  });

  it("produces different SQL for different boundaries", () => {
    const zonesA = heartRateZoneColumns(heartRate, maxHr, restingHr, [0.5, 0.6, 0.7, 0.8, 0.9]);
    const zonesB = heartRateZoneColumns(heartRate, maxHr, restingHr, [0.4, 0.55, 0.7, 0.85, 0.95]);
    expect(zonesA.zone1).not.toEqual(zonesB.zone1);
  });
});

describe("restingHeartRateLateral", () => {
  it("returns a SQL object with queryChunks", () => {
    const result = restingHeartRateLateral(sql`up.id`, sql`a.started_at::date`);
    expect(result.queryChunks).toBeDefined();
  });

  it("includes LATERAL and rhr alias", () => {
    const result = restingHeartRateLateral(sql`up.id`, sql`a.started_at::date`);
    const chunks = JSON.stringify(result.queryChunks);
    expect(chunks).toContain("LATERAL");
    expect(chunks).toContain("rhr");
  });
});
