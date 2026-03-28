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

    it("calls execute for each sub-query", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.getNextWorkoutData("2024-01-15");
      // 8 parallel queries
      expect(execute).toHaveBeenCalledTimes(8);
    });
  });
});
