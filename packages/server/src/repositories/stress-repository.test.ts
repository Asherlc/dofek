import { describe, expect, it, vi } from "vitest";
import { StressRepository } from "./stress-repository.ts";

function makeDb(metricsRows: Record<string, unknown>[] = []) {
  const execute = vi
    .fn()
    .mockResolvedValueOnce(metricsRows) // metrics + sleep query
    .mockResolvedValueOnce([]); // loadPersonalizedParams query (empty = use defaults)
  return { execute };
}

describe("StressRepository", () => {
  describe("getStressScores", () => {
    it("returns empty result when no data", async () => {
      const db = makeDb([]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily).toEqual([]);
      expect(result.weekly).toEqual([]);
      expect(result.latestScore).toBeNull();
      expect(result.trend).toBe("stable");
    });

    it("computes HRV deviation as z-score", async () => {
      const db = makeDb([
        {
          date: "2024-01-15",
          hrv: 50,
          resting_hr: null,
          hrv_mean_60d: 60,
          hrv_sd_60d: 5,
          rhr_mean_60d: null,
          rhr_sd_60d: null,
          efficiency_pct: null,
        },
      ]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      // (50 - 60) / 5 = -2.0
      expect(result.daily[0]?.hrvDeviation).toBeCloseTo(-2.0, 2);
    });

    it("returns null hrvDeviation when sd is zero", async () => {
      const db = makeDb([
        {
          date: "2024-01-15",
          hrv: 60,
          resting_hr: null,
          hrv_mean_60d: 60,
          hrv_sd_60d: 0,
          rhr_mean_60d: null,
          rhr_sd_60d: null,
          efficiency_pct: null,
        },
      ]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.hrvDeviation).toBeNull();
    });

    it("rounds sleep efficiency to 1 decimal", async () => {
      const db = makeDb([
        {
          date: "2024-01-15",
          hrv: null,
          resting_hr: null,
          hrv_mean_60d: null,
          hrv_sd_60d: null,
          rhr_mean_60d: null,
          rhr_sd_60d: null,
          efficiency_pct: 87.456,
        },
      ]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.daily[0]?.sleepEfficiency).toBe(87.5);
    });

    it("sets latestScore to last day's stressScore", async () => {
      const db = makeDb([
        {
          date: "2024-01-14",
          hrv: 60,
          resting_hr: 54,
          hrv_mean_60d: 60,
          hrv_sd_60d: 5,
          rhr_mean_60d: 54,
          rhr_sd_60d: 3,
          efficiency_pct: 90,
        },
        {
          date: "2024-01-15",
          hrv: 45,
          resting_hr: 62,
          hrv_mean_60d: 60,
          hrv_sd_60d: 5,
          rhr_mean_60d: 54,
          rhr_sd_60d: 3,
          efficiency_pct: 75,
        },
      ]);
      const repo = new StressRepository(db, "user-1", "UTC");
      const result = await repo.getStressScores(90, "2024-01-15");
      expect(result.latestScore).toBe(result.daily[result.daily.length - 1]?.stressScore);
    });

    it("calls execute twice (metrics + params)", async () => {
      const db = makeDb([]);
      const repo = new StressRepository(db, "user-1", "UTC");
      await repo.getStressScores(90, "2024-01-15");
      expect(db.execute).toHaveBeenCalledTimes(2);
    });
  });
});
