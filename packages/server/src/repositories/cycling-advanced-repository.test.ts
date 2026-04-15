import { describe, expect, it, vi } from "vitest";
import {
  ActivityVariabilityModel,
  CyclingAdvancedRepository,
  PedalDynamicsModel,
  RampRateWeekModel,
  TrainingMonotonyWeekModel,
  VerticalAscentModel,
} from "./cycling-advanced-repository.ts";

// ---------------------------------------------------------------------------
// Domain models
// ---------------------------------------------------------------------------

describe("RampRateWeekModel", () => {
  it("serializes to API shape", () => {
    const model = new RampRateWeekModel({
      week: "2024-03-04",
      ctlStart: 45.5,
      ctlEnd: 48.2,
      rampRate: 2.7,
    });
    expect(model.toDetail()).toEqual({
      week: "2024-03-04",
      ctlStart: 45.5,
      ctlEnd: 48.2,
      rampRate: 2.7,
    });
  });

  it("exposes getters", () => {
    const model = new RampRateWeekModel({
      week: "2024-03-04",
      ctlStart: 45.5,
      ctlEnd: 48.2,
      rampRate: 2.7,
    });
    expect(model.week).toBe("2024-03-04");
    expect(model.ctlStart).toBe(45.5);
    expect(model.ctlEnd).toBe(48.2);
    expect(model.rampRate).toBe(2.7);
  });
});

describe("TrainingMonotonyWeekModel", () => {
  it("serializes to API shape", () => {
    const model = new TrainingMonotonyWeekModel({
      week: "2024-03-04",
      monotony: 1.8,
      strain: 450.5,
      weeklyLoad: 250.3,
    });
    expect(model.toDetail()).toEqual({
      week: "2024-03-04",
      monotony: 1.8,
      strain: 450.5,
      weeklyLoad: 250.3,
    });
  });
});

describe("ActivityVariabilityModel", () => {
  it("computes variability index as NP / avg power", () => {
    const model = new ActivityVariabilityModel(
      {
        date: "2024-03-15",
        activityName: "Morning Ride",
        normalizedPower: 220,
        averagePower: 200,
      },
      250,
    );
    expect(model.variabilityIndex).toBeCloseTo(1.1, 3);
  });

  it("computes intensity factor as NP / FTP", () => {
    const model = new ActivityVariabilityModel(
      {
        date: "2024-03-15",
        activityName: "Morning Ride",
        normalizedPower: 220,
        averagePower: 200,
      },
      250,
    );
    expect(model.intensityFactor).toBeCloseTo(0.88, 2);
  });

  it("serializes to API shape", () => {
    const model = new ActivityVariabilityModel(
      {
        date: "2024-03-15",
        activityName: "Morning Ride",
        normalizedPower: 220,
        averagePower: 200,
      },
      250,
    );
    const detail = model.toDetail();
    expect(detail.date).toBe("2024-03-15");
    expect(detail.activityName).toBe("Morning Ride");
    expect(detail.normalizedPower).toBe(220);
    expect(detail.averagePower).toBe(200);
    expect(typeof detail.variabilityIndex).toBe("number");
    expect(typeof detail.intensityFactor).toBe("number");
  });

  it("exposes getters", () => {
    const model = new ActivityVariabilityModel(
      {
        date: "2024-03-15",
        activityName: "Morning Ride",
        normalizedPower: 220,
        averagePower: 200,
      },
      250,
    );
    expect(model.date).toBe("2024-03-15");
    expect(model.activityName).toBe("Morning Ride");
    expect(model.normalizedPower).toBe(220);
    expect(model.averagePower).toBe(200);
  });
});

describe("VerticalAscentModel", () => {
  it("computes VAM in meters/hour", () => {
    const model = new VerticalAscentModel({
      date: "2024-03-15",
      activityName: "Hill Climb",
      elevationGainMeters: 500,
      climbingSeconds: 1800, // 30 minutes
    });
    // 500m / (1800/3600 h) = 1000 m/h
    expect(model.verticalAscentRate).toBe(1000);
  });

  it("computes climbing minutes", () => {
    const model = new VerticalAscentModel({
      date: "2024-03-15",
      activityName: "Hill Climb",
      elevationGainMeters: 500,
      climbingSeconds: 1800,
    });
    expect(model.climbingMinutes).toBe(30);
  });

  it("returns 0 VAM when no climbing seconds", () => {
    const model = new VerticalAscentModel({
      date: "2024-03-15",
      activityName: "Flat Ride",
      elevationGainMeters: 0,
      climbingSeconds: 0,
    });
    expect(model.verticalAscentRate).toBe(0);
  });

  it("serializes to API shape", () => {
    const model = new VerticalAscentModel({
      date: "2024-03-15",
      activityName: "Hill Climb",
      elevationGainMeters: 500,
      climbingSeconds: 1800,
    });
    const detail = model.toDetail();
    expect(detail.date).toBe("2024-03-15");
    expect(detail.activityName).toBe("Hill Climb");
    expect(detail.verticalAscentRate).toBe(1000);
    expect(detail.elevationGainMeters).toBe(500);
    expect(detail.climbingMinutes).toBe(30);
  });
});

