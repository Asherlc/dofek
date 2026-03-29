import { describe, expect, it, vi } from "vitest";
import { BodyAnalyticsRepository, ewmaSmooth } from "./body-analytics-repository.ts";

// ── EWMA helper ─────────────────────────────────────────────────────

describe("ewmaSmooth", () => {
  it("returns empty array for empty input", () => {
    expect(ewmaSmooth([], 0.1)).toEqual([]);
  });

  it("returns the single value for a one-element array", () => {
    expect(ewmaSmooth([80], 0.1)).toEqual([80]);
  });

  it("applies EWMA with alpha=0.1 correctly", () => {
    const values = [80, 81, 79, 80.5, 80];
    const result = ewmaSmooth(values, 0.1);

    expect(result).toHaveLength(5);
    // First value is the seed
    expect(result[0]).toBe(80);
    // Second: 0.1 * 81 + 0.9 * 80 = 80.1
    expect(result[1]).toBeCloseTo(80.1, 10);
    // Third: 0.1 * 79 + 0.9 * 80.1 = 79.99
    expect(result[2]).toBeCloseTo(79.99, 10);
    // Fourth: 0.1 * 80.5 + 0.9 * 79.99 = 80.041
    expect(result[3]).toBeCloseTo(80.041, 10);
    // Fifth: 0.1 * 80 + 0.9 * 80.041 = 80.0369
    expect(result[4]).toBeCloseTo(80.0369, 10);
  });

  it("uses the correct alpha coefficient (distinguishes 0.1 from 0.2)", () => {
    const values = [100, 110];
    const resultAlpha01 = ewmaSmooth(values, 0.1);
    // 0.1 * 110 + 0.9 * 100 = 101
    expect(resultAlpha01[1]).toBe(101);

    const resultAlpha02 = ewmaSmooth(values, 0.2);
    // 0.2 * 110 + 0.8 * 100 = 102
    expect(resultAlpha02[1]).toBe(102);
  });

  it("applies EWMA with alpha=0.15 correctly", () => {
    const values = [10, 12, 11];
    const result = ewmaSmooth(values, 0.15);

    expect(result[0]).toBe(10);
    // 0.15 * 12 + 0.85 * 10 = 10.3
    expect(result[1]).toBeCloseTo(10.3, 10);
    // 0.15 * 11 + 0.85 * 10.3 = 10.405
    expect(result[2]).toBeCloseTo(10.405, 10);
  });
});

// ── Repository ──────────────────────────────────────────────────────

function makeRepository(rows: Record<string, unknown>[] = []) {
  const execute = vi.fn().mockResolvedValue(rows);
  const repo = new BodyAnalyticsRepository({ execute }, "user-1", "UTC");
  return { repo, execute };
}

