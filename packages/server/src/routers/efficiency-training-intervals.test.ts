import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
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

vi.mock("../lib/endurance-types.ts", () => ({
  enduranceTypeFilter: () => ({ sql: "true" }),
}));

import { efficiencyRouter } from "./efficiency.ts";
import { intervalsRouter } from "./intervals.ts";
import { trainingRouter } from "./training.ts";

describe("efficiencyRouter", () => {
  const createCaller = createTestCallerFactory(efficiencyRouter);

  describe("aerobicEfficiency", () => {
    it("returns activities with efficiency factor", async () => {
      const rows = [
        {
          max_hr: 190,
          date: "2024-01-15",
          activity_type: "cycling",
          name: "Morning Ride",
          avg_power_z2: 180,
          avg_hr_z2: 140,
          efficiency_factor: 1.286,
          z2_samples: 600,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.aerobicEfficiency({ days: 180 });

      expect(result.maxHr).toBe(190);
      expect(result.activities).toHaveLength(1);
      expect(result.activities[0]?.efficiencyFactor).toBe(1.286);
    });

    it("returns null maxHr when no data", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });
      const result = await caller.aerobicEfficiency({ days: 180 });
      expect(result.maxHr).toBeNull();
      expect(result.activities).toEqual([]);
    });
  });

  describe("aerobicDecoupling", () => {
    it("returns decoupling data", async () => {
      const rows = [
        {
          date: "2024-01-15",
          activity_type: "running",
          name: "Long Run",
          first_half_ratio: 1.5,
          second_half_ratio: 1.3,
          decoupling_pct: 13.33,
          total_samples: 3600,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.aerobicDecoupling({ days: 180 });

      expect(result).toHaveLength(1);
      expect(result[0]?.decouplingPct).toBe(13.33);
    });
  });

  describe("polarizationTrend", () => {
    it("computes polarization index", async () => {
      const rows = [
        {
          max_hr: 190,
          week: "2024-01-15",
          z1_seconds: 5000,
          z2_seconds: 500,
          z3_seconds: 100,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.polarizationTrend({ days: 180 });

      expect(result.maxHr).toBe(190);
      expect(result.weeks).toHaveLength(1);
      expect(result.weeks[0]?.polarizationIndex).not.toBeNull();
    });

    it("returns null polarization index when zones are 0", async () => {
      const rows = [
        { max_hr: 190, week: "2024-01-15", z1_seconds: 5000, z2_seconds: 0, z3_seconds: 0 },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.polarizationTrend({ days: 180 });

      expect(result.weeks[0]?.polarizationIndex).toBeNull();
    });
  });
});

describe("trainingRouter", () => {
  const createCaller = createTestCallerFactory(trainingRouter);

  describe("weeklyVolume", () => {
    it("returns weekly volume rows", async () => {
      const rows = [{ week: "2024-01-15", activity_type: "cycling", count: 3, hours: 5.5 }];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.weeklyVolume({ days: 90 });
      expect(result).toEqual(rows);
    });

    it("coerces string hours from Postgres numeric type", async () => {
      // Postgres ROUND(...)::numeric returns strings via the pg driver
      const rows = [{ week: "2024-01-15", activity_type: "cycling", count: 3, hours: "5.50" }];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.weeklyVolume({ days: 90 });
      expect(result[0]?.hours).toBe(5.5);
      expect(typeof result[0]?.hours).toBe("number");
    });
  });

  describe("hrZones", () => {
    it("returns zones with maxHr", async () => {
      const rows = [
        {
          max_hr: 190,
          week: "2024-01-15",
          zone1: 500,
          zone2: 1000,
          zone3: 800,
          zone4: 300,
          zone5: 50,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.hrZones({ days: 90 });
      expect(result.maxHr).toBe(190);
      expect(result.weeks).toEqual(rows);
    });

    it("returns null maxHr when no data", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });
      const result = await caller.hrZones({ days: 90 });
      expect(result.maxHr).toBeNull();
      expect(result.weeks).toEqual([]);
    });
  });

  describe("activityStats", () => {
    it("returns activity stats rows", async () => {
      const rows = [{ id: "a1", activity_type: "cycling", avg_hr: 155 }];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.activityStats({ days: 90 });
      expect(result).toEqual(rows);
    });
  });
});

describe("intervalsRouter", () => {
  const createCaller = createTestCallerFactory(intervalsRouter);

  describe("byActivity", () => {
    it("returns interval rows", async () => {
      const rows = [{ id: "i1", interval_index: 0, label: "Warmup", avg_power: 100 }];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.byActivity({
        activityId: "00000000-0000-0000-0000-000000000001",
      });
      expect(result).toEqual(rows);
    });
  });

  describe("detect", () => {
    it("returns empty when no stream data", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });
      const result = await caller.detect({
        activityId: "00000000-0000-0000-0000-000000000001",
      });
      expect(result).toEqual([]);
    });

    it("detects intervals from power changes", async () => {
      // Create minute-level data with a significant power change
      const rows = [
        {
          minute_start: "2024-01-01T10:00:00Z",
          avg_power: 100,
          avg_hr: null,
          avg_speed: 5,
          avg_cadence: 80,
          max_power: 120,
          max_hr: null,
          max_speed: 6,
          distance: 0,
        },
        {
          minute_start: "2024-01-01T10:01:00Z",
          avg_power: 100,
          avg_hr: null,
          avg_speed: 5,
          avg_cadence: 80,
          max_power: 110,
          max_hr: null,
          max_speed: 6,
          distance: 300,
        },
        {
          minute_start: "2024-01-01T10:02:00Z",
          avg_power: 250,
          avg_hr: null,
          avg_speed: 8,
          avg_cadence: 95,
          max_power: 300,
          max_hr: null,
          max_speed: 9,
          distance: 600,
        },
        {
          minute_start: "2024-01-01T10:03:00Z",
          avg_power: 260,
          avg_hr: null,
          avg_speed: 8,
          avg_cadence: 95,
          max_power: 310,
          max_hr: null,
          max_speed: 9,
          distance: 900,
        },
        {
          minute_start: "2024-01-01T10:04:00Z",
          avg_power: 100,
          avg_hr: null,
          avg_speed: 5,
          avg_cadence: 80,
          max_power: 120,
          max_hr: null,
          max_speed: 6,
          distance: 1200,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.detect({
        activityId: "00000000-0000-0000-0000-000000000001",
      });

      // Should detect at least 2 intervals (intensity change)
      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result[0]).toHaveProperty("intervalIndex", 0);
    });

    it("falls back to HR when no power data", async () => {
      const rows = [
        {
          minute_start: "2024-01-01T10:00:00Z",
          avg_power: null,
          avg_hr: 120,
          avg_speed: 5,
          avg_cadence: null,
          max_power: null,
          max_hr: 130,
          max_speed: 6,
          distance: 0,
        },
        {
          minute_start: "2024-01-01T10:01:00Z",
          avg_power: null,
          avg_hr: 120,
          avg_speed: 5,
          avg_cadence: null,
          max_power: null,
          max_hr: 130,
          max_speed: 6,
          distance: 300,
        },
        {
          minute_start: "2024-01-01T10:02:00Z",
          avg_power: null,
          avg_hr: 175,
          avg_speed: 8,
          avg_cadence: null,
          max_power: null,
          max_hr: 185,
          max_speed: 9,
          distance: 600,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.detect({
        activityId: "00000000-0000-0000-0000-000000000001",
      });

      expect(result.length).toBeGreaterThanOrEqual(1);
    });
  });
});
