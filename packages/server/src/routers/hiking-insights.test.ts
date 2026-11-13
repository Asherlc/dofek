import { describe, expect, it, vi } from "vitest";
import {
  firstHikingActivityId,
  hikingComparisonRow,
  secondHikingActivityId,
} from "../repositories/hiking-test-helpers.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      userId: string | null;
      timezone: string;
      sensorStore?: import("../repositories/activity-repository.ts").ActivitySensorStore;
    }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

type SensorStore = import("../repositories/activity-repository.ts").ActivitySensorStore;

function makeSensorStore(rows: unknown[] = []): SensorStore {
  return {
    query: vi.fn(async (_schema: unknown, query: string) => {
      if (
        query.includes("analytics.daily_sleep") ||
        query.includes("analytics.v_body_measurement")
      ) {
        return [];
      }
      return rows;
    }),
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

vi.mock("../lib/typed-sql.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/typed-sql.ts")>();
  return {
    ...original,
    executeWithSchema: vi.fn(
      async (
        db: { execute: (q: unknown) => Promise<unknown[]> },
        _schema: unknown,
        query: unknown,
      ) => db.execute(query),
    ),
  };
});

vi.mock("../insights/engine.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../insights/engine.ts")>();
  return {
    ...actual,
    computeInsights: vi.fn(() => ({ insights: ["test-insight"] })),
  };
});

import { hikingRouter } from "./hiking.ts";
import { insightsRouter } from "./insights.ts";

describe("hikingRouter", () => {
  const createCaller = createTestCallerFactory(hikingRouter);

  function makeCaller(rows: Record<string, unknown>[] = []) {
    return createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore(rows),
    });
  }

  describe("gradeAdjustedPace", () => {
    it("fails loudly when ClickHouse activity analytics are unavailable", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(caller.gradeAdjustedPace({ days: 90 })).rejects.toThrow(
        "hiking.gradeAdjustedPace requires the ClickHouse activity analytics store",
      );
    });

    it("returns empty array when no data", async () => {
      const caller = makeCaller([]);
      const result = await caller.gradeAdjustedPace({ days: 90 });
      expect(result).toEqual([]);
    });

    it("computes grade-adjusted pace for uphill activity", async () => {
      const rows = [
        {
          activity_id: "hike-1",
          date: "2024-01-15",
          activity_name: "Morning Hike",
          canonical_type: "hiking",
          distance_m: 5000,
          duration_seconds: 3600,
          elevation_gain_m: 300,
          elevation_loss_m: 100,
          avg_grade: 4,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.gradeAdjustedPace({ days: 90 });

      expect(result).toHaveLength(1);
      expect(result[0]?.activityId).toBe("hike-1");
      expect(result[0]?.activityName).toBe("Morning Hike");
      expect(result[0]?.distanceKm).toBe(5);
      expect(result[0]?.durationMinutes).toBe(60);
      expect(result[0]?.averagePaceMinPerKm).toBe(12);
      // Uphill: costFactor > 1, so GAP should be less than average pace
      expect(result[0]?.gradeAdjustedPaceMinPerKm).toBeLessThan(12);
    });

    it("computes grade-adjusted pace for downhill activity", async () => {
      const rows = [
        {
          activity_id: "hike-2",
          date: "2024-01-15",
          activity_name: "Downhill Walk",
          canonical_type: "walking",
          distance_m: 5000,
          duration_seconds: 3000,
          elevation_gain_m: 50,
          elevation_loss_m: 200,
          avg_grade: -3,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.gradeAdjustedPace({ days: 90 });

      expect(result).toHaveLength(1);
      // Downhill: costFactor < 1, so GAP should be more than average pace
      expect(result[0]?.gradeAdjustedPaceMinPerKm).toBeGreaterThan(
        result[0]?.averagePaceMinPerKm ?? 0,
      );
    });
  });

  describe("elevationProfile", () => {
    it("returns weekly elevation data", async () => {
      const rows = [
        { week: "2024-01-15", elevation_gain_m: 1500, activity_count: 3, total_distance_km: 25.5 },
      ];
      const caller = makeCaller(rows);
      const result = await caller.elevationProfile({ days: 365 });

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        week: "2024-01-15",
        elevationGainMeters: 1500,
        activityCount: 3,
        totalDistanceKm: 25.5,
      });
    });
  });

  describe("walkingBiomechanics", () => {
    it("returns biomechanics data with null handling", async () => {
      const rows = [
        {
          date: "2024-01-15",
          walking_speed: 1.5,
          step_length: 75,
          double_support_pct: 25.3,
          asymmetry_pct: null,
          steadiness: null,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.walkingBiomechanics({ days: 90 });

      expect(result).toHaveLength(1);
      expect(result[0]?.walkingSpeedKmh).toBe(5.4); // 1.5 * 3.6
      expect(result[0]?.stepLengthCm).toBe(75);
      expect(result[0]?.asymmetryPct).toBeNull();
      expect(result[0]?.steadiness).toBeNull();
    });
  });

  describe("activityComparison", () => {
    it("returns schema-validated GPS route groups with unavailable pace", async () => {
      const caller = makeCaller([
        hikingComparisonRow({ distance_m: 0, average_pace_min_per_km: 0, avg_heart_rate: null }),
        hikingComparisonRow({
          canonical_activity_id: secondHikingActivityId,
          activity_name: "Afternoon Hike",
        }),
      ]);
      const result = await caller.activityComparison({ days: 365 });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ routeId: firstHikingActivityId, attemptCount: 2 });
      expect(result[0]?.instances[0]).toMatchObject({
        activityId: firstHikingActivityId,
        averagePaceMinPerKm: null,
        avgHeartRate: null,
      });
    });
  });
});

describe("insightsRouter", () => {
  const createCaller = createTestCallerFactory(insightsRouter);

  it("calls computeInsights with fetched data", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore([]),
    });
    const result = await caller.compute({ days: 90, endDate: "2026-03-15" });

    expect(result).toEqual({ insights: ["test-insight"] });
    // Activities and nutrition stay in Postgres; metrics, resting HR, sleep, and body comp come from ClickHouse.
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