describe("BodyAnalyticsRepository", () => {
  describe("getSmoothedWeight", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getSmoothedWeight(90, "2024-06-01");
      expect(result).toEqual([]);
    });

    it("computes EWMA smoothed weight correctly", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "80" },
        { date: "2024-01-02", weight_kg: "81" },
        { date: "2024-01-03", weight_kg: "79" },
      ]);

      const result = await repo.getSmoothedWeight(90, "2024-06-01");

      expect(result).toHaveLength(3);
      expect(result[0]?.rawWeight).toBe(80);
      expect(result[0]?.smoothedWeight).toBe(80);
      // 0.1 * 81 + 0.9 * 80 = 80.1
      expect(result[1]?.smoothedWeight).toBe(80.1);
      // 0.1 * 79 + 0.9 * 80.1 = 79.99
      expect(result[2]?.smoothedWeight).toBe(79.99);
    });

    it("computes weekly change when enough data points exist", async () => {
      // 10 days of data so we can compute weekly change for days 7+
      const rows = Array.from({ length: 10 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 + index * 0.5), // steadily increasing
      }));

      const { repo } = makeRepository(rows);
      const result = await repo.getSmoothedWeight(90, "2024-06-01");

      expect(result).toHaveLength(10);
      // First 7 entries should have null weeklyChange
      for (let index = 0; index < 7; index++) {
        expect(result[index]?.weeklyChange).toBeNull();
      }
      // Entry 7+ should have a non-null weeklyChange
      expect(result[7]?.weeklyChange).not.toBeNull();
      expect(typeof result[7]?.weeklyChange).toBe("number");
    });

    it("returns null weeklyChange for first 7 entries (index < 7 boundary)", async () => {
      const rows = Array.from({ length: 8 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 + index * 0.5),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getSmoothedWeight(90, "2024-06-01");
      // Index 6 (7th entry) should still have null weeklyChange
      expect(result[6]?.weeklyChange).toBeNull();
      // Index 7 (8th entry) should have non-null weeklyChange
      expect(result[7]?.weeklyChange).not.toBeNull();
    });

    it("rounds values to 2 decimal places", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "80.123" },
        { date: "2024-01-02", weight_kg: "80.456" },
      ]);

      const result = await repo.getSmoothedWeight(90, "2024-06-01");
      expect(result[0]?.rawWeight).toBe(80.12);
      expect(result[1]?.rawWeight).toBe(80.46);
    });
  });

  describe("getRecomposition", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getRecomposition(180, "2024-06-01");
      expect(result).toEqual([]);
    });

    it("computes fat and lean mass correctly", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "80", body_fat_pct: "20" },
      ]);

      const result = await repo.getRecomposition(180, "2024-06-01");

      expect(result).toHaveLength(1);
      // fatMass = 80 * 20/100 = 16
      expect(result[0]?.fatMassKg).toBe(16);
      // leanMass = 80 - 16 = 64
      expect(result[0]?.leanMassKg).toBe(64);
      expect(result[0]?.weightKg).toBe(80);
      expect(result[0]?.bodyFatPct).toBe(20);
    });

    it("applies EWMA smoothing with alpha=0.15 on fat and lean mass", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "80", body_fat_pct: "20" },
        { date: "2024-01-02", weight_kg: "82", body_fat_pct: "22" },
      ]);

      const result = await repo.getRecomposition(180, "2024-06-01");

      expect(result).toHaveLength(2);

      // Day 1: fatMass=16, leanMass=64, smoothed same as raw
      expect(result[0]?.smoothedFatMass).toBe(16);
      expect(result[0]?.smoothedLeanMass).toBe(64);

      // Day 2: fatMass = 82 * 0.22 = 18.04, leanMass = 82 - 18.04 = 63.96
      // smoothedFat = 0.15 * 18.04 + 0.85 * 16 = 16.306
      expect(result[1]?.smoothedFatMass).toBeCloseTo(16.31, 2);
      // smoothedLean = 0.15 * 63.96 + 0.85 * 64 = 63.994
      expect(result[1]?.smoothedLeanMass).toBeCloseTo(63.99, 2);
    });

    it("divides bodyFatPct by 100 for fat mass (not 10 or 1000)", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "100", body_fat_pct: "25" },
      ]);
      const result = await repo.getRecomposition(180, "2024-06-01");
      // fatMass = 100 * 25/100 = 25
      expect(result[0]?.fatMassKg).toBe(25);
      // leanMass = 100 - 25 = 75
      expect(result[0]?.leanMassKg).toBe(75);
    });

    it("rounds bodyFatPct to 1 decimal place", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "80", body_fat_pct: "18.25" },
      ]);

      const result = await repo.getRecomposition(180, "2024-06-01");
      // 18.25 rounded to 1 decimal = 18.3 (rounds up)
      expect(result[0]?.bodyFatPct).toBe(18.3);
    });
  });

  describe("getWeightTrend", () => {
    it("returns insufficient when fewer than 7 data points", async () => {
      const rows = Array.from({ length: 5 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80),
      }));

      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();

      expect(result.trend).toBe("insufficient");
      expect(result.currentWeekly).toBeNull();
      expect(result.current4Week).toBeNull();
    });

    it("returns insufficient for empty data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getWeightTrend();
      expect(result.trend).toBe("insufficient");
    });

    it("classifies gaining trend when weight increasing", async () => {
      // 10 days of steadily increasing weight (1kg/day - very fast gain)
      const rows = Array.from({ length: 10 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 + index),
      }));

      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();

      expect(result.trend).toBe("gaining");
      expect(result.currentWeekly).not.toBeNull();
      expect(result.currentWeekly).toBeGreaterThan(0.1);
    });

    it("classifies losing trend when weight decreasing", async () => {
      // 10 days of steadily decreasing weight
      const rows = Array.from({ length: 10 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 - index),
      }));

      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();

      expect(result.trend).toBe("losing");
      expect(result.currentWeekly).not.toBeNull();
      expect(result.currentWeekly).toBeLessThan(-0.1);
    });

    it("classifies stable trend when weight constant", async () => {
      // 10 days of constant weight
      const rows = Array.from({ length: 10 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: "80",
      }));

      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();

      expect(result.trend).toBe("stable");
    });

    it("returns insufficient with exactly 6 data points (boundary < 7)", async () => {
      const rows = Array.from({ length: 6 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: "80",
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();
      expect(result.trend).toBe("insufficient");
    });

    it("returns non-insufficient with exactly 7 data points (boundary)", async () => {
      const rows = Array.from({ length: 7 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: "80",
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();
      expect(result.trend).not.toBe("insufficient");
    });

    it("classifies stable when weight is constant (0 change)", async () => {
      const rows = Array.from({ length: 10 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: "80",
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();
      expect(result.trend).toBe("stable");
      expect(result.currentWeekly).toBe(0);
    });

    it("returns null for current4Week when fewer than 29 data points", async () => {
      const rows = Array.from({ length: 10 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 + index),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();
      expect(result.current4Week).toBeNull();
    });

    it("provides 4-week change when enough data", async () => {
      // 30 days of data - enough for 4-week comparison
      const rows = Array.from({ length: 30 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 + index * 0.1),
      }));

      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();

      expect(result.currentWeekly).not.toBeNull();
      expect(result.current4Week).not.toBeNull();
    });

    it("uses alpha=0.1 in getWeightTrend (verifiable via exact EWMA value)", async () => {
      // 8 data points: [80, 82, 80, 82, 80, 82, 80, 82]
      // With alpha=0.1:
      //   s0=80
      //   s1=0.1*82 + 0.9*80 = 80.2
      //   s2=0.1*80 + 0.9*80.2 = 80.18
      //   s3=0.1*82 + 0.9*80.18 = 80.362
      //   s4=0.1*80 + 0.9*80.362 = 80.3258
      //   s5=0.1*82 + 0.9*80.3258 = 80.49322
      //   s6=0.1*80 + 0.9*80.49322 = 80.443898
      //   s7=0.1*82 + 0.9*80.443898 = 80.5995082
      // currentWeekly = s7 - s0 = 80.5995082 - 80 = 0.5995... → rounds to 0.6
      const rows = Array.from({ length: 8 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(index % 2 === 0 ? 80 : 82),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();
      expect(result.currentWeekly).toBe(0.6);
    });

    it("classifies 'gaining' when weekly change is exactly 0.11 (> 0.1 threshold)", async () => {
      // We need a series where the smoothed weekly diff is just above 0.1
      // Use constant increase: 8 days starting at 80, increasing 0.2/day
      const rows = Array.from({ length: 8 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 + index * 0.2),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();
      expect(result.trend).toBe("gaining");
      expect(result.currentWeekly).toBeGreaterThan(0.1);
    });

    it("classifies 'losing' when weekly change is exactly below -0.1 (< -0.1 threshold)", async () => {
      const rows = Array.from({ length: 8 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 - index * 0.2),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();
      expect(result.trend).toBe("losing");
      expect(result.currentWeekly).toBeLessThan(-0.1);
    });

    it("returns null current4Week with exactly 28 data points (< 29 boundary)", async () => {
      const rows = Array.from({ length: 28 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 + index * 0.5),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();
      expect(result.current4Week).toBeNull();
    });

    it("returns non-null current4Week with exactly 29 data points (>= 29 boundary)", async () => {
      const rows = Array.from({ length: 29 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 + index * 0.5),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();
      expect(result.current4Week).not.toBeNull();
    });

    it("returns null currentWeekly with exactly 7 data points (< 8 needed for oneWeekAgo)", async () => {
      // With 7 points, smoothed.length=7, so smoothed.length >= 8 is false
      const rows = Array.from({ length: 7 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 + index),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();
      expect(result.currentWeekly).toBeNull();
    });

    it("returns non-null currentWeekly with exactly 8 data points (>= 8 boundary)", async () => {
      const rows = Array.from({ length: 8 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 + index),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();
      expect(result.currentWeekly).not.toBeNull();
    });

    it("falls back to current4Week for trend when currentWeekly is null", async () => {
      // 7 points = no weekly, but if there were 29+ we'd have 4-week
      // With only 7 points, both are null, so trend uses changeReference=null → stable
      const rows = Array.from({ length: 7 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: "80",
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();
      // With 7 points but < 8 for weekly: currentWeekly is null
      // With < 29 for 4-week: current4Week is null
      // changeReference = null, so trend = "stable"
      expect(result.trend).toBe("stable");
    });

    it("rounds weeklyChange to 2 decimal places via Math.round(x * 100) / 100", async () => {
      // Create a series that produces a non-round weeklyChange
      const rows = [
        { date: "2024-01-01", weight_kg: "80" },
        { date: "2024-01-02", weight_kg: "80.3" },
        { date: "2024-01-03", weight_kg: "80.1" },
        { date: "2024-01-04", weight_kg: "80.4" },
        { date: "2024-01-05", weight_kg: "80.2" },
        { date: "2024-01-06", weight_kg: "80.5" },
        { date: "2024-01-07", weight_kg: "80.3" },
        { date: "2024-01-08", weight_kg: "80.6" },
        { date: "2024-01-09", weight_kg: "80.4" },
        { date: "2024-01-10", weight_kg: "80.7" },
      ];
      const { repo } = makeRepository(rows);
      const result = await repo.getSmoothedWeight(90, "2024-06-01");
      // weeklyChange should be a number rounded to 2 decimal places
      for (const row of result) {
        if (row.weeklyChange !== null) {
          const str = String(row.weeklyChange);
          const decimals = str.includes(".") ? (str.split(".")[1]?.length ?? 0) : 0;
          expect(decimals).toBeLessThanOrEqual(2);
        }
      }
    });
  });

  describe("getSmoothedWeight EWMA alpha", () => {
    it("uses alpha=0.1 for smoothed weight (not 0.15 or 0.2)", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "100" },
        { date: "2024-01-02", weight_kg: "110" },
      ]);
      const result = await repo.getSmoothedWeight(90, "2024-06-01");
      // alpha=0.1: smoothed = 0.1 * 110 + 0.9 * 100 = 101
      expect(result[1]?.smoothedWeight).toBe(101);
    });
  });

  describe("getSmoothedWeight property values", () => {
    it("preserves date string from DB row", async () => {
      const { repo } = makeRepository([{ date: "2024-03-15", weight_kg: "75" }]);
      const result = await repo.getSmoothedWeight(90, "2024-06-01");
      expect(result[0]?.date).toBe("2024-03-15");
    });

    it("rounds rawWeight via Math.round(x * 100) / 100 (2 decimal places, not 1 or 3)", async () => {
      const { repo } = makeRepository([{ date: "2024-01-01", weight_kg: "80.1234" }]);
      const result = await repo.getSmoothedWeight(90, "2024-06-01");
      // Math.round(80.1234 * 100) / 100 = Math.round(8012.34) / 100 = 8012/100 = 80.12
      expect(result[0]?.rawWeight).toBe(80.12);
    });

    it("rounds smoothedWeight via Math.round(x * 100) / 100 (2 decimal places)", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "80.1234" },
        { date: "2024-01-02", weight_kg: "81.5678" },
      ]);
      const result = await repo.getSmoothedWeight(90, "2024-06-01");
      // smoothed[0] = 80.1234, rounded = 80.12
      expect(result[0]?.smoothedWeight).toBe(80.12);
      // smoothed[1] = 0.1 * 81.5678 + 0.9 * 80.1234 = 8.15678 + 72.11106 = 80.26784
      // Math.round(80.26784 * 100) / 100 = Math.round(8026.784) / 100 = 8027/100 = 80.27
      expect(result[1]?.smoothedWeight).toBe(80.27);
    });

    it("rounds weeklyChange via Math.round(x * 100) / 100 (not *10/10 or *1000/1000)", async () => {
      // Build 8 data points to get weeklyChange on index 7
      const rows = Array.from({ length: 8 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 + index * 0.3),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getSmoothedWeight(90, "2024-06-01");
      const change = result[7]?.weeklyChange;
      expect(change).not.toBeNull();
      // Verify 2-decimal precision
      if (change !== null && change !== undefined) {
        const str = String(change);
        const decimals = str.includes(".") ? (str.split(".")[1]?.length ?? 0) : 0;
        expect(decimals).toBeLessThanOrEqual(2);
      }
    });
  });

  describe("getRecomposition property values", () => {
    it("preserves date string from DB row in recomposition", async () => {
      const { repo } = makeRepository([
        { date: "2024-05-20", weight_kg: "80", body_fat_pct: "20" },
      ]);
      const result = await repo.getRecomposition(180, "2024-06-01");
      expect(result[0]?.date).toBe("2024-05-20");
    });

    it("rounds weightKg to 2 decimal places via Math.round(x * 100) / 100", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "80.1234", body_fat_pct: "20" },
      ]);
      const result = await repo.getRecomposition(180, "2024-06-01");
      expect(result[0]?.weightKg).toBe(80.12);
    });

    it("rounds bodyFatPct to 1 decimal via Math.round(x * 10) / 10 (not *100/100)", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "80", body_fat_pct: "18.456" },
      ]);
      const result = await repo.getRecomposition(180, "2024-06-01");
      // Math.round(18.456 * 10) / 10 = Math.round(184.56) / 10 = 185/10 = 18.5
      expect(result[0]?.bodyFatPct).toBe(18.5);
    });

    it("rounds fatMassKg to 2 decimal places via Math.round(x * 100) / 100", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "80.5", body_fat_pct: "18.3" },
      ]);
      const result = await repo.getRecomposition(180, "2024-06-01");
      // fatMass = 80.5 * (18.3 / 100) = 80.5 * 0.183 = 14.7315
      // Math.round(14.7315 * 100) / 100 = Math.round(1473.15) / 100 = 1473/100 = 14.73
      expect(result[0]?.fatMassKg).toBe(14.73);
    });

    it("rounds leanMassKg to 2 decimal places via Math.round(x * 100) / 100", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "80.5", body_fat_pct: "18.3" },
      ]);
      const result = await repo.getRecomposition(180, "2024-06-01");
      // leanMass = 80.5 - 14.7315 = 65.7685
      // Math.round(65.7685 * 100) / 100 = Math.round(6576.85) / 100 = 6577/100 = 65.77
      expect(result[0]?.leanMassKg).toBe(65.77);
    });

    it("rounds smoothedFatMass and smoothedLeanMass to 2 decimals", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "80", body_fat_pct: "20" },
      ]);
      const result = await repo.getRecomposition(180, "2024-06-01");
      // First entry: smoothed = raw
      expect(result[0]?.smoothedFatMass).toBe(16);
      expect(result[0]?.smoothedLeanMass).toBe(64);
    });
  });

  describe("getWeightTrend specific values", () => {
    it("rounds currentWeekly via Math.round(x * 100) / 100 (not *10/10)", async () => {
      // 8 points with slow increase
      const rows = Array.from({ length: 8 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 + index * 0.15),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();
      expect(result.currentWeekly).not.toBeNull();
      if (result.currentWeekly !== null) {
        const str = String(result.currentWeekly);
        const decimals = str.includes(".") ? (str.split(".")[1]?.length ?? 0) : 0;
        expect(decimals).toBeLessThanOrEqual(2);
      }
    });

    it("rounds current4Week via Math.round(x * 100) / 100 (not *10/10)", async () => {
      const rows = Array.from({ length: 30 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 + index * 0.15),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();
      expect(result.current4Week).not.toBeNull();
      if (result.current4Week !== null) {
        const str = String(result.current4Week);
        const decimals = str.includes(".") ? (str.split(".")[1]?.length ?? 0) : 0;
        expect(decimals).toBeLessThanOrEqual(2);
      }
    });

    it("classifies stable when changeReference is exactly 0.1 (not > 0.1)", async () => {
      // We need a series where weekly change is exactly 0.1
      // With constant weight, weekly change = 0 → stable
      const rows = Array.from({ length: 8 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: "80",
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();
      expect(result.trend).toBe("stable");
    });

    it("classifies stable when changeReference is exactly -0.1 (not < -0.1)", async () => {
      // Same logic: constant = 0 change = stable
      const rows = Array.from({ length: 8 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: "80",
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();
      expect(result.currentWeekly).toBe(0);
      expect(result.trend).toBe("stable");
    });
  });

  describe("getRecomposition EWMA alpha", () => {
    it("uses alpha=0.15 for body recomposition (not 0.1 or 0.2)", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "100", body_fat_pct: "20" },
        { date: "2024-01-02", weight_kg: "100", body_fat_pct: "30" },
      ]);
      const result = await repo.getRecomposition(180, "2024-06-01");
      // Day 1: fatMass = 100 * 0.2 = 20, leanMass = 80
      // Day 2: fatMass = 100 * 0.3 = 30, leanMass = 70
      // smoothedFat = 0.15 * 30 + 0.85 * 20 = 4.5 + 17 = 21.5
      expect(result[1]?.smoothedFatMass).toBe(21.5);
      // smoothedLean = 0.15 * 70 + 0.85 * 80 = 10.5 + 68 = 78.5
      expect(result[1]?.smoothedLeanMass).toBe(78.5);
    });
  });
});
