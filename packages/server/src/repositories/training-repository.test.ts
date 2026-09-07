import { describe, expect, it, vi } from "vitest";
import type { AccessWindow } from "../billing/entitlement.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import {
  collectSqlText,
  expectSensorStoreFiniteDaysFilter,
  expectSensorStoreUnboundedDaysFilter,
} from "./test-helpers.ts";
import { TrainingRepository } from "./training-repository.ts";

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

describe("TrainingRepository", () => {
  function executedSql(execute: CallableVitestMock, callIndex = 0): string {
    return collectSqlText(execute.mock.calls[callIndex]?.[0]);
  }

  function makeSensorStore(rows: unknown[], rawActivityCount = rows.length): ActivitySensorStore {
    // Mirror ClickHouseActivitySensorStore.query: parse each row through the
    // supplied Zod schema so timestampStringSchema and friends actually run.
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

  function makeRepository(
    rows: Record<string, unknown>[] = [],
    accessWindow?: AccessWindow,
    rawActivityCount = rows.length,
    visibleActivityIds: string[] = rows.map((row) => String(row.id)),
  ) {
    const execute = vi.fn();
    execute.mockResolvedValueOnce([{ activity_count: rawActivityCount }]);
    if (visibleActivityIds.length > 0) {
      execute.mockResolvedValueOnce(visibleActivityIds.map((id) => ({ id })));
    }
    execute.mockResolvedValue([]);
    const db = { execute };
    const sensorStore = makeSensorStore(rows, rawActivityCount);
    const repo = new TrainingRepository(db, "user-1", "UTC", sensorStore, accessWindow);
    return { repo, execute, sensorStore };
  }

  describe("getWeeklyVolume", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getWeeklyVolume(90);
      expect(result).toEqual([]);
    });

    it("does not scan the activity read model when no raw activities exist", async () => {
      const { repo, execute, sensorStore } = makeRepository([]);

      const result = await repo.getWeeklyVolume(90);

      expect(result).toEqual([]);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(executedSql(execute)).toContain("ended_at IS NOT NULL");
      expect(sensorStore.query).not.toHaveBeenCalled();
    });

    it("reads weekly volume from ClickHouse activity read model", async () => {
      const { repo, execute, sensorStore } = makeRepository([], undefined, 1);
      await repo.getWeeklyVolume(90);

      expect(execute).toHaveBeenCalledTimes(1);
      expect(sensorStore.query).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        expect.stringContaining("FROM analytics.activity_summary"),
        expect.objectContaining({ days: 90, timezone: "UTC", userId: "user-1" }),
      );
      expect(vi.mocked(sensorStore.query).mock.calls[0]?.[1]).toContain(
        "analytics.deduped_activities",
      );
      expect(vi.mocked(sensorStore.query).mock.calls[0]?.[1]).not.toContain("analytics.v_activity");
    });

    it("does not add access-window filters for full access", async () => {
      const accessWindow: AccessWindow = { kind: "full", paid: true, reason: "paid_grant" };
      const { repo, sensorStore } = makeRepository([], accessWindow, 1);
      await repo.getWeeklyVolume(30);

      const query = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
      const params = vi.mocked(sensorStore.query).mock.calls[0]?.[2];

      expect(query).toContain("FROM analytics.activity_summary");
      expect(query).toContain("analytics.deduped_activities");
      expect(query).not.toContain("analytics.v_activity");
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
      const { repo, sensorStore } = makeRepository([], accessWindow, 1);
      await repo.getWeeklyVolume(30);

      const query = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
      const params = vi.mocked(sensorStore.query).mock.calls[0]?.[2];

      expect(query).toContain("AND asum.started_at >= toDateTime({accessStart:String})");
      expect(query).toContain("AND asum.started_at < toDateTime({accessEnd:String})");
      expect(params).toEqual({
        userId: "user-1",
        timezone: "UTC",
        days: 30,
        accessStart: "2024-01-01T00:00:00Z",
        accessEnd: "2024-01-08T00:00:00Z",
      });
    });

    it("applies inclusive finite selected-range lower-bound filters to the raw activity preflight", async () => {
      const { repo, execute, sensorStore } = makeRepository([], undefined, 1);

      await repo.getWeeklyVolume(30);

      expect(executedSql(execute)).toContain("started_at::date >= (CURRENT_DATE -");
      expect(executedSql(execute)).not.toContain("CURRENT_TIMESTAMP -");
      expect(executedSql(execute)).toContain("ended_at IS NOT NULL");
      expect(sensorStore.query).toHaveBeenCalled();
    });

    it("applies finite selected-range lower-bound filters to the weekly volume query", async () => {
      const { repo, sensorStore } = makeRepository([], undefined, 1);

      await repo.getWeeklyVolume(30);

      expectSensorStoreFiniteDaysFilter(sensorStore);
    });

    it("omits selected-range lower-bound filters when days is null", async () => {
      const { repo, sensorStore } = makeRepository([], undefined, 1);

      await repo.getWeeklyVolume(null);

      expectSensorStoreUnboundedDaysFilter(sensorStore);
    });

    it("returns parsed weekly volume rows", async () => {
      const { repo } = makeRepository([
        { week: "2024-01-15", canonical_type: "cycling", count: 3, hours: 4.5 },
      ]);
      const result = await repo.getWeeklyVolume(90);
      expect(result).toHaveLength(1);
      expect(result[0]?.canonical_type).toBe("cycling");
      expect(result[0]?.hours).toBe(4.5);
    });
  });

  describe("getHrZones", () => {
    it("returns null maxHr and empty weeks when no data", async () => {
      const { repo, execute, sensorStore } = makeRepository([]);
      const result = await repo.getHrZones(90);
      expect(result).toEqual({
        maxHr: null,
        weeks: [],
        intensityDistribution: {
          model: "karvonen-five-zone",
          activityScope: "endurance",
          totalSeconds: 0,
          zones: expect.arrayContaining([
            expect.objectContaining({ zone: 0, label: "Below Zone 1", seconds: 0, percent: 0 }),
            expect.objectContaining({ zone: 5, label: "VO2max", seconds: 0, percent: 0 }),
          ]),
          explanation: expect.stringContaining("does not classify training polarization"),
        },
      });
      expect(executedSql(execute)).toContain("ended_at IS NOT NULL");
      expect(executedSql(execute)).toContain("canonical_type IN");
      expect(sensorStore.query).not.toHaveBeenCalled();
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
      expect(result.intensityDistribution).toMatchObject({
        model: "karvonen-five-zone",
        activityScope: "endurance",
        totalSeconds: 585,
        zones: expect.arrayContaining([
          { zone: 0, label: "Below Zone 1", seconds: 75, percent: 12.8 },
          { zone: 2, label: "Aerobic", seconds: 200, percent: 34.2 },
        ]),
      });
    });

    it("returns an empty distribution when activity rows have no usable max heart rate", async () => {
      const { repo } = makeRepository([
        {
          max_hr: null,
          week: "2024-01-15",
          zone0: 75,
          zone1: 100,
          zone2: 200,
          zone3: 150,
          zone4: 50,
          zone5: 10,
        },
      ]);

      await expect(repo.getHrZones(90)).resolves.toEqual({
        maxHr: null,
        weeks: [],
        intensityDistribution: {
          model: "karvonen-five-zone",
          activityScope: "endurance",
          totalSeconds: 0,
          zones: expect.arrayContaining([
            expect.objectContaining({ zone: 0, seconds: 0, percent: 0 }),
            expect.objectContaining({ zone: 5, seconds: 0, percent: 0 }),
          ]),
          explanation: expect.stringContaining("does not classify training polarization"),
        },
      });
    });

    it("uses activity-specific heart-rate values in canonical zone SQL", async () => {
      const { repo, sensorStore } = makeRepository([], undefined, 1);

      await repo.getHrZones(90);

      const query = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
      expect(query).toContain("am.resting_hr + (am.max_hr - am.resting_hr)");
      expect(query).not.toContain("{restingHr:Float64}");
      expect(query).not.toContain("{maxHr:Float64}");
    });

    it("bounds heart-rate samples in the activity join", async () => {
      const { repo, sensorStore } = makeRepository([], undefined, 1);

      await repo.getHrZones(90);

      const query = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
      expect(query).toContain("INNER JOIN activity_meta am");
      expect(query).toContain("ON ds.user_id = am.user_id");
      expect(query).toContain("AND ds.recorded_at >= am.started_at");
      expect(query).toContain(
        "AND ds.recorded_at <= coalesce(am.ended_at, am.started_at + INTERVAL 12 HOUR)",
      );
    });

    it("applies finite selected-range lower-bound filters", async () => {
      const { repo, sensorStore } = makeRepository([], undefined, 1);

      await repo.getHrZones(30);

      const query = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
      const params = vi.mocked(sensorStore.query).mock.calls[0]?.[2];
      expect(query).toContain("asum.started_at > today() - INTERVAL {days:Int32} DAY");
      expect(query).toContain("toDate({rhrWindowStart:String})");
      expect(params).toHaveProperty("days", 30);
      expect(params).toHaveProperty("rhrWindowStart");
    });

    it("omits selected-range lower-bound filters when days is null", async () => {
      const { repo, sensorStore } = makeRepository([], undefined, 1);

      await repo.getHrZones(null);

      const query = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
      const params = vi.mocked(sensorStore.query).mock.calls[0]?.[2];
      expect(query).not.toContain("asum.started_at > now() - INTERVAL {days:Int32} DAY");
      expect(query).not.toContain("toDate({rhrWindowStart:String})");
      expect(params).not.toHaveProperty("days");
      expect(params).not.toHaveProperty("rhrWindowStart");
    });
  });

  describe("getActivityStats", () => {
    it("returns empty array when no data", async () => {
      const { repo, sensorStore } = makeRepository([]);
      const result = await repo.getActivityStats(90);
      expect(result).toEqual([]);
      expect(sensorStore.query).not.toHaveBeenCalled();
    });

    it("selects the activity view id into the UI row id", async () => {
      const { repo, sensorStore } = makeRepository([], undefined, 1);
      await repo.getActivityStats(90);
      const query = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
      expect(query).toContain("toString(a.activity_id) AS id");
      expect(query).toContain("FROM analytics.activity_summary a");
      expect(query).not.toContain("analytics.v_activity");
    });

    it("reads sample counts from the activity summary read model", async () => {
      const { repo, sensorStore } = makeRepository([], undefined, 1);

      await repo.getActivityStats(90);

      const query = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
      expect(query).toContain("coalesce(a.hr_sample_count, 0) AS hr_samples");
      expect(query).toContain("coalesce(a.power_sample_count, 0) AS power_samples");
      expect(query).not.toContain("sample_counts AS");
      expect(query).not.toContain("INNER JOIN analytics.deduped_sensor AS samples");
    });

    it("returns activity stats rows", async () => {
      const { repo } = makeRepository([
        {
          id: "act-1",
          canonical_type: "running",
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
      expect(result[0]?.canonical_type).toBe("running");
      expect(result[0]?.avg_hr).toBe(145.5);
      expect(result[0]?.distance_meters).toBe(10500);
    });

    it("excludes activities hidden in Postgres even when ClickHouse is stale", async () => {
      const { repo, execute } = makeRepository(
        [
          {
            id: "act-hidden",
            canonical_type: "running",
            name: "Deleted Run",
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
        ],
        undefined,
        1,
        [],
      );

      const result = await repo.getActivityStats(90);

      expect(result).toEqual([]);
      expect(executedSql(execute, 1)).toContain("FROM fitness.v_activity");
    });

    it("returns activities without sensor data (null stats from LEFT JOIN)", async () => {
      const { repo } = makeRepository([
        {
          id: "act-no-sensor",
          canonical_type: "strength",
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
          canonical_type: "cycling",
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

  describe("getActivityStatsAndWeeklyVolume", () => {
    it("returns empty arrays when no raw activities exist", async () => {
      const { repo, execute, sensorStore } = makeRepository([]);
      const result = await repo.getActivityStatsAndWeeklyVolume(90);
      expect(result).toEqual({ activities: [], weeklyVolume: [] });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(sensorStore.query).not.toHaveBeenCalled();
    });

    it("returns activities and weekly volume with a single activity count lookup", async () => {
      const query = vi
        .fn()
        .mockImplementation(
          async (schema: { parse: (row: unknown) => unknown }, queryText = "") => {
            if (queryText.includes("toString(a.activity_id) AS id")) {
              return [
                schema.parse({
                  id: "act-1",
                  canonical_type: "running",
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
                }),
              ];
            }
            return [
              schema.parse({
                week: "2024-01-15",
                canonical_type: "running",
                count: 3,
                hours: 4.5,
              }),
            ];
          },
        );
      const execute = vi.fn();
      execute.mockResolvedValueOnce([{ activity_count: 1 }]);
      execute.mockResolvedValueOnce([{ id: "act-1" }]);
      execute.mockResolvedValue([]);
      const db = { execute };
      const sensorStore = {
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
      const repo = new TrainingRepository(db, "user-1", "UTC", sensorStore);

      const result = await repo.getActivityStatsAndWeeklyVolume(90);

      expect(execute).toHaveBeenCalledTimes(2);
      expect(query).toHaveBeenCalledTimes(2);
      expect(result.activities).toHaveLength(1);
      expect(result.activities[0]?.canonical_type).toBe("running");
      expect(result.weeklyVolume).toHaveLength(1);
      expect(result.weeklyVolume[0]?.hours).toBe(4.5);
    });

    it("scopes activity stats to limited access windows", async () => {
      const accessWindow: AccessWindow = {
        kind: "limited",
        paid: false,
        reason: "free_signup_week",
        startDate: "2024-01-01T00:00:00Z",
        endDateExclusive: "2024-01-08T00:00:00Z",
      };
      const query = vi
        .fn()
        .mockImplementation(
          async (schema: { parse: (row: unknown) => unknown }, queryText = "") => {
            if (queryText.includes("toString(a.activity_id) AS id")) {
              return [
                schema.parse({
                  id: "act-in-window",
                  canonical_type: "running",
                  name: "In Window Run",
                  started_at: "2024-01-03T08:00:00Z",
                  ended_at: "2024-01-03T09:00:00Z",
                  avg_hr: 145.5,
                  max_hr: 175,
                  avg_power: null,
                  max_power: null,
                  avg_cadence: 82.3,
                  hr_samples: 3600,
                  power_samples: null,
                  distance_meters: 10500,
                }),
              ];
            }
            return [
              schema.parse({
                week: "2024-01-01",
                canonical_type: "running",
                count: 1,
                hours: 1,
              }),
            ];
          },
        );
      const execute = vi.fn();
      execute.mockResolvedValueOnce([{ activity_count: 1 }]);
      execute.mockResolvedValueOnce([{ id: "act-in-window" }]);
      execute.mockResolvedValue([]);
      const db = { execute };
      const sensorStore = {
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
      const repo = new TrainingRepository(db, "user-1", "UTC", sensorStore, accessWindow);

      const result = await repo.getActivityStatsAndWeeklyVolume(90);

      const activityQuery = query.mock.calls.find((call) =>
        String(call[1]).includes("toString(a.activity_id) AS id"),
      );
      expect(String(activityQuery?.[1])).toContain(
        "a.started_at >= toDateTime({accessStart:String})",
      );
      expect(String(activityQuery?.[1])).toContain("a.started_at < toDateTime({accessEnd:String})");
      expect(activityQuery?.[2]).toMatchObject({
        accessStart: "2024-01-01T00:00:00Z",
        accessEnd: "2024-01-08T00:00:00Z",
      });
      expect(result.activities).toHaveLength(1);
      expect(result.activities[0]?.id).toBe("act-in-window");
    });
  });
});
