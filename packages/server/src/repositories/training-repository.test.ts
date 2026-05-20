import { describe, expect, it, vi } from "vitest";
import type { AccessWindow } from "../billing/entitlement.ts";
import { type NextWorkoutData, TrainingRepository } from "./training-repository.ts";

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

describe("TrainingRepository", () => {
  // biome-ignore lint/suspicious/noExplicitAny: test mock helper
  function makeSensorStore(rows: unknown[]): any {
    // Mirror ClickHouseActivitySensorStore.query: parse each row through the
    // supplied Zod schema so timestampStringSchema and friends actually run.
    const query = vi
      .fn()
      .mockImplementation(async (schema: { parse: (row: unknown) => unknown }) => {
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

  function makeRepository(rows: Record<string, unknown>[] = [], accessWindow?: AccessWindow) {
    // Tests pass `rows` to be returned by either PG or CH; the migration
    // moved most queries to CH, but for backward-compat with this test's
    // pattern, mock both to return the same rows.
    const execute = vi.fn().mockResolvedValue(rows);
    const db = { execute };
    const sensorStore = makeSensorStore(rows);
    const repo = new TrainingRepository(db, "user-1", "UTC", sensorStore, accessWindow);
    return { repo, execute, sensorStore };
  }

  function makeNextWorkoutData(overrides: Partial<NextWorkoutData> = {}): NextWorkoutData {
    return {
      latestMetric: null,
      latestSleepEfficiency: null,
      acwr: null,
      muscleFreshness: [],
      balance: {
        strength_7d: 0,
        endurance_7d: 0,
        last_strength_date: null,
        last_endurance_date: null,
      },
      zoneTotals: { zone0: 0, zone1: 0, zone2: 0, zone3: 0, zone4: 0, zone5: 0 },
      hiitLoad: { hiit_count_7d: 0, last_hiit_date: null },
      trainingDates: [],
      ...overrides,
    };
  }

  const sleepOnlyWeights = { hrv: 0, restingHr: 0, sleep: 1, respiratoryRate: 0 };

  describe("getWeeklyVolume", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getWeeklyVolume(90);
      expect(result).toEqual([]);
    });

    it("reads weekly volume from ClickHouse activity read model", async () => {
      const { repo, execute, sensorStore } = makeRepository([]);
      await repo.getWeeklyVolume(90);

      expect(execute).not.toHaveBeenCalled();
      expect(sensorStore.query).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("FROM analytics.v_activity"),
        expect.objectContaining({ days: 90, timezone: "UTC", userId: "user-1" }),
      );
    });

    it("does not add access-window filters for full access", async () => {
      const accessWindow: AccessWindow = { kind: "full", paid: true, reason: "paid_grant" };
      const { repo, sensorStore } = makeRepository([], accessWindow);
      await repo.getWeeklyVolume(30);

      const query = sensorStore.query.mock.calls[0]?.[1];
      const params = sensorStore.query.mock.calls[0]?.[2];

      expect(query).toContain("FROM analytics.v_activity");
      expect(query).not.toContain("toDateTime({accessStart:String})");
      expect(query).not.toContain("toDateTime({accessEnd:String})");
      expect(params).toEqual({ userId: "user-1", timezone: "UTC", days: 30 });
    });

    it("adds access-window filters and parameters for limited access", async () => {
      const accessWindow: AccessWindow = {
        kind: "limited",
        paid: false,
        reason: "free_signup_week",
        startDate: "2024-01-01T00:00:00Z",
        endDateExclusive: "2024-01-08T00:00:00Z",
      };
      const { repo, sensorStore } = makeRepository([], accessWindow);
      await repo.getWeeklyVolume(30);

      const query = sensorStore.query.mock.calls[0]?.[1];
      const params = sensorStore.query.mock.calls[0]?.[2];

      expect(query).toContain("AND started_at >= toDateTime({accessStart:String})");
      expect(query).toContain("AND started_at < toDateTime({accessEnd:String})");
      expect(params).toEqual({
        userId: "user-1",
        timezone: "UTC",
        days: 30,
        accessStart: "2024-01-01T00:00:00Z",
        accessEnd: "2024-01-08T00:00:00Z",
      });
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
          zone0: 75,
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
      expect(result.weeks[0]?.zone0).toBe(75);
      expect(result.weeks[0]?.zone2).toBe(200);
    });

    it("uses activity-specific heart-rate values in canonical zone SQL", async () => {
      const { repo, sensorStore } = makeRepository([]);

      await repo.getHrZones(90);

      const query = sensorStore.query.mock.calls[0]?.[1];
      expect(query).toContain("am.resting_hr + (am.max_hr - am.resting_hr)");
      expect(query).not.toContain("{restingHr:Float64}");
      expect(query).not.toContain("{maxHr:Float64}");
    });
  });

  describe("getActivityStats", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getActivityStats(90);
      expect(result).toEqual([]);
    });

    it("selects the activity view id into the UI row id", async () => {
      const { repo, sensorStore } = makeRepository([]);
      await repo.getActivityStats(90);
      const query = sensorStore.query.mock.calls[0]?.[1];
      expect(query).toContain("toString(a.id) AS id");
      expect(query).toContain("FROM analytics.v_activity a");
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
          distance_meters: 10500,
        },
      ]);
      const result = await repo.getActivityStats(90);
      expect(result).toHaveLength(1);
      expect(result[0]?.activity_type).toBe("running");
      expect(result[0]?.avg_hr).toBe(145.5);
      expect(result[0]?.distance_meters).toBe(10500);
    });

    it("returns activities without sensor data (null stats from LEFT JOIN)", async () => {
      const { repo } = makeRepository([
        {
          id: "act-no-sensor",
          activity_type: "strength_training",
          name: "Gym Session",
          started_at: "2024-01-15T10:00:00Z",
          ended_at: "2024-01-15T11:00:00Z",
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          max_power: null,
          avg_cadence: null,
          hr_samples: null,
          power_samples: null,
          distance_meters: null,
        },
      ]);
      const result = await repo.getActivityStats(90);
      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe("act-no-sensor");
      expect(result[0]?.avg_hr).toBeNull();
      expect(result[0]?.distance_meters).toBeNull();
    });

    it("normalizes ISO timestamp strings from CH formatDateTime to canonical ISO 8601", async () => {
      // The SQL uses formatDateTime(..., '%Y-%m-%dT%H:%i:%SZ') so CH always
      // returns timestamps as "2024-01-15T14:00:00Z". timestampStringSchema
      // re-parses and emits canonical ISO with milliseconds.
      const { repo } = makeRepository([
        {
          id: "act-2",
          activity_type: "cycling",
          name: "Afternoon Ride",
          started_at: "2024-01-15T14:00:00Z",
          ended_at: "2024-01-15T15:30:00Z",
          avg_hr: 152,
          max_hr: 180,
          avg_power: 230,
          max_power: 550,
          avg_cadence: 90,
          hr_samples: 5400,
          power_samples: 5400,
          distance_meters: 42000,
        },
      ]);
      const result = await repo.getActivityStats(90);
      expect(result).toHaveLength(1);
      expect(result[0]?.started_at).toBe("2024-01-15T14:00:00.000Z");
      expect(result[0]?.ended_at).toBe("2024-01-15T15:30:00.000Z");
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
      expect(data.zoneTotals).toEqual({
        zone0: 0,
        zone1: 0,
        zone2: 0,
        zone3: 0,
        zone4: 0,
        zone5: 0,
      });
      expect(data.hiitLoad).toEqual({ hiit_count_7d: 0, last_hiit_date: null });
      expect(data.trainingDates).toEqual([]);
    });

    it("returns data from non-empty queries", async () => {
      const latestMetricsRows = [
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
      ];
      const muscleRows = [{ muscle_group: "chest", last_trained_date: "2024-01-12" }];
      const balanceRows = [
        {
          strength_7d: 3,
          endurance_7d: 4,
          last_strength_date: "2024-01-13",
          last_endurance_date: "2024-01-14",
        },
      ];
      const trainingRows = [{ training_date: "2024-01-14" }, { training_date: "2024-01-12" }];
      const execute = vi.fn().mockImplementation(async (query: unknown) => {
        const queryText = JSON.stringify(query);
        if (queryText.includes("vitals_baseline")) return latestMetricsRows;
        if (queryText.includes("muscle_group")) return muscleRows;
        if (queryText.includes("strength_data")) return balanceRows;
        if (queryText.includes("training_date")) return trainingRows;
        return [];
      });

      // CH queries (in fetch order): helper RHR, latest sleep, acwr, zoneTotals, hiitLoad.
      const sensorQuery = vi.fn();
      sensorQuery.mockResolvedValueOnce([]);
      sensorQuery.mockResolvedValueOnce([{ date: "2024-01-14", efficiency_pct: 88.5 }]);
      sensorQuery.mockResolvedValueOnce([{ acwr: 1.15 }]);
      sensorQuery.mockResolvedValueOnce([
        { zone0: 75, zone1: 100, zone2: 200, zone3: 150, zone4: 50, zone5: 10 },
      ]);
      sensorQuery.mockResolvedValueOnce([{ hiit_count_7d: 2, last_hiit_date: "2024-01-13" }]);
      const sensorStore = makeSensorStore([]);
      sensorStore.query = sensorQuery;

      const repo = new TrainingRepository({ execute }, "user-1", "UTC", sensorStore);
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
      expect(data.zoneTotals.zone0).toStrictEqual(0);
      expect(data.zoneTotals.zone1).toStrictEqual(0);
      expect(data.zoneTotals.zone2).toStrictEqual(0);
      expect(data.zoneTotals.zone3).toStrictEqual(0);
      expect(data.zoneTotals.zone4).toStrictEqual(0);
      expect(data.zoneTotals.zone5).toStrictEqual(0);
      expect(data.hiitLoad.hiit_count_7d).toStrictEqual(0);
    });

    it("calls execute for PG sub-queries and sensorStore.query for CH sub-queries", async () => {
      const { repo, execute, sensorStore } = makeRepository([]);
      await repo.getNextWorkoutData("2024-01-15");
      // 4 PG queries: latestMetrics, muscleFreshness, balance, trainingDays.
      // 5 CH queries: helper RHR, latest sleep, acwr, zoneTotals, hiitLoad.
      expect(execute).toHaveBeenCalledTimes(4);
      expect(sensorStore.query).toHaveBeenCalledTimes(5);
    });
  });

  describe("getRecommendation", () => {
    it("recommends rest after a long training streak and reports hard cardio load", async () => {
      const { repo } = makeRepository([]);
      const recommendation = await repo.getRecommendation(
        makeNextWorkoutData({
          acwr: 1.1,
          balance: {
            strength_7d: 3,
            endurance_7d: 4,
            last_strength_date: "2024-01-14",
            last_endurance_date: "2024-01-14",
          },
          hiitLoad: { hiit_count_7d: 2, last_hiit_date: "2024-01-14" },
          trainingDates: [
            "2024-01-15",
            "2024-01-14",
            "2024-01-13",
            "2024-01-12",
            "2024-01-11",
            "2024-01-10",
          ],
        }),
        "2024-01-15",
        sleepOnlyWeights,
      );

      expect(recommendation.recommendationType).toBe("rest");
      expect(recommendation.cardio?.focus).toBe("recovery");
      expect(recommendation.cardio?.durationMinutes).toBe(30);
      expect(recommendation.strength).toBeNull();
      expect(recommendation.rationale).toContain("Training streak is 6 consecutive days.");
      expect(recommendation.rationale).toContain("Hard cardio sessions in last 7 days: 2.");
    });

    it("keeps intensity low when readiness is moderate but below the high-performance threshold", async () => {
      const { repo } = makeRepository([]);
      const recommendation = await repo.getRecommendation(
        makeNextWorkoutData({
          latestMetric: {
            date: "2024-01-15",
            hrv: null,
            resting_hr: null,
            respiratory_rate: null,
            hrv_mean_30d: null,
            hrv_sd_30d: null,
            rhr_mean_30d: null,
            rhr_sd_30d: null,
            rr_mean_30d: null,
            rr_sd_30d: null,
          },
          latestSleepEfficiency: 40,
          balance: {
            strength_7d: 2,
            endurance_7d: 2,
            last_strength_date: "2024-01-14",
            last_endurance_date: "2024-01-14",
          },
        }),
        "2024-01-15",
        sleepOnlyWeights,
      );

      expect(recommendation.recommendationType).toBe("cardio");
      expect(recommendation.title).toBe("Easy Aerobic Session");
      expect(recommendation.readiness).toEqual({ score: 40, level: "moderate" });
      expect(recommendation.cardio?.targetZones).toEqual(["Z1", "Z2"]);
      expect(recommendation.rationale).toContain(
        "Readiness is below high-performance threshold; keep intensity low today.",
      );
    });

    it("recommends strength when strength is under target and recovered muscles are available", async () => {
      const { repo } = makeRepository([]);
      const recommendation = await repo.getRecommendation(
        makeNextWorkoutData({
          muscleFreshness: [
            { muscle_group: "lats", last_trained_date: "2024-01-10" },
            { muscle_group: "delts", last_trained_date: "2024-01-11" },
          ],
          balance: {
            strength_7d: 1,
            endurance_7d: 4,
            last_strength_date: "2024-01-10",
            last_endurance_date: "2024-01-14",
          },
        }),
        "2024-01-15",
        sleepOnlyWeights,
      );

      expect(recommendation.recommendationType).toBe("strength");
      expect(recommendation.cardio).toBeNull();
      expect(recommendation.strength?.focusMuscles).toEqual(["back", "shoulders"]);
      expect(recommendation.strength?.lastStrengthDaysAgo).toBe(5);
      expect(recommendation.rationale).toContain("Most recovered muscle groups: back, shoulders.");
    });

    it("recommends aerobic cardio when the weekly HIIT cap was reached recently", async () => {
      const { repo } = makeRepository([]);
      const recommendation = await repo.getRecommendation(
        makeNextWorkoutData({
          balance: {
            strength_7d: 3,
            endurance_7d: 1,
            last_strength_date: "2024-01-14",
            last_endurance_date: "2024-01-13",
          },
          zoneTotals: { zone0: 0, zone1: 50, zone2: 30, zone3: 10, zone4: 5, zone5: 5 },
          hiitLoad: { hiit_count_7d: 3, last_hiit_date: "2024-01-14" },
        }),
        "2024-01-15",
        sleepOnlyWeights,
      );

      expect(recommendation.recommendationType).toBe("cardio");
      expect(recommendation.cardio?.focus).toBe("z2");
      expect(recommendation.cardio?.lastEnduranceDaysAgo).toBe(2);
      expect(recommendation.rationale).toContain(
        "Recent intensity split: 80% low, 10% moderate, 10% high.",
      );
      expect(recommendation.rationale).toContain(
        "HIIT cap reached (3/week), so today stays aerobic.",
      );
      expect(recommendation.rationale).toContain(
        "Less than 48 hours since the last hard cardio session.",
      );
    });
  });
});
