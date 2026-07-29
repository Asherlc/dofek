import { describe, expect, it, vi } from "vitest";
import { StressRepository } from "./stress-repository.ts";

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    date: "2024-01-15",
    hrv_z_score: null,
    resting_hr_z_score: null,
    efficiency_pct: null,
    ...overrides,
  };
}

let latestRowsForSensorStore: Record<string, unknown>[] = [];

function makeDb(metricsRows: Record<string, unknown>[] = []) {
  latestRowsForSensorStore = metricsRows;
  const execute = vi.fn().mockResolvedValue([]); // loadPersonalizedParams query (empty = use defaults)
  return { execute };
}

function makeSensorStore(rows: Record<string, unknown>[] = latestRowsForSensorStore) {
  return {
    query: vi.fn().mockResolvedValue(rows),
  };
}

describe("StressRepository", () => {
  describe("getStressScores", () => {
    // ── Empty data ────────────────────────────────────────────────
    it("returns empty result when no data", async () => {
      const db = makeDb([]);
      const repo = new StressRepository(db, "user-1", "UTC", makeSensorStore());
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily).toEqual([]);
      expect(result.weekly).toEqual([]);
      expect(result.latestScore).toBeNull();
      expect(result.trend).toBe("stable");
    });

    it("reads compact daily recovery inputs from ClickHouse", async () => {
      const db = makeDb([]);
      const sensorStore = makeSensorStore([]);
      const repo = new StressRepository(db, "user-1", "UTC", sensorStore);

      await repo.getStressScores(90, "2024-01-15");

      const queryText = sensorStore.query.mock.calls[0]?.[1];
      expect(queryText).toContain("analytics.daily_recovery AS recovery_inputs FINAL");
      expect(queryText).toContain("recovery_inputs.is_deleted = 0");
      expect(queryText).toContain("hrv_z_score");
      expect(queryText).toContain("resting_hr_z_score");
      expect(queryText).not.toContain("hrv_mean_60d");
      expect(queryText).not.toContain("fitness.v_daily_metrics");
      expect(queryText).not.toContain("analytics.v_sleep");
    });

    it("uses the canonical HRV z-score", async () => {
      const db = makeDb([makeRow({ hrv_z_score: -2 })]);
      const repo = new StressRepository(db, "user-1", "UTC", makeSensorStore());
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.hrvDeviation).toBe(-2.0);
    });

    it("returns null hrvDeviation when the canonical z-score is null", async () => {
      const db = makeDb([makeRow({ hrv_z_score: null })]);
      const repo = new StressRepository(db, "user-1", "UTC", makeSensorStore());
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.hrvDeviation).toBeNull();
    });

    it("rounds HRV deviation to 2 decimal places", async () => {
      const db = makeDb([makeRow({ hrv_z_score: -2.142857 })]);
      const repo = new StressRepository(db, "user-1", "UTC", makeSensorStore());
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.hrvDeviation).toBe(-2.14);
    });

    it("computes positive HRV deviation when hrv is above baseline", async () => {
      const db = makeDb([makeRow({ hrv_z_score: 2 })]);
      const repo = new StressRepository(db, "user-1", "UTC", makeSensorStore());
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.hrvDeviation).toBe(2.0);
    });

    it("uses the canonical resting-HR z-score", async () => {
      const db = makeDb([makeRow({ resting_hr_z_score: 2 })]);
      const repo = new StressRepository(db, "user-1", "UTC", makeSensorStore());
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.restingHrDeviation).toBe(2.0);
    });

    it("returns null restingHrDeviation when the canonical z-score is null", async () => {
      const db = makeDb([makeRow({ resting_hr_z_score: null })]);
      const repo = new StressRepository(db, "user-1", "UTC", makeSensorStore());
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.restingHrDeviation).toBeNull();
    });

    it("rounds resting HR deviation to 2 decimal places", async () => {
      const db = makeDb([makeRow({ resting_hr_z_score: 2.33333 })]);
      const repo = new StressRepository(db, "user-1", "UTC", makeSensorStore());
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.restingHrDeviation).toBe(2.33);
    });

    it("computes negative resting HR deviation when HR is below baseline", async () => {
      const db = makeDb([makeRow({ resting_hr_z_score: -1 })]);
      const repo = new StressRepository(db, "user-1", "UTC", makeSensorStore());
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.restingHrDeviation).toBe(-1.0);
    });

    // ── Sleep efficiency ────────────────────────────────────────
    it("rounds sleep efficiency to 1 decimal", async () => {
      const db = makeDb([makeRow({ efficiency_pct: 87.456 })]);
      const repo = new StressRepository(db, "user-1", "UTC", makeSensorStore());
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.sleepEfficiency).toBe(87.5);
    });

    it("returns null sleepEfficiency when efficiency_pct is null", async () => {
      const db = makeDb([makeRow({ efficiency_pct: null })]);
      const repo = new StressRepository(db, "user-1", "UTC", makeSensorStore());
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.sleepEfficiency).toBeNull();
    });

    it("passes through integer sleep efficiency unchanged", async () => {
      const db = makeDb([makeRow({ efficiency_pct: 90 })]);
      const repo = new StressRepository(db, "user-1", "UTC", makeSensorStore());
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.sleepEfficiency).toBe(90);
    });

    // ── Date passthrough ────────────────────────────────────────
    it("preserves the date from the row in daily output", async () => {
      const db = makeDb([makeRow({ date: "2024-03-10" })]);
      const repo = new StressRepository(db, "user-1", "UTC", makeSensorStore());
      const result = await repo.getStressScores(90, "2024-03-10");
      expect(result.daily[0]?.date).toBe("2024-03-10");
    });

    // ── Stress score computation ────────────────────────────────
    it("computes stress score from deviations and efficiency", async () => {
      // Default thresholds: hrvThresholds [-1.5, -1.0, -0.5], rhrThresholds [1.5, 1.0, 0.5]
      // HRV z-score -2.0 → < -1.5 → hrvStress = 1.5
      // RHR z-score 2.0 → > 1.5 → rhrStress = 1.0
      // Sleep: 75% < 80% → sleepStress = 0.3
      // Total = 1.5 + 1.0 + 0.3 = 2.8
      const db = makeDb([
        makeRow({
          hrv_z_score: -2,
          resting_hr_z_score: 2,
          efficiency_pct: 75,
        }),
      ]);
      const repo = new StressRepository(db, "user-1", "UTC", makeSensorStore());
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.stressScore).toBe(2.8);
    });

    it("returns zero stress score when all metrics are null", async () => {
      const db = makeDb([makeRow()]);
      const repo = new StressRepository(db, "user-1", "UTC", makeSensorStore());
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.stressScore).toBe(0);
    });

    it("returns zero stress when HRV is above baseline (positive deviation)", async () => {
      const db = makeDb([makeRow({ hrv_z_score: 1 })]);
      const repo = new StressRepository(db, "user-1", "UTC", makeSensorStore());
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.stressScore).toBe(0);
    });

    it("returns zero stress when RHR is below baseline (negative deviation)", async () => {
      const db = makeDb([makeRow({ resting_hr_z_score: -1 })]);
      const repo = new StressRepository(db, "user-1", "UTC", makeSensorStore());
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.stressScore).toBe(0);
    });

    it("returns zero stress when sleep efficiency is good (>= 85%)", async () => {
      const db = makeDb([makeRow({ efficiency_pct: 90 })]);
      const repo = new StressRepository(db, "user-1", "UTC", makeSensorStore());
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.stressScore).toBe(0);
    });

    it("caps stress score at 3.0", async () => {
      // HRV z-score -5.0 → < -2.0 → 1.5
      // RHR z-score 6.0 → > 2.0 → 1.0
      // Sleep: 50% < 70% → 0.5
      // Total = 3.0 (capped)
      const db = makeDb([
        makeRow({
          hrv_z_score: -5,
          resting_hr_z_score: 6,
          efficiency_pct: 50,
        }),
      ]);
      const repo = new StressRepository(db, "user-1", "UTC", makeSensorStore());
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.stressScore).toBe(3);
    });

    // ── latestScore ─────────────────────────────────────────────
    it("sets latestScore to last day's stressScore", async () => {
      const db = makeDb([
        makeRow({
          date: "2024-01-14",
          hrv_z_score: 0,
          resting_hr_z_score: 0,
          efficiency_pct: 90,
        }),
        makeRow({
          date: "2024-01-15",
          hrv_z_score: -3,
          resting_hr_z_score: 2.6666667,
          efficiency_pct: 75,
        }),
      ]);
      const repo = new StressRepository(db, "user-1", "UTC", makeSensorStore());
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.latestScore).toBe(result.daily[result.daily.length - 1]?.stressScore);
      // Verify it's specifically the LAST entry, not the first
      expect(result.latestScore).not.toBe(result.daily[0]?.stressScore);
    });

    it("returns null latestScore when daily is empty", async () => {
      const db = makeDb([]);
      const repo = new StressRepository(db, "user-1", "UTC", makeSensorStore());
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.latestScore).toBeNull();
    });

    it("sets latestScore for a single row", async () => {
      const db = makeDb([
        makeRow({
          date: "2024-01-15",
          hrv_z_score: -2,
        }),
      ]);
      const repo = new StressRepository(db, "user-1", "UTC", makeSensorStore());
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
          hrv_z_score: -3,
        }),
      );
      const db = makeDb(rows);
      const repo = new StressRepository(db, "user-1", "UTC", makeSensorStore());
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
      const repo = new StressRepository(db, "user-1", "UTC", makeSensorStore());
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.trend).toBe("stable");
    });

    it("returns improving trend when stress decreases over 14+ days", async () => {
      const rows = [
        // First 7 days: high stress
        ...Array.from({ length: 7 }, (_, index) =>
          makeRow({
            date: `2024-01-${String(1 + index).padStart(2, "0")}`,
            hrv_z_score: -4,
            resting_hr_z_score: 4,
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
      const repo = new StressRepository(db, "user-1", "UTC", makeSensorStore());
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
            hrv_z_score: -4,
            resting_hr_z_score: 4,
            efficiency_pct: 60,
          }),
        ),
      ];
      const db = makeDb(rows);
      const repo = new StressRepository(db, "user-1", "UTC", makeSensorStore());
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.trend).toBe("worsening");
    });

    // ── Return object structure ─────────────────────────────────
    it("returns all four properties in the result object", async () => {
      const db = makeDb([makeRow()]);
      const repo = new StressRepository(db, "user-1", "UTC", makeSensorStore());
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
          hrv_z_score: -1,
          resting_hr_z_score: 1,
          efficiency_pct: 85,
        }),
      ]);
      const repo = new StressRepository(db, "user-1", "UTC", makeSensorStore());
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

    // ── Data-source call count ──────────────────────────────────
    it("queries ClickHouse inputs once and keeps DB access to personalization", async () => {
      const db = makeDb([]);
      const sensorStore = makeSensorStore();
      const repo = new StressRepository(db, "user-1", "UTC", sensorStore);
      await repo.getStressScores(90, "2024-01-15");
      expect(sensorStore.query).toHaveBeenCalledTimes(1);
      expect(db.execute).toHaveBeenCalledTimes(1);
    });

    // ── Multiple rows processing ────────────────────────────────
    it("processes multiple rows and preserves order", async () => {
      const db = makeDb([
        makeRow({ date: "2024-01-14", hrv_z_score: -1 }),
        makeRow({ date: "2024-01-15", hrv_z_score: -0.5 }),
      ]);
      const repo = new StressRepository(db, "user-1", "UTC", makeSensorStore());
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily).toHaveLength(2);
      expect(result.daily[0]?.date).toBe("2024-01-14");
      expect(result.daily[1]?.date).toBe("2024-01-15");
    });

    // ── Combined deviations ─────────────────────────────────────
    it("computes both HRV and RHR deviations in the same row", async () => {
      const db = makeDb([
        makeRow({
          hrv_z_score: -1,
          resting_hr_z_score: 1,
        }),
      ]);
      const repo = new StressRepository(db, "user-1", "UTC", makeSensorStore());
      const result = await repo.getStressScores(90, "2024-01-15");
      // Canonical HRV z-score is -1.0.
      expect(result.daily[0]?.hrvDeviation).toBe(-1.0);
      // Canonical RHR z-score is 1.0.
      expect(result.daily[0]?.restingHrDeviation).toBe(1.0);
    });

    // ── String coercion from DB ─────────────────────────────────
    it("handles string values from database (coerced by schema)", async () => {
      const db = makeDb([
        makeRow({
          hrv_z_score: "-1.5",
          resting_hr_z_score: "1",
          efficiency_pct: "85.5",
        }),
      ]);
      const repo = new StressRepository(db, "user-1", "UTC", makeSensorStore());
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.hrvDeviation).toBe(-1.5);
      expect(result.daily[0]?.restingHrDeviation).toBe(1.0);
      expect(result.daily[0]?.sleepEfficiency).toBe(85.5);
    });
  });
});
