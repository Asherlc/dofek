import { describe, expect, it, vi } from "vitest";
import { TrainingRepository } from "./training-repository.ts";

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

describe("TrainingRepository", () => {
  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(rows);
    const db = { execute };
    const repo = new TrainingRepository(db, "user-1", "UTC");
    return { repo, execute };
  }

  describe("getWeeklyVolume", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getWeeklyVolume(90);
      expect(result).toEqual([]);
    });

    it("returns parsed weekly volume rows", async () => {
      const { repo } = makeRepository([
        { week: "2024-01-15", activity_type: "cycling", count: 3, hours: 4.5 },
      ]);
      const result = await repo.getWeeklyVolume(90);
      expect(result).toHaveLength(1);
      expect(result[0]?.activity_type).toBe("cycling");
      expect(result[0]?.hours).toBe(4.5);
    });
  });

  describe("getHrZones", () => {
    it("returns null maxHr and empty weeks when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getHrZones(90);
      expect(result).toEqual({ maxHr: null, weeks: [] });
    });

    it("returns maxHr and zone rows", async () => {
      const { repo } = makeRepository([
        {
          max_hr: 190,
          week: "2024-01-15",
          zone1: 100,
          zone2: 200,
          zone3: 150,
          zone4: 50,
          zone5: 10,
        },
      ]);
      const result = await repo.getHrZones(90);
      expect(result.maxHr).toBe(190);
      expect(result.weeks).toHaveLength(1);
      expect(result.weeks[0]?.zone2).toBe(200);
    });
  });

  describe("getActivityStats", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getActivityStats(90);
      expect(result).toEqual([]);
    });

    it("returns activity stats rows", async () => {
      const { repo } = makeRepository([
        {
          id: "act-1",
          activity_type: "running",
          name: "Morning Run",
          started_at: "2024-01-15T08:00:00Z",
          ended_at: "2024-01-15T09:00:00Z",
          avg_hr: 145.5,
          max_hr: 175,
          avg_power: null,
          max_power: null,
          avg_cadence: 82.3,
          hr_samples: 3600,
          power_samples: null,
        },
      ]);
      const result = await repo.getActivityStats(90);
      expect(result).toHaveLength(1);
      expect(result[0]?.activity_type).toBe("running");
      expect(result[0]?.avg_hr).toBe(145.5);
    });
  });

  describe("getNextWorkoutData", () => {
    it("returns default values when all queries return empty", async () => {
      const { repo } = makeRepository([]);
      const data = await repo.getNextWorkoutData("2024-01-15");
      expect(data.latestMetric).toBeNull();
      expect(data.latestSleepEfficiency).toBeNull();
      expect(data.acwr).toBeNull();
      expect(data.muscleFreshness).toEqual([]);
      expect(data.balance).toEqual({
        strength_7d: 0,
        endurance_7d: 0,
        last_strength_date: null,
        last_endurance_date: null,
      });
      expect(data.zoneTotals).toEqual({ zone1: 0, zone2: 0, zone3: 0, zone4: 0, zone5: 0 });
      expect(data.hiitLoad).toEqual({ hiit_count_7d: 0, last_hiit_date: null });
      expect(data.trainingDates).toEqual([]);
    });

    it("returns data from non-empty queries", async () => {
      const execute = vi.fn();
      // latestMetrics
      execute.mockResolvedValueOnce([
        {
          date: "2024-01-14",
          hrv: 65.3,
          resting_hr: 52.1,
          respiratory_rate: 15.2,
          hrv_mean_30d: 60.0,
          hrv_sd_30d: 8.0,
          rhr_mean_30d: 54.0,
          rhr_sd_30d: 3.0,
          rr_mean_30d: 15.0,
          rr_sd_30d: 1.0,
        },
      ]);
      // sleep
      execute.mockResolvedValueOnce([{ efficiency_pct: 88.5 }]);
      // acwr
      execute.mockResolvedValueOnce([{ acwr: 1.15 }]);
      // muscleFreshness
      execute.mockResolvedValueOnce([{ muscle_group: "chest", last_trained_date: "2024-01-12" }]);
      // balance
      execute.mockResolvedValueOnce([
        {
          strength_7d: 3,
          endurance_7d: 4,
          last_strength_date: "2024-01-13",
          last_endurance_date: "2024-01-14",
        },
      ]);
      // zoneTotals
      execute.mockResolvedValueOnce([{ zone1: 100, zone2: 200, zone3: 150, zone4: 50, zone5: 10 }]);
      // hiitLoad
      execute.mockResolvedValueOnce([{ hiit_count_7d: 2, last_hiit_date: "2024-01-13" }]);
      // trainingDays
      execute.mockResolvedValueOnce([
        { training_date: "2024-01-14" },
        { training_date: "2024-01-12" },
      ]);

      const repo = new TrainingRepository({ execute }, "user-1", "UTC");
      const data = await repo.getNextWorkoutData("2024-01-15");

      expect(data.latestMetric).not.toBeNull();
      expect(data.latestMetric?.hrv).toBe(65.3);
      expect(data.latestSleepEfficiency).toBe(88.5);
      expect(data.acwr).toBe(1.15);
      expect(data.muscleFreshness).toHaveLength(1);
      expect(data.muscleFreshness[0]?.muscle_group).toBe("chest");
      expect(data.balance.strength_7d).toBe(3);
      expect(data.balance.endurance_7d).toBe(4);
      expect(data.zoneTotals.zone1).toBe(100);
      expect(data.zoneTotals.zone3).toBe(150);
      expect(data.hiitLoad.hiit_count_7d).toBe(2);
      expect(data.trainingDates).toEqual(["2024-01-14", "2024-01-12"]);
    });

    it("returns exactly 0 for numeric defaults (not 1 or other values)", async () => {
      const { repo } = makeRepository([]);
      const data = await repo.getNextWorkoutData("2024-01-15");
      // Each default 0 must be exactly 0 to catch Stryker 0→1 mutations
      expect(data.balance.strength_7d).toStrictEqual(0);
      expect(data.balance.endurance_7d).toStrictEqual(0);
      expect(data.zoneTotals.zone1).toStrictEqual(0);
      expect(data.zoneTotals.zone2).toStrictEqual(0);
      expect(data.zoneTotals.zone3).toStrictEqual(0);
      expect(data.zoneTotals.zone4).toStrictEqual(0);
      expect(data.zoneTotals.zone5).toStrictEqual(0);
      expect(data.hiitLoad.hiit_count_7d).toStrictEqual(0);
    });

    it("calls execute for each sub-query", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.getNextWorkoutData("2024-01-15");
      // 8 parallel queries
      expect(execute).toHaveBeenCalledTimes(8);
    });
  });
});
