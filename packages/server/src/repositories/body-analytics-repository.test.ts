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
  });
});