describe("PedalDynamicsModel", () => {
  it("serializes to API shape", () => {
    const model = new PedalDynamicsModel({
      date: "2024-03-15",
      activityName: "Interval Session",
      leftRightBalance: 49.5,
      avgTorqueEffectiveness: 72.3,
      avgPedalSmoothness: 18.5,
    });
    expect(model.toDetail()).toEqual({
      date: "2024-03-15",
      activityName: "Interval Session",
      leftRightBalance: 49.5,
      avgTorqueEffectiveness: 72.3,
      avgPedalSmoothness: 18.5,
    });
  });
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

describe("CyclingAdvancedRepository", () => {
  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(rows);
    const db = { execute };
    const repo = new CyclingAdvancedRepository(db, "user-1", "UTC");
    return { repo, execute };
  }

  describe("getRampRate", () => {
    it("returns no-data result when no daily loads", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getRampRate(90);
      expect(result.weeks).toEqual([]);
      expect(result.currentRampRate).toBe(0);
      expect(result.recommendation).toBe("No data");
    });

    it("passes days parameter to query", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.getRampRate(30);
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("getTrainingMonotony", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getTrainingMonotony(90);
      expect(result).toEqual([]);
    });

    it("returns TrainingMonotonyWeekModel instances", async () => {
      const { repo } = makeRepository([
        { week: "2024-03-04", monotony: 1.8, strain: 450.5, weekly_load: 250.3 },
      ]);
      const result = await repo.getTrainingMonotony(90);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(TrainingMonotonyWeekModel);
      expect(result[0]?.toDetail().monotony).toBe(1.8);
    });
  });

  describe("getEstimatedFtp", () => {
    it("returns null when no power data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getEstimatedFtp(90);
      expect(result).toBeNull();
    });

    it("returns FTP value when data exists", async () => {
      const { repo } = makeRepository([{ ftp: 250 }]);
      const result = await repo.getEstimatedFtp(90);
      expect(result).toBe(250);
    });
  });

  describe("getActivityVariability", () => {
    it("returns empty result when no FTP", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getActivityVariability(90, 20, 0);
      expect(result.models).toEqual([]);
      expect(result.totalCount).toBe(0);
    });

    it("returns ActivityVariabilityModel instances when data exists", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce([{ ftp: 250 }])
        .mockResolvedValueOnce([
          {
            date: "2024-03-15",
            name: "Morning Ride",
            np: 220,
            avg_power: 200,
            total_count: 1,
          },
        ]);
      const db = { execute };
      const repo = new CyclingAdvancedRepository(db, "user-1", "UTC");
      const result = await repo.getActivityVariability(90, 20, 0);
      expect(result.models).toHaveLength(1);
      expect(result.models[0]).toBeInstanceOf(ActivityVariabilityModel);
      expect(result.totalCount).toBe(1);
    });
  });

  describe("getVerticalAscentRates", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getVerticalAscentRates(90);
      expect(result).toEqual([]);
    });

    it("returns VerticalAscentModel instances", async () => {
      const { repo } = makeRepository([
        {
          date: "2024-03-15",
          name: "Hill Climb",
          elevation_gain: 500,
          climbing_seconds: 1800,
        },
      ]);
      const result = await repo.getVerticalAscentRates(90);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(VerticalAscentModel);
      expect(result[0]?.toDetail().verticalAscentRate).toBe(1000);
    });

    it("does not require grade channel data — altitude-only providers return results", async () => {
      // Regression test: the original query used INNER JOIN on the grade channel,
      // which returned empty for providers that don't emit grade (Garmin, Wahoo, etc.).
      // The query now uses altitude deltas alone to detect climbing.
      const { repo, execute } = makeRepository([
        {
          date: "2024-04-01",
          name: "Garmin Ride",
          elevation_gain: 800,
          climbing_seconds: 2400,
        },
      ]);
      const result = await repo.getVerticalAscentRates(90);
      expect(result).toHaveLength(1);
      expect(result[0]?.toDetail().activityName).toBe("Garmin Ride");
      // Verify only a single execute call was made (no separate grade channel query)
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("getPedalDynamics", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getPedalDynamics(90);
      expect(result).toEqual([]);
    });

    it("returns PedalDynamicsModel instances", async () => {
      const { repo } = makeRepository([
        {
          date: "2024-03-15",
          name: "Interval Session",
          avg_balance: 49.5,
          avg_torque_effectiveness: 72.3,
          avg_pedal_smoothness: 18.5,
        },
      ]);
      const result = await repo.getPedalDynamics(90);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(PedalDynamicsModel);
      expect(result[0]?.toDetail().leftRightBalance).toBe(49.5);
    });
  });
});
