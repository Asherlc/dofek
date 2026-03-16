import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const t = initTRPC.context<{ db: unknown; userId: string | null }>().create();
  return {
    router: t.router,
    protectedProcedure: t.procedure,
    cachedProtectedQuery: () => t.procedure,
    cachedProtectedQueryLight: () => t.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

vi.mock("../../lib/typed-sql.ts", () => ({
  executeWithSchema: vi.fn(async (db: { execute: () => Promise<unknown[]> }) => db.execute()),
}));

vi.mock("../../insights/engine.ts", () => ({
  computeInsights: vi.fn(() => ({ insights: ["test-insight"] })),
}));

import { hikingRouter } from "../hiking.ts";
import { insightsRouter } from "../insights.ts";
import { lifeEventsRouter } from "../life-events.ts";

describe("hikingRouter", () => {
  const createCaller = createTestCallerFactory(hikingRouter);

  function makeCaller(rows: Record<string, unknown>[] = []) {
    return createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) } as never,
      userId: "user-1",
    });
  }

  describe("gradeAdjustedPace", () => {
    it("returns empty array when no data", async () => {
      const caller = makeCaller([]);
      const result = await caller.gradeAdjustedPace({ days: 90 });
      expect(result).toEqual([]);
    });

    it("computes grade-adjusted pace for uphill activity", async () => {
      const rows = [
        {
          date: "2024-01-15",
          activity_name: "Morning Hike",
          activity_type: "hiking",
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
          date: "2024-01-15",
          activity_name: "Downhill Walk",
          activity_type: "walking",
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
    it("groups repeated activities", async () => {
      const rows = [
        {
          activity_name: "Trail Loop",
          date: "2024-01-01",
          duration_minutes: 60,
          average_pace_min_per_km: 8.5,
          avg_heart_rate: 145,
          elevation_gain_m: 200,
        },
        {
          activity_name: "Trail Loop",
          date: "2024-01-15",
          duration_minutes: 55,
          average_pace_min_per_km: 8.2,
          avg_heart_rate: 140,
          elevation_gain_m: 200,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.activityComparison({ days: 365 });

      expect(result).toHaveLength(1);
      expect(result[0]?.activityName).toBe("Trail Loop");
      expect(result[0]?.instances).toHaveLength(2);
    });

    it("handles null heart rate", async () => {
      const rows = [
        {
          activity_name: "Walk",
          date: "2024-01-01",
          duration_minutes: 30,
          average_pace_min_per_km: 10,
          avg_heart_rate: null,
          elevation_gain_m: 50,
        },
        {
          activity_name: "Walk",
          date: "2024-01-02",
          duration_minutes: 35,
          average_pace_min_per_km: 9.5,
          avg_heart_rate: 130,
          elevation_gain_m: 55,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.activityComparison({ days: 365 });

      expect(result[0]?.instances[0]?.avgHeartRate).toBeNull();
      expect(result[0]?.instances[1]?.avgHeartRate).toBe(130);
    });
  });
});

describe("insightsRouter", () => {
  const createCaller = createTestCallerFactory(insightsRouter);

  it("calls computeInsights with fetched data", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const caller = createCaller({
      db: { execute } as never,
      userId: "user-1",
    });
    const result = await caller.compute({ days: 90 });

    expect(result).toEqual({ insights: ["test-insight"] });
    // Should call execute 5 times (metrics, sleep, activities, nutrition, bodyComp)
    expect(execute).toHaveBeenCalledTimes(5);
  });
});

describe("lifeEventsRouter", () => {
  const createCaller = createTestCallerFactory(lifeEventsRouter);

  function makeCaller(rows: Record<string, unknown>[] = []) {
    return createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) } as never,
      userId: "user-1",
    });
  }

  describe("list", () => {
    it("returns life events", async () => {
      const rows = [{ id: "1", label: "Vacation", started_at: "2024-01-01" }];
      const caller = makeCaller(rows);
      const result = await caller.list();
      expect(result).toEqual(rows);
    });
  });

  describe("create", () => {
    it("creates a life event", async () => {
      const created = { id: "new-1", label: "Surgery" };
      const caller = makeCaller([created]);
      const result = await caller.create({
        label: "Surgery",
        startedAt: "2024-01-15",
      });
      expect(result).toEqual(created);
    });
  });

  describe("update", () => {
    it("updates a life event", async () => {
      const updated = { id: "1", label: "Updated" };
      const caller = makeCaller([updated]);
      const result = await caller.update({
        id: "00000000-0000-0000-0000-000000000001",
        label: "Updated",
      });
      expect(result).toEqual(updated);
    });

    it("returns null when no fields to update", async () => {
      const caller = makeCaller([]);
      const result = await caller.update({
        id: "00000000-0000-0000-0000-000000000001",
      });
      expect(result).toBeNull();
    });

    it("handles setting endedAt to null", async () => {
      const updated = { id: "1", ended_at: null };
      const caller = makeCaller([updated]);
      const result = await caller.update({
        id: "00000000-0000-0000-0000-000000000001",
        endedAt: null,
      });
      expect(result).toEqual(updated);
    });
  });

  describe("delete", () => {
    it("deletes a life event", async () => {
      const caller = makeCaller([]);
      const result = await caller.delete({
        id: "00000000-0000-0000-0000-000000000001",
      });
      expect(result).toEqual({ success: true });
    });
  });

  describe("analyze", () => {
    it("returns null when event not found", async () => {
      const caller = makeCaller([]);
      const result = await caller.analyze({
        id: "00000000-0000-0000-0000-000000000001",
        windowDays: 30,
      });
      expect(result).toBeNull();
    });

    it("returns analysis for an event", async () => {
      const execute = vi.fn();
      // First call: get event
      execute.mockResolvedValueOnce([{ started_at: "2024-06-01", ended_at: null, ongoing: false }]);
      // Second call: metrics before/after
      execute.mockResolvedValueOnce([
        { period: "before", days: 10, avg_resting_hr: 55 },
        { period: "after", days: 10, avg_resting_hr: 58 },
      ]);
      // Third call: sleep
      execute.mockResolvedValueOnce([]);
      // Fourth call: body comp
      execute.mockResolvedValueOnce([]);

      const caller = createCaller({
        db: { execute } as never,
        userId: "user-1",
      });
      const result = await caller.analyze({
        id: "00000000-0000-0000-0000-000000000001",
        windowDays: 30,
      });

      expect(result).not.toBeNull();
      expect(result?.event).toBeDefined();
      expect(result?.metrics).toHaveLength(2);
    });
  });
});
