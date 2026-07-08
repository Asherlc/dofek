import { CYCLING_ACTIVITY_TYPES } from "@dofek/training/training";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActivityVariabilityModel,
  PedalDynamicsModel,
  RampRateWeekModel,
  TrainingMonotonyWeekModel,
  VerticalAscentModel,
} from "./cycling-advanced-models.ts";
import { CyclingAdvancedRepository } from "./cycling-advanced-repository.ts";

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
        activityId: "ride-1",
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
        activityId: "ride-1",
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
        activityId: "ride-1",
        date: "2024-03-15",
        activityName: "Morning Ride",
        normalizedPower: 220,
        averagePower: 200,
      },
      250,
    );
    const detail = model.toDetail();
    expect(detail.activityId).toBe("ride-1");
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
        activityId: "ride-1",
        date: "2024-03-15",
        activityName: "Morning Ride",
        normalizedPower: 220,
        averagePower: 200,
      },
      250,
    );
    expect(model.activityId).toBe("ride-1");
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
  // biome-ignore lint/suspicious/noExplicitAny: test mock helper
  function makeSensorStore(rows: unknown[], rawActivityCount = rows.length): any {
    // Mirror ClickHouseActivitySensorStore.query: parse rows through the
    // supplied Zod schema so coerce/transform validators actually run.
    const query = vi
      .fn()
      .mockImplementation(async (schema: { parse: (row: unknown) => unknown }, queryText = "") => {
        if (queryText.includes("raw_activity_count")) {
          return [schema.parse({ raw_activity_count: rawActivityCount })];
        }
        return rows.map((row) => schema.parse(row));
      });
    return {
      query,
      getActivitySummaries: vi.fn().mockResolvedValue([]),
      getStream: vi.fn().mockResolvedValue([]),
      getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
      getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
      getPowerCurveSamples: vi.fn().mockResolvedValue([]),
      getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
      getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
      getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
      getPaceCurveRows: vi.fn().mockResolvedValue([]),
    };
  }

  function makeRepository(rows: Record<string, unknown>[] = [], rawActivityCount = rows.length) {
    const execute = vi.fn().mockResolvedValue([{ activity_count: rawActivityCount }]);
    const sensorStore = makeSensorStore(rows, rawActivityCount);
    const repo = new CyclingAdvancedRepository({ execute }, "user-1", "UTC", sensorStore);
    return { repo, execute, sensorStore };
  }

  function expectCyclingOnlyActivityTypes(activityTypes: unknown) {
    expect(activityTypes).toEqual([...CYCLING_ACTIVITY_TYPES]);
    expect(activityTypes).not.toContain("walking");
    expect(activityTypes).not.toContain("running");
    expect(activityTypes).not.toContain("hiking");
  }

  describe("getRampRate", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-07T12:00:00.000Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns no-data result when no ramp rate rows exist", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getRampRate(90);
      expect(result.weeks).toEqual([]);
      expect(result.currentRampRate).toBe(0);
      expect(result.recommendation).toBe("No data");
    });

    it("issues exactly one CH query for the weekly read model", async () => {
      const { repo, sensorStore } = makeRepository([]);
      await repo.getRampRate(30);
      expect(sensorStore.query).toHaveBeenCalledTimes(1);
    });

    it("queries ClickHouse weekly endurance ramp rate read model", async () => {
      const { repo, sensorStore } = makeRepository([]);
      await repo.getRampRate(30);
      const [, query, params] = sensorStore.query.mock.calls[0];
      expect(query).toContain("analytics.daily_endurance_load");
      expect(query).toContain("ramp.is_deleted = 0");
      expect(query).toContain("ramp.week > toMonday(today() - INTERVAL {days:Int32} DAY)");
      expect(query).not.toContain("resting_heart_rate");
      expect(query).toContain("analytics.activity_summary");
      expect(query).toContain("has({activityTypes:Array(String)}, activity.activity_type)");
      expect(query).toContain("load.date > today() - INTERVAL {loadDays:Int32} DAY");
      expect(params).toMatchObject({
        userId: "user-1",
        timezone: "UTC",
        days: 30,
        loadDays: 72,
      });
      expectCyclingOnlyActivityTypes(params.activityTypes);
    });

    it("returns safe recommendation for low current ramp rate", async () => {
      const { repo } = makeRepository([
        { week: "2026-04-20", ctl_start: 12.1, ctl_end: 14.4, ramp_rate: 2.3 },
      ]);
      const result = await repo.getRampRate(30);
      expect(result.weeks).toHaveLength(1);
      expect(result.currentRampRate).toBeGreaterThan(0);
      expect(result.currentRampRate).toBeLessThan(5);
      expect(result.recommendation).toBe("Safe: ramp rate is within sustainable range");
      expect(result.weeks[0]?.toDetail()).toEqual({
        week: "2026-04-20",
        ctlStart: 12.1,
        ctlEnd: 14.4,
        rampRate: 2.3,
      });
    });

    it("returns aggressive recommendation for moderate current ramp rate", async () => {
      const { repo } = makeRepository([
        { week: "2026-04-20", ctl_start: 20, ctl_end: 26.2, ramp_rate: 6.2 },
      ]);
      const result = await repo.getRampRate(30);
      expect(result.currentRampRate).toBeGreaterThanOrEqual(5);
      expect(result.currentRampRate).toBeLessThanOrEqual(7);
      expect(result.recommendation).toBe("Aggressive: monitor fatigue closely and ensure recovery");
    });

    it("returns danger recommendation for high current ramp rate", async () => {
      const { repo } = makeRepository([
        { week: "2026-04-20", ctl_start: 20, ctl_end: 28.4, ramp_rate: 8.4 },
      ]);
      const result = await repo.getRampRate(30);
      expect(result.currentRampRate).toBeGreaterThan(7);
      expect(result.recommendation).toBe(
        "Danger: ramp rate is too high, risk of overtraining or injury",
      );
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

    it("queries training monotony from weekly read model with user parameters", async () => {
      const { repo, sensorStore } = makeRepository([]);
      await repo.getTrainingMonotony(45);
      const [, query, params] = sensorStore.query.mock.calls[0];
      expect(query).toContain("analytics.daily_endurance_load");
      expect(query).toContain("monotony.is_deleted = 0");
      expect(query).toContain("monotony.week >= toMonday(today() - INTERVAL {days:Int32} DAY)");
      expect(query).not.toContain("resting_heart_rate");
      expect(query).toContain("analytics.activity_summary");
      expect(query).toContain("has({activityTypes:Array(String)}, activity.activity_type)");
      expect(params).toMatchObject({
        userId: "user-1",
        timezone: "UTC",
        days: 45,
      });
      expectCyclingOnlyActivityTypes(params.activityTypes);
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

    it("queries estimated FTP as ninety-five percent of precomputed best twenty-minute power", async () => {
      const { repo, sensorStore } = makeRepository([]);
      await repo.getEstimatedFtp(60);
      const [, query, params] = sensorStore.query.mock.calls[0];
      expect(query).toContain("analytics.activity_summary");
      expect(query).toContain("max(asum.best_twenty_minute_power) * 0.95");
      expect(query).toContain("asum.best_twenty_minute_power IS NOT NULL");
      expect(params).toMatchObject({
        userId: "user-1",
        days: 60,
      });
      expectCyclingOnlyActivityTypes(params.activityTypes);
    });
  });

  describe("getActivityVariability", () => {
    it("does not estimate FTP or scan sensors when no raw activities exist", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getActivityVariability(90, 20, 0);
      expect(result.models).toEqual([]);
      expect(result.totalCount).toBe(0);
    });

    it("returns empty result when raw activities exist but no FTP", async () => {
      const { repo } = makeRepository([], 1);
      const result = await repo.getActivityVariability(90, 20, 0);
      expect(result.models).toEqual([]);
      expect(result.totalCount).toBe(0);
    });

    it("does not scan activity_summary or deduped_sensor when no raw activities exist", async () => {
      const { repo, sensorStore } = makeRepository([]);
      await repo.getActivityVariability(90, 20, 0);

      expect(sensorStore.query).not.toHaveBeenCalled();
    });

    it("returns ActivityVariabilityModel instances when data exists", async () => {
      // First sensorStore.query call -> FTP estimate; second -> variability rows.
      const sensorStore = makeSensorStore([]);
      sensorStore.query = vi
        .fn()
        .mockImplementationOnce(async (schema: { parse: (row: unknown) => unknown }) =>
          [{ ftp: 250 }].map((row) => schema.parse(row)),
        )
        .mockImplementationOnce(async (schema: { parse: (row: unknown) => unknown }) =>
          [
            {
              activity_id: "ride-2",
              date: "2024-03-15",
              name: "Morning Ride",
              np: 220,
              avg_power: 200,
              total_count: 1,
            },
          ].map((row) => schema.parse(row)),
        );
      const repo = new CyclingAdvancedRepository(
        { execute: vi.fn().mockResolvedValue([{ activity_count: 1 }]) },
        "user-1",
        "UTC",
        sensorStore,
      );
      const result = await repo.getActivityVariability(90, 20, 0);
      expect(result.models).toHaveLength(1);
      expect(result.models[0]).toBeInstanceOf(ActivityVariabilityModel);
      expect(result.totalCount).toBe(1);
      expect(sensorStore.query).toHaveBeenCalledTimes(2);
      const [, query, params] = sensorStore.query.mock.calls[1];
      expect(query).toContain("analytics.activity_summary");
      expect(query).toContain("round(asum.normalized_power, 1)");
      expect(query).toContain("round(asum.smoothed_avg_power, 1)");
      expect(query).toContain("asum.normalized_power IS NOT NULL");
      expect(query).toContain("LIMIT {limit:Int32}");
      expect(query).toContain("OFFSET {offset:Int32}");
      expect(params).toMatchObject({
        userId: "user-1",
        timezone: "UTC",
        days: 90,
        limit: 20,
        offset: 0,
      });
      expectCyclingOnlyActivityTypes(params.activityTypes);
    });
  });

  describe("getVerticalAscentRates", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getVerticalAscentRates(90);
      expect(result).toEqual([]);
    });

    it("does not scan activity_summary or deduped_sensor when no raw activities exist", async () => {
      const { repo, sensorStore } = makeRepository([]);
      await repo.getVerticalAscentRates(90);

      expect(sensorStore.query).not.toHaveBeenCalled();
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
      // Regression test: providers that don't emit a grade channel (Garmin, Wahoo)
      // must still surface climbing. The precomputed climbing columns are derived
      // with a LEFT JOIN on grade, so altitude-only activities keep a climbing value.
      const { repo, sensorStore } = makeRepository(
        [
          {
            date: "2024-04-01",
            name: "Garmin Ride",
            elevation_gain: 800,
            climbing_seconds: 2400,
          },
        ],
        1,
      );
      const result = await repo.getVerticalAscentRates(90);
      expect(result).toHaveLength(1);
      expect(result[0]?.toDetail().activityName).toBe("Garmin Ride");
      expect(sensorStore.query).toHaveBeenCalledTimes(1);
    });

    it("queries vertical ascent from precomputed climbing columns with minimum climb duration", async () => {
      const { repo, sensorStore } = makeRepository([], 1);
      await repo.getVerticalAscentRates(90);
      const [, query, params] = sensorStore.query.mock.calls[0];
      expect(query).toContain("analytics.activity_summary");
      expect(query).toContain("round(asum.climbing_elevation_gain_m, 1)");
      expect(query).toContain("toInt32(asum.climbing_seconds)");
      expect(query).toContain("asum.climbing_seconds > 60");
      expect(params).toMatchObject({
        userId: "user-1",
        timezone: "UTC",
        days: 90,
      });
      expectCyclingOnlyActivityTypes(params.activityTypes);
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

    it("queries pedal dynamics from activity summary with left balance present", async () => {
      const { repo, sensorStore } = makeRepository([]);
      await repo.getPedalDynamics(90);
      const [, query, params] = sensorStore.query.mock.calls[0];
      expect(query).toContain("analytics.activity_summary");
      expect(query).toContain("asum.avg_left_balance IS NOT NULL");
      expect(query).toContain("(asum.avg_left_torque_eff + asum.avg_right_torque_eff) / 2");
      expect(query).toContain("(asum.avg_left_pedal_smooth + asum.avg_right_pedal_smooth) / 2");
      expect(params).toMatchObject({
        userId: "user-1",
        timezone: "UTC",
        days: 90,
      });
      expectCyclingOnlyActivityTypes(params.activityTypes);
    });
  });
});
