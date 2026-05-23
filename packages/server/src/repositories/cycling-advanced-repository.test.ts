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
    // After the CH migration every cycling-advanced query routes through
    // sensorStore. The PG db stays for completeness but is unused by the
    // migrated methods.
    const execute = vi.fn();
    const sensorStore = makeSensorStore(rows, rawActivityCount);
    const repo = new CyclingAdvancedRepository({ execute }, "user-1", "UTC", sensorStore);
    return { repo, execute, sensorStore };
  }

  function recentDailyLoads(count: number, loadForIndex: (index: number) => number) {
    const today = new Date();
    return Array.from({ length: count }, (_, index) => {
      const date = new Date(today);
      date.setDate(today.getDate() - (count - 1 - index));
      return {
        day: date.toISOString().slice(0, 10),
        trimp: loadForIndex(index),
      };
    });
  }

  describe("getRampRate", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-07T12:00:00.000Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns no-data result when no daily loads", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getRampRate(90);
      expect(result.weeks).toEqual([]);
      expect(result.currentRampRate).toBe(0);
      expect(result.recommendation).toBe("No data");
    });

    it("issues exactly one CH query for the daily-load aggregation", async () => {
      const { repo, sensorStore } = makeRepository([]);
      await repo.getRampRate(30);
      expect(sensorStore.query).toHaveBeenCalledTimes(1);
    });

    it("queries ClickHouse with warmup window and endurance activity filter", async () => {
      const { repo, sensorStore } = makeRepository([]);
      await repo.getRampRate(30);
      const [, query, params] = sensorStore.query.mock.calls[0];
      expect(query).toContain("analytics.activity_summary");
      expect(query).toContain("INTERVAL ({days:Int32} + 42) DAY");
      expect(query).toContain("has({enduranceTypes:Array(String)}, asum.activity_type)");
      expect(query).not.toContain("analytics.v_activity");
      expect(params).toMatchObject({
        userId: "user-1",
        timezone: "UTC",
        days: 30,
      });
      expect(params.enduranceTypes).toContain("cycling");
    });

    it("computes safe ramp rate from steady low load", async () => {
      const { repo } = makeRepository(recentDailyLoads(35, () => 20));
      const result = await repo.getRampRate(30);
      expect(result.weeks.length).toBeGreaterThanOrEqual(3);
      expect(result.currentRampRate).toBeGreaterThan(0);
      expect(result.currentRampRate).toBeLessThan(5);
      expect(result.recommendation).toBe("Safe: ramp rate is within sustainable range");
      expect(result.weeks.at(-1)?.ctlEnd).toBeGreaterThan(result.weeks[0]?.ctlStart ?? 0);
    });

    it("computes aggressive ramp rate for moderate load increase", async () => {
      const { repo } = makeRepository(recentDailyLoads(35, (index) => (index < 14 ? 20 : 120)));
      const result = await repo.getRampRate(30);
      expect(result.currentRampRate).toBeGreaterThanOrEqual(5);
      expect(result.currentRampRate).toBeLessThanOrEqual(7);
      expect(result.recommendation).toBe("Aggressive: monitor fatigue closely and ensure recovery");
    });

    it("computes danger recommendation for large load increase", async () => {
      const { repo } = makeRepository(recentDailyLoads(35, (index) => (index < 14 ? 20 : 200)));
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

    it("queries training monotony with weekly stats and user parameters", async () => {
      const { repo, sensorStore } = makeRepository([]);
      await repo.getTrainingMonotony(45);
      const [, query, params] = sensorStore.query.mock.calls[0];
      expect(query).toContain("weekly_stats");
      expect(query).toContain("stddevPop(trimp) > 0");
      expect(query).toContain("round(weekly_load * (mean_load / stdev_load), 1)");
      expect(params).toMatchObject({
        userId: "user-1",
        timezone: "UTC",
        days: 45,
      });
      expect(params.enduranceTypes).toContain("cycling");
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

    it("queries estimated FTP as ninety-five percent of best twenty-minute power", async () => {
      const { repo, sensorStore } = makeRepository([]);
      await repo.getEstimatedFtp(60);
      const [, query, params] = sensorStore.query.mock.calls[0];
      expect(query).toContain("round(1200.0 / sr.interval_s)");
      expect(query).toContain("* 0.95");
      expect(query).toContain("ds.channel = 'power'");
      expect(query).not.toContain("analytics.v_activity");
      expect(params).toMatchObject({
        userId: "user-1",
        days: 60,
      });
      expect(params.enduranceTypes).toContain("cycling");
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

      expect(sensorStore.query).toHaveBeenCalledTimes(1);
      expect(sensorStore.query.mock.calls[0]?.[1]).toContain(
        "FROM postgres_fitness.activity FINAL",
      );
      expect(sensorStore.query.mock.calls[0]?.[1]).not.toContain("analytics.activity_summary");
      expect(sensorStore.query.mock.calls[0]?.[1]).not.toContain("analytics.deduped_sensor");
    });

    it("returns ActivityVariabilityModel instances when data exists", async () => {
      // First sensorStore.query call -> raw activity count; second -> FTP estimate;
      // third -> variability rows.
      const sensorStore = makeSensorStore([]);
      sensorStore.query = vi
        .fn()
        .mockImplementationOnce(async (schema: { parse: (row: unknown) => unknown }) =>
          [{ raw_activity_count: 1 }].map((row) => schema.parse(row)),
        )
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
        { execute: vi.fn() },
        "user-1",
        "UTC",
        sensorStore,
      );
      const result = await repo.getActivityVariability(90, 20, 0);
      expect(result.models).toHaveLength(1);
      expect(result.models[0]).toBeInstanceOf(ActivityVariabilityModel);
      expect(result.totalCount).toBe(1);
      expect(sensorStore.query).toHaveBeenCalledTimes(3);
      const [, query, params] = sensorStore.query.mock.calls[2];
      expect(query).toContain("RANGE BETWEEN 29 PRECEDING AND CURRENT ROW");
      expect(query).toContain("pow(avg(pow(r.rolling_30s_power, 4)), 0.25)");
      expect(query).toContain("LIMIT {limit:Int32}");
      expect(query).toContain("OFFSET {offset:Int32}");
      expect(query).not.toContain("analytics.v_activity");
      expect(params).toMatchObject({
        userId: "user-1",
        timezone: "UTC",
        days: 90,
        limit: 20,
        offset: 0,
      });
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

      expect(sensorStore.query).toHaveBeenCalledTimes(1);
      expect(sensorStore.query.mock.calls[0]?.[1]).toContain(
        "FROM postgres_fitness.activity FINAL",
      );
      expect(sensorStore.query.mock.calls[0]?.[1]).not.toContain("analytics.activity_summary");
      expect(sensorStore.query.mock.calls[0]?.[1]).not.toContain("analytics.deduped_sensor");
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
      // Regression test: the original query INNER-JOINed the grade channel,
      // which returned empty for providers that don't emit grade (Garmin, Wahoo).
      // The CH query LEFT-JOINs grade activities, so altitude-only providers still match.
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
      expect(sensorStore.query).toHaveBeenCalledTimes(2);
    });

    it("queries vertical ascent with grade fallback and minimum climb duration", async () => {
      const { repo, sensorStore } = makeRepository([], 1);
      await repo.getVerticalAscentRates(90);
      const [, query, params] = sensorStore.query.mock.calls[1];
      expect(query).toContain("LEFT JOIN grade_activities");
      expect(query).toContain("LEFT JOIN grade_points");
      expect(query).toContain("(NOT coalesce(cs.has_grade_samples, false) OR cs.grade > 3)");
      expect(query).toContain(
        "HAVING sum(dateDiff('second', cs.prev_recorded_at, cs.recorded_at)) > 60",
      );
      expect(query).not.toContain("analytics.v_activity");
      expect(params).toMatchObject({
        userId: "user-1",
        timezone: "UTC",
        days: 90,
      });
      expect(params.enduranceTypes).toContain("cycling");
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
      expect(query).not.toContain("analytics.v_activity");
      expect(query).toContain("(asum.avg_left_torque_eff + asum.avg_right_torque_eff) / 2");
      expect(query).toContain("(asum.avg_left_pedal_smooth + asum.avg_right_pedal_smooth) / 2");
      expect(params).toMatchObject({
        userId: "user-1",
        timezone: "UTC",
        days: 90,
      });
      expect(params.enduranceTypes).toContain("cycling");
    });
  });
});
