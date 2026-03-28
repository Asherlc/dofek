import { describe, expect, it, vi } from "vitest";
import { SleepNeedRepository } from "./sleep-need-repository.ts";

vi.mock("@dofek/scoring/sleep-performance", () => ({
  computeSleepPerformance: vi.fn((actual: number, needed: number, efficiency: number) => ({
    score: Math.round(Math.min(actual / needed, 1) * 100 * 0.7 + efficiency * 0.3),
    tier: "Good" as const,
  })),
  computeRecommendedBedtime: vi.fn(() => "22:30"),
}));

function makeNightRow(
  overrides: Partial<{
    date: string;
    duration_minutes: number;
    next_day_hrv: number | null;
    median_hrv: number | null;
    good_recovery: boolean;
    yesterday_load: number;
  }> = {},
) {
  return {
    date: "2024-01-15",
    duration_minutes: 450,
    next_day_hrv: 55,
    median_hrv: 50,
    good_recovery: true,
    yesterday_load: 0,
    ...overrides,
  };
}

function makeDb(calls: Record<string, unknown>[][] = []) {
  const execute = vi.fn();
  for (const rows of calls) {
    execute.mockResolvedValueOnce(rows);
  }
  return { execute };
}

describe("SleepNeedRepository", () => {
  describe("calculate", () => {
    it("returns default baseline (480) and canRecommend false when no nights", async () => {
      const db = makeDb([[]]);
      const repo = new SleepNeedRepository(db, "user-1", "UTC");
      const result = await repo.calculate("2024-01-15");

      expect(result.baselineMinutes).toBe(480);
      expect(result.strainDebtMinutes).toBe(0);
      expect(result.accumulatedDebtMinutes).toBe(0);
      expect(result.totalNeedMinutes).toBe(480);
      expect(result.canRecommend).toBe(false);
      expect(result.recentNights).toHaveLength(7);
      // All nights should have null actual since no data
      for (const night of result.recentNights) {
        expect(night.actualMinutes).toBeNull();
        expect(night.debtMinutes).toBeNull();
        expect(night.neededMinutes).toBe(480);
      }
    });

    it("computes baseline from good recovery nights when >= 7 available", async () => {
      // 8 good recovery nights averaging 420 minutes
      const goodNights = Array.from({ length: 8 }, (_, index) =>
        makeNightRow({
          date: `2024-01-${String(index + 1).padStart(2, "0")}`,
          duration_minutes: 400 + index * 5, // 400, 405, 410, ..., 435
          good_recovery: true,
          next_day_hrv: 60,
          median_hrv: 50,
        }),
      );
      // Average = (400+405+410+415+420+425+430+435) / 8 = 417.5 => 418

      const db = makeDb([goodNights]);
      const repo = new SleepNeedRepository(db, "user-1", "UTC");
      const result = await repo.calculate("2024-01-15");

      expect(result.baselineMinutes).toBe(418);
    });

    it("computes baseline from exactly 7 good recovery nights (>= 7 boundary)", async () => {
      const nights = Array.from({ length: 7 }, (_, index) =>
        makeNightRow({
          date: `2024-01-${String(index + 1).padStart(2, "0")}`,
          duration_minutes: 420,
          good_recovery: true,
          next_day_hrv: 60,
          median_hrv: 50,
        }),
      );

      const db = makeDb([nights]);
      const repo = new SleepNeedRepository(db, "user-1", "UTC");
      const result = await repo.calculate("2024-01-15");

      // Exactly 7 good nights should use calculated baseline (420), not default 480
      expect(result.baselineMinutes).toBe(420);
      expect(result.baselineMinutes).not.toBe(480);
    });

    it("falls back to 480 baseline with exactly 6 good recovery nights (< 7 boundary)", async () => {
      const nights = Array.from({ length: 6 }, (_, index) =>
        makeNightRow({
          date: `2024-01-${String(index + 1).padStart(2, "0")}`,
          duration_minutes: 420,
          good_recovery: true,
          next_day_hrv: 60,
          median_hrv: 50,
        }),
      );

      const db = makeDb([nights]);
      const repo = new SleepNeedRepository(db, "user-1", "UTC");
      const result = await repo.calculate("2024-01-15");

      // 6 good nights is fewer than 7 → default baseline
      expect(result.baselineMinutes).toBe(480);
    });

    it("falls back to 480 baseline when fewer than 7 good recovery nights", async () => {
      const fewNights = Array.from({ length: 5 }, (_, index) =>
        makeNightRow({
          date: `2024-01-${String(index + 1).padStart(2, "0")}`,
          duration_minutes: 420,
          good_recovery: true,
        }),
      );

      const db = makeDb([fewNights]);
      const repo = new SleepNeedRepository(db, "user-1", "UTC");
      const result = await repo.calculate("2024-01-15");

      expect(result.baselineMinutes).toBe(480);
    });

    it("caps strain debt at 60 minutes", async () => {
      // yesterday_load = 500 => 500/5 = 100, but capped at 60
      const nights = [
        makeNightRow({
          date: "2024-01-14",
          yesterday_load: 500,
        }),
      ];

      const db = makeDb([nights]);
      const repo = new SleepNeedRepository(db, "user-1", "UTC");
      const result = await repo.calculate("2024-01-15");

      expect(result.strainDebtMinutes).toBe(60);
    });

    it("computes strain debt proportionally below the cap", async () => {
      const nights = [
        makeNightRow({
          date: "2024-01-14",
          yesterday_load: 100,
        }),
      ];

      const db = makeDb([nights]);
      const repo = new SleepNeedRepository(db, "user-1", "UTC");
      const result = await repo.calculate("2024-01-15");

      expect(result.strainDebtMinutes).toBe(20); // 100 / 5 = 20
    });

    it("calculates accumulated debt from last 14 nights", async () => {
      // Baseline defaults to 480 (fewer than 7 good nights)
      // 3 nights with 400 min each => deficit = 80 * 3 = 240
      const nights = Array.from({ length: 3 }, (_, index) =>
        makeNightRow({
          date: `2024-01-${String(index + 10).padStart(2, "0")}`,
          duration_minutes: 400,
          good_recovery: false,
          yesterday_load: 0,
        }),
      );

      const db = makeDb([nights]);
      const repo = new SleepNeedRepository(db, "user-1", "UTC");
      const result = await repo.calculate("2024-01-15");

      expect(result.accumulatedDebtMinutes).toBe(240); // 3 * 80
      // Debt recovery = 240 * 0.25 = 60
      // Total = 480 + 0 + 60 = 540
      expect(result.totalNeedMinutes).toBe(540);
    });

    it("builds a 7-day calendar with correct dates and data mapping", async () => {
      const nights = [
        makeNightRow({ date: "2024-01-13", duration_minutes: 420, good_recovery: false }),
        makeNightRow({ date: "2024-01-15", duration_minutes: 500, good_recovery: false }),
      ];

      const db = makeDb([nights]);
      const repo = new SleepNeedRepository(db, "user-1", "UTC");
      const result = await repo.calculate("2024-01-15");

      expect(result.recentNights).toHaveLength(7);

      // Check date range: Jan 9 through Jan 15
      expect(result.recentNights[0]?.date).toBe("2024-01-09");
      expect(result.recentNights[6]?.date).toBe("2024-01-15");

      // Jan 13 should have data
      const jan13 = result.recentNights.find((night) => night.date === "2024-01-13");
      expect(jan13?.actualMinutes).toBe(420);
      expect(jan13?.debtMinutes).toBe(60); // 480 - 420

      // Jan 15 should have data
      const jan15 = result.recentNights.find((night) => night.date === "2024-01-15");
      expect(jan15?.actualMinutes).toBe(500);
      expect(jan15?.debtMinutes).toBe(0); // 500 > 480, so max(0, -20) = 0

      // Jan 10 should have no data
      const jan10 = result.recentNights.find((night) => night.date === "2024-01-10");
      expect(jan10?.actualMinutes).toBeNull();
      expect(jan10?.debtMinutes).toBeNull();
    });

    it("uses last 14 nights (not 7 or 30) for accumulated debt", async () => {
      // Create 20 nights all with deficit, only the last 14 should be counted
      const nights = Array.from({ length: 20 }, (_, index) =>
        makeNightRow({
          date: `2024-01-${String(index + 1).padStart(2, "0")}`,
          duration_minutes: 400,
          good_recovery: false,
          yesterday_load: 0,
        }),
      );

      const db = makeDb([nights]);
      const repo = new SleepNeedRepository(db, "user-1", "UTC");
      const result = await repo.calculate("2024-01-21");

      // baseline = 480 (fewer than 7 good nights), deficit per night = 80
      // slice(-14) takes last 14 nights: 14 * 80 = 1120
      expect(result.accumulatedDebtMinutes).toBe(1120);
      // If it used all 20: would be 20 * 80 = 1600
      expect(result.accumulatedDebtMinutes).not.toBe(1600);
      // If it used 7: would be 7 * 80 = 560
      expect(result.accumulatedDebtMinutes).not.toBe(560);
    });

    it("strain debt divisor is 5 (not 10 or 4)", async () => {
      // load = 50, debt = 50/5 = 10
      const nights = [makeNightRow({ date: "2024-01-14", yesterday_load: 50 })];
      const db = makeDb([nights]);
      const repo = new SleepNeedRepository(db, "user-1", "UTC");
      const result = await repo.calculate("2024-01-15");

      expect(result.strainDebtMinutes).toBe(10); // 50/5 = 10
      // If divisor were 10: 50/10 = 5
      expect(result.strainDebtMinutes).not.toBe(5);
      // If divisor were 4: 50/4 = 13 (rounded)
      expect(result.strainDebtMinutes).not.toBe(13);
    });

    it("debt recovery factor is 0.25 (not 0.5 or 0.1)", async () => {
      // 4 nights with 400 min, baseline 480 => deficit 80 each => accumulated = 320
      // recovery = 320 * 0.25 = 80
      const nights = Array.from({ length: 4 }, (_, index) =>
        makeNightRow({
          date: `2024-01-${String(index + 10).padStart(2, "0")}`,
          duration_minutes: 400,
          good_recovery: false,
          yesterday_load: 0,
        }),
      );

      const db = makeDb([nights]);
      const repo = new SleepNeedRepository(db, "user-1", "UTC");
      const result = await repo.calculate("2024-01-15");

      // accumulatedDebt = 320, recovery = 320 * 0.25 = 80
      // totalNeed = 480 + 0 + 80 = 560
      expect(result.totalNeedMinutes).toBe(560);
      // If factor were 0.5: recovery = 160, total = 640
      expect(result.totalNeedMinutes).not.toBe(640);
      // If factor were 0.1: recovery = 32, total = 512
      expect(result.totalNeedMinutes).not.toBe(512);
    });

    it("sets canRecommend true when yesterday has sleep data", async () => {
      const nights = [makeNightRow({ date: "2024-01-14", duration_minutes: 420 })];

      const db = makeDb([nights]);
      const repo = new SleepNeedRepository(db, "user-1", "UTC");
      const result = await repo.calculate("2024-01-15");

      expect(result.canRecommend).toBe(true);
    });
  });

  describe("getPerformance", () => {
    it("returns null when no sleep data", async () => {
      const db = makeDb([[]]);
      const repo = new SleepNeedRepository(db, "user-1", "UTC");
      const result = await repo.getPerformance("2024-01-15");

      expect(result).toBeNull();
    });

    it("returns null when duration_minutes is null", async () => {
      const db = makeDb([
        [{ duration_minutes: null, efficiency_pct: 85, sleep_date: "2024-01-15" }],
      ]);
      const repo = new SleepNeedRepository(db, "user-1", "UTC");
      const result = await repo.getPerformance("2024-01-15");

      expect(result).toBeNull();
    });

    it("returns performance info with mocked computeSleepPerformance", async () => {
      const db = makeDb([
        // sleep session query
        [{ duration_minutes: 420, efficiency_pct: 90, sleep_date: "2024-01-15" }],
        // baseline query
        [{ avg_duration: 450 }],
      ]);

      const repo = new SleepNeedRepository(db, "user-1", "UTC");
      const result = await repo.getPerformance("2024-01-15");

      expect(result).not.toBeNull();
      expect(result?.actualMinutes).toBe(420);
      expect(result?.neededMinutes).toBe(450);
      expect(result?.efficiency).toBe(90);
      expect(result?.tier).toBe("Good");
      expect(result?.recommendedBedtime).toBe("22:30");
      expect(result?.sleepDate).toBe("2024-01-15");
    });

    it("defaults efficiency to 85 when null", async () => {
      const db = makeDb([
        [{ duration_minutes: 420, efficiency_pct: null, sleep_date: "2024-01-15" }],
        [{ avg_duration: 450 }],
      ]);

      const repo = new SleepNeedRepository(db, "user-1", "UTC");
      const result = await repo.getPerformance("2024-01-15");

      expect(result?.efficiency).toBe(85);
    });

    it("defaults neededMinutes to 480 when no baseline data", async () => {
      const db = makeDb([
        [{ duration_minutes: 420, efficiency_pct: 88, sleep_date: "2024-01-15" }],
        [{ avg_duration: null }],
      ]);

      const repo = new SleepNeedRepository(db, "user-1", "UTC");
      const result = await repo.getPerformance("2024-01-15");

      expect(result?.neededMinutes).toBe(480);
    });
  });
});
