import { describe, expect, it, vi } from "vitest";
import { StressRepository } from "./stress-repository.ts";

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    date: "2024-01-15",
    hrv: null,
    resting_hr: null,
    hrv_mean_60d: null,
    hrv_sd_60d: null,
    rhr_mean_60d: null,
    rhr_sd_60d: null,
    efficiency_pct: null,
    ...overrides,
  };
}

function makeDb(metricsRows: Record<string, unknown>[] = []) {
  const execute = vi
    .fn()
    .mockResolvedValueOnce(metricsRows) // metrics + sleep query
    .mockResolvedValueOnce([]); // loadPersonalizedParams query (empty = use defaults)
  return { execute };
}

describe("StressRepository", () => {
  describe("getStressScores", () => {
    // ── Empty data ────────────────────────────────────────────────
    it("returns empty result when no data", async () => {
      const db = makeDb([]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily).toEqual([]);
      expect(result.weekly).toEqual([]);
      expect(result.latestScore).toBeNull();
      expect(result.trend).toBe("stable");
    });

    // ── HRV deviation computation ────────────────────────────────
    it("computes HRV deviation as z-score", async () => {
      const db = makeDb([makeRow({ hrv: 50, hrv_mean_60d: 60, hrv_sd_60d: 5 })]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      // (50 - 60) / 5 = -2.0
      expect(result.daily[0]?.hrvDeviation).toBe(-2.0);
    });

    it("returns null hrvDeviation when hrv is null", async () => {
      const db = makeDb([makeRow({ hrv: null, hrv_mean_60d: 60, hrv_sd_60d: 5 })]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.hrvDeviation).toBeNull();
    });

    it("returns null hrvDeviation when hrv_mean_60d is null", async () => {
      const db = makeDb([makeRow({ hrv: 50, hrv_mean_60d: null, hrv_sd_60d: 5 })]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.hrvDeviation).toBeNull();
    });

    it("returns null hrvDeviation when hrv_sd_60d is null", async () => {
      const db = makeDb([makeRow({ hrv: 50, hrv_mean_60d: 60, hrv_sd_60d: null })]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.hrvDeviation).toBeNull();
    });

    it("returns null hrvDeviation when hrv_sd_60d is zero (division by zero guard)", async () => {
      const db = makeDb([makeRow({ hrv: 60, hrv_mean_60d: 60, hrv_sd_60d: 0 })]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.hrvDeviation).toBeNull();
    });

    it("returns null hrvDeviation when hrv_sd_60d is negative", async () => {
      const db = makeDb([makeRow({ hrv: 50, hrv_mean_60d: 60, hrv_sd_60d: -1 })]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.hrvDeviation).toBeNull();
    });

    it("rounds HRV deviation to 2 decimal places", async () => {
      // (45 - 60) / 7 = -2.142857... → -2.14
      const db = makeDb([makeRow({ hrv: 45, hrv_mean_60d: 60, hrv_sd_60d: 7 })]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.hrvDeviation).toBe(-2.14);
    });

    it("computes positive HRV deviation when hrv is above baseline", async () => {
      // (70 - 60) / 5 = 2.0
      const db = makeDb([makeRow({ hrv: 70, hrv_mean_60d: 60, hrv_sd_60d: 5 })]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.hrvDeviation).toBe(2.0);
    });

    // ── Resting HR deviation computation ─────────────────────────
    it("computes resting HR deviation as z-score", async () => {
      // (70 - 60) / 5 = 2.0
      const db = makeDb([makeRow({ resting_hr: 70, rhr_mean_60d: 60, rhr_sd_60d: 5 })]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.restingHrDeviation).toBe(2.0);
    });

    it("returns null restingHrDeviation when resting_hr is null", async () => {
      const db = makeDb([makeRow({ resting_hr: null, rhr_mean_60d: 60, rhr_sd_60d: 5 })]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.restingHrDeviation).toBeNull();
    });

    it("returns null restingHrDeviation when rhr_mean_60d is null", async () => {
      const db = makeDb([makeRow({ resting_hr: 70, rhr_mean_60d: null, rhr_sd_60d: 5 })]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.restingHrDeviation).toBeNull();
    });

    it("returns null restingHrDeviation when rhr_sd_60d is null", async () => {
      const db = makeDb([makeRow({ resting_hr: 70, rhr_mean_60d: 60, rhr_sd_60d: null })]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.restingHrDeviation).toBeNull();
    });

    it("returns null restingHrDeviation when rhr_sd_60d is zero", async () => {
      const db = makeDb([makeRow({ resting_hr: 70, rhr_mean_60d: 60, rhr_sd_60d: 0 })]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.restingHrDeviation).toBeNull();
    });

    it("returns null restingHrDeviation when rhr_sd_60d is negative", async () => {
      const db = makeDb([makeRow({ resting_hr: 70, rhr_mean_60d: 60, rhr_sd_60d: -2 })]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.restingHrDeviation).toBeNull();
    });

    it("rounds resting HR deviation to 2 decimal places", async () => {
      // (67 - 60) / 3 = 2.33333... → 2.33
      const db = makeDb([makeRow({ resting_hr: 67, rhr_mean_60d: 60, rhr_sd_60d: 3 })]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.restingHrDeviation).toBe(2.33);
    });

    it("computes negative resting HR deviation when HR is below baseline", async () => {
      // (55 - 60) / 5 = -1.0
      const db = makeDb([makeRow({ resting_hr: 55, rhr_mean_60d: 60, rhr_sd_60d: 5 })]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.restingHrDeviation).toBe(-1.0);
    });

    // ── Sleep efficiency ────────────────────────────────────────
    it("rounds sleep efficiency to 1 decimal", async () => {
      const db = makeDb([makeRow({ efficiency_pct: 87.456 })]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.sleepEfficiency).toBe(87.5);
    });

    it("returns null sleepEfficiency when efficiency_pct is null", async () => {
      const db = makeDb([makeRow({ efficiency_pct: null })]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.sleepEfficiency).toBeNull();
    });

    it("passes through integer sleep efficiency unchanged", async () => {
      const db = makeDb([makeRow({ efficiency_pct: 90 })]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.sleepEfficiency).toBe(90);
    });

    // ── Date passthrough ────────────────────────────────────────
    it("preserves the date from the row in daily output", async () => {
      const db = makeDb([makeRow({ date: "2024-03-10" })]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-03-10");
      expect(result.daily[0]?.date).toBe("2024-03-10");
    });

    // ── Stress score computation ────────────────────────────────
    it("computes stress score from deviations and efficiency", async () => {
      // Default thresholds: hrvThresholds [-1.5, -1.0, -0.5], rhrThresholds [1.5, 1.0, 0.5]
      // HRV: (40-60)/10 = -2.0 → < -1.5 → hrvStress = 1.5
      // RHR: (70-60)/5 = 2.0 → > 1.5 → rhrStress = 1.0
      // Sleep: 75% < 80% → sleepStress = 0.3
      // Total = 1.5 + 1.0 + 0.3 = 2.8
      const db = makeDb([
        makeRow({
          hrv: 40,
          hrv_mean_60d: 60,
          hrv_sd_60d: 10,
          resting_hr: 70,
          rhr_mean_60d: 60,
          rhr_sd_60d: 5,
          efficiency_pct: 75,
        }),
      ]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.stressScore).toBe(2.8);
    });

    it("returns zero stress score when all metrics are null", async () => {
      const db = makeDb([makeRow()]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.stressScore).toBe(0);
    });

    it("returns zero stress when HRV is above baseline (positive deviation)", async () => {
      const db = makeDb([makeRow({ hrv: 70, hrv_mean_60d: 60, hrv_sd_60d: 10 })]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.stressScore).toBe(0);
    });

    it("returns zero stress when RHR is below baseline (negative deviation)", async () => {
      const db = makeDb([makeRow({ resting_hr: 55, rhr_mean_60d: 60, rhr_sd_60d: 5 })]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.stressScore).toBe(0);
    });

    it("returns zero stress when sleep efficiency is good (>= 85%)", async () => {
      const db = makeDb([makeRow({ efficiency_pct: 90 })]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.stressScore).toBe(0);
    });

    it("caps stress score at 3.0", async () => {
      // HRV: (10-60)/10 = -5.0 → < -2.0 → 1.5
      // RHR: (90-60)/5 = 6.0 → > 2.0 → 1.0
      // Sleep: 50% < 70% → 0.5
      // Total = 3.0 (capped)
      const db = makeDb([
        makeRow({
          hrv: 10,
          hrv_mean_60d: 60,
          hrv_sd_60d: 10,
          resting_hr: 90,
          rhr_mean_60d: 60,
          rhr_sd_60d: 5,
          efficiency_pct: 50,
        }),
      ]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.stressScore).toBe(3);
    });

    // ── latestScore ─────────────────────────────────────────────
    it("sets latestScore to last day's stressScore", async () => {
      const db = makeDb([
        makeRow({
          date: "2024-01-14",
          hrv: 60,
          hrv_mean_60d: 60,
          hrv_sd_60d: 5,
          resting_hr: 54,
          rhr_mean_60d: 54,
          rhr_sd_60d: 3,
          efficiency_pct: 90,
        }),
        makeRow({
          date: "2024-01-15",
          hrv: 45,
          hrv_mean_60d: 60,
          hrv_sd_60d: 5,
          resting_hr: 62,
          rhr_mean_60d: 54,
          rhr_sd_60d: 3,
          efficiency_pct: 75,
        }),
      ]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.latestScore).toBe(result.daily[result.daily.length - 1]?.stressScore);
      // Verify it's specifically the LAST entry, not the first
      expect(result.latestScore).not.toBe(result.daily[0]?.stressScore);
    });

    it("returns null latestScore when daily is empty", async () => {
      const db = makeDb([]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.latestScore).toBeNull();
    });

    it("sets latestScore for a single row", async () => {
      const db = makeDb([
        makeRow({
          date: "2024-01-15",
          hrv: 40,
          hrv_mean_60d: 60,
          hrv_sd_60d: 10,
        }),
      ]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.latestScore).toBe(result.daily[0]?.stressScore);
      expect(result.latestScore).toBeTypeOf("number");
    });

    // ── Weekly aggregation ──────────────────────────────────────
    it("returns weekly aggregation from daily data", async () => {
      // 7 days = should produce at least one weekly bucket
      const rows = Array.from({ length: 7 }, (_, index) =>
        makeRow({
          date: `2024-01-${String(8 + index).padStart(2, "0")}`,
          hrv: 30,
          hrv_mean_60d: 60,
          hrv_sd_60d: 10,
        }),
      );
      const db = makeDb(rows);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.weekly.length).toBeGreaterThan(0);
      expect(result.weekly[0]).toHaveProperty("weekStart");
      expect(result.weekly[0]).toHaveProperty("cumulativeStress");
      expect(result.weekly[0]).toHaveProperty("avgDailyStress");
      expect(result.weekly[0]).toHaveProperty("highStressDays");
    });

    // ── Trend computation ───────────────────────────────────────
    it("returns stable trend for fewer than 14 days", async () => {
      const rows = Array.from({ length: 5 }, (_, index) =>
        makeRow({ date: `2024-01-${String(11 + index).padStart(2, "0")}` }),
      );
      const db = makeDb(rows);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.trend).toBe("stable");
    });

    it("returns improving trend when stress decreases over 14+ days", async () => {
      const rows = [
        // First 7 days: high stress
        ...Array.from({ length: 7 }, (_, index) =>
          makeRow({
            date: `2024-01-${String(1 + index).padStart(2, "0")}`,
            hrv: 20,
            hrv_mean_60d: 60,
            hrv_sd_60d: 10,
            resting_hr: 80,
            rhr_mean_60d: 60,
            rhr_sd_60d: 5,
            efficiency_pct: 60,
          }),
        ),
        // Last 7 days: no stress
        ...Array.from({ length: 7 }, (_, index) =>
          makeRow({
            date: `2024-01-${String(8 + index).padStart(2, "0")}`,
          }),
        ),
      ];
      const db = makeDb(rows);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.trend).toBe("improving");
    });

    it("returns worsening trend when stress increases over 14+ days", async () => {
      const rows = [
        // First 7 days: no stress
        ...Array.from({ length: 7 }, (_, index) =>
          makeRow({
            date: `2024-01-${String(1 + index).padStart(2, "0")}`,
          }),
        ),
        // Last 7 days: high stress
        ...Array.from({ length: 7 }, (_, index) =>
          makeRow({
            date: `2024-01-${String(8 + index).padStart(2, "0")}`,
            hrv: 20,
            hrv_mean_60d: 60,
            hrv_sd_60d: 10,
            resting_hr: 80,
            rhr_mean_60d: 60,
            rhr_sd_60d: 5,
            efficiency_pct: 60,
          }),
        ),
      ];
      const db = makeDb(rows);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.trend).toBe("worsening");
    });

    // ── Return object structure ─────────────────────────────────
    it("returns all four properties in the result object", async () => {
      const db = makeDb([makeRow()]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result).toHaveProperty("daily");
      expect(result).toHaveProperty("weekly");
      expect(result).toHaveProperty("latestScore");
      expect(result).toHaveProperty("trend");
      expect(Array.isArray(result.daily)).toBe(true);
      expect(Array.isArray(result.weekly)).toBe(true);
    });

    it("each daily row has all required properties", async () => {
      const db = makeDb([
        makeRow({
          hrv: 50,
          hrv_mean_60d: 60,
          hrv_sd_60d: 10,
          resting_hr: 65,
          rhr_mean_60d: 60,
          rhr_sd_60d: 5,
          efficiency_pct: 85,
        }),
      ]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      const row = result.daily[0];
      expect(row).toHaveProperty("date");
      expect(row).toHaveProperty("stressScore");
      expect(row).toHaveProperty("hrvDeviation");
      expect(row).toHaveProperty("restingHrDeviation");
      expect(row).toHaveProperty("sleepEfficiency");
      expect(row?.date).toBeTypeOf("string");
      expect(row?.stressScore).toBeTypeOf("number");
    });

    // ── Database call count ─────────────────────────────────────
    it("calls execute twice (metrics + params)", async () => {
      const db = makeDb([]);
      const repo = new StressRepository(db, "user-1", "UTC");
      await repo.getStressScores(90, "2024-01-15");
      expect(db.execute).toHaveBeenCalledTimes(2);
    });

    // ── Multiple rows processing ────────────────────────────────
    it("processes multiple rows and preserves order", async () => {
      const db = makeDb([
        makeRow({ date: "2024-01-14", hrv: 50, hrv_mean_60d: 60, hrv_sd_60d: 10 }),
        makeRow({ date: "2024-01-15", hrv: 55, hrv_mean_60d: 60, hrv_sd_60d: 10 }),
      ]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily).toHaveLength(2);
      expect(result.daily[0]?.date).toBe("2024-01-14");
      expect(result.daily[1]?.date).toBe("2024-01-15");
    });

    // ── Combined deviations ─────────────────────────────────────
    it("computes both HRV and RHR deviations in the same row", async () => {
      const db = makeDb([
        makeRow({
          hrv: 50,
          hrv_mean_60d: 60,
          hrv_sd_60d: 10,
          resting_hr: 65,
          rhr_mean_60d: 60,
          rhr_sd_60d: 5,
        }),
      ]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      // HRV: (50-60)/10 = -1.0
      expect(result.daily[0]?.hrvDeviation).toBe(-1.0);
      // RHR: (65-60)/5 = 1.0
      expect(result.daily[0]?.restingHrDeviation).toBe(1.0);
    });

    // ── String coercion from DB ─────────────────────────────────
    it("handles string values from database (coerced by schema)", async () => {
      const db = makeDb([
        makeRow({
          hrv: "45",
          hrv_mean_60d: "60",
          hrv_sd_60d: "10",
          resting_hr: "65",
          rhr_mean_60d: "60",
          rhr_sd_60d: "5",
          efficiency_pct: "85.5",
        }),
      ]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.hrvDeviation).toBe(-1.5);
      expect(result.daily[0]?.restingHrDeviation).toBe(1.0);
      expect(result.daily[0]?.sleepEfficiency).toBe(85.5);
    });
  });
});
