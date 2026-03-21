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

vi.mock("../lib/endurance-types.ts", () => ({
  enduranceTypeFilter: () => ({ sql: "true" }),
}));

vi.mock("dofek/personalization/storage", () => ({
  loadPersonalizedParams: vi.fn(async () => null),
}));

vi.mock("dofek/personalization/params", () => ({
  getEffectiveParams: vi.fn(() => ({
    readinessWeights: {
      hrv: 0.4,
      restingHr: 0.2,
      sleep: 0.2,
      loadBalance: 0.2,
    },
  })),
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

    it("coerces PostgreSQL numeric strings to numbers via Zod schema", async () => {
      // PostgreSQL ROUND(...)::numeric returns strings like "5.50".
      // The weeklyVolumeRowSchema uses z.coerce.number() to convert them.
      const { executeWithSchema } = await import("../lib/typed-sql.ts");
      const mockExecuteWithSchema = vi.mocked(executeWithSchema);

      mockExecuteWithSchema.mockImplementationOnce(async (_db, schema, query) => {
        const rawRows = await (_db as { execute: (q: unknown) => Promise<unknown[]> }).execute(query);
        return rawRows.map((row) => schema.parse(row));
      });

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

  describe("nextWorkout", () => {
    function dateDaysAgo(days: number): string {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - days);
      return d.toISOString().slice(0, 10);
    }

    it("recommends rest when readiness is low", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce([
          {
            date: dateDaysAgo(0),
            hrv: 30,
            resting_hr: 72,
            hrv_mean_60d: 50,
            hrv_sd_60d: 10,
            rhr_mean_60d: 60,
            rhr_sd_60d: 6,
          },
        ])
        .mockResolvedValueOnce([{ efficiency_pct: 45 }])
        .mockResolvedValueOnce([{ acwr: 1.6 }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            strength_7d: 1,
            endurance_7d: 2,
            last_strength_date: dateDaysAgo(2),
            last_endurance_date: dateDaysAgo(1),
          },
        ])
        .mockResolvedValueOnce([{ zone1: 1000, zone2: 500, zone3: 100, zone4: 300, zone5: 100 }])
        .mockResolvedValueOnce([{ hiit_count_7d: 1, last_hiit_date: dateDaysAgo(1) }])
        .mockResolvedValueOnce([]);

      const caller = createCaller({ db: { execute }, userId: "user-1" });
      const result = await caller.nextWorkout();

      expect(result.recommendationType).toBe("rest");
      expect(result.cardio?.focus).toBe("recovery");
      expect(result.shortBlurb.toLowerCase()).toContain("lighter day");
    });

    it("recommends strength when strength frequency is low and muscles are recovered", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce([
          {
            date: dateDaysAgo(0),
            hrv: 58,
            resting_hr: 55,
            hrv_mean_60d: 50,
            hrv_sd_60d: 8,
            rhr_mean_60d: 60,
            rhr_sd_60d: 5,
          },
        ])
        .mockResolvedValueOnce([{ efficiency_pct: 90 }])
        .mockResolvedValueOnce([{ acwr: 1.0 }])
        .mockResolvedValueOnce([
          { muscle_group: "chest", last_trained_date: dateDaysAgo(3) },
          { muscle_group: "back", last_trained_date: dateDaysAgo(4) },
        ])
        .mockResolvedValueOnce([
          {
            strength_7d: 0,
            endurance_7d: 4,
            last_strength_date: dateDaysAgo(3),
            last_endurance_date: dateDaysAgo(1),
          },
        ])
        .mockResolvedValueOnce([{ zone1: 4000, zone2: 3000, zone3: 600, zone4: 300, zone5: 100 }])
        .mockResolvedValueOnce([{ hiit_count_7d: 1, last_hiit_date: dateDaysAgo(3) }])
        .mockResolvedValueOnce([{ training_date: dateDaysAgo(1) }]);

      const caller = createCaller({ db: { execute }, userId: "user-1" });
      const result = await caller.nextWorkout();

      expect(result.recommendationType).toBe("strength");
      expect(result.strength).not.toBeNull();
      expect(result.strength?.focusMuscles).toContain("chest");
    });

    it("recommends z2 cardio when readiness is moderate", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce([
          {
            date: dateDaysAgo(0),
            hrv: 50,
            resting_hr: 60,
            hrv_mean_60d: 50,
            hrv_sd_60d: 10,
            rhr_mean_60d: 60,
            rhr_sd_60d: 6,
          },
        ])
        .mockResolvedValueOnce([{ efficiency_pct: 70 }])
        .mockResolvedValueOnce([{ acwr: 1.1 }])
        .mockResolvedValueOnce([{ muscle_group: "chest", last_trained_date: dateDaysAgo(0) }])
        .mockResolvedValueOnce([
          {
            strength_7d: 3,
            endurance_7d: 4,
            last_strength_date: dateDaysAgo(0),
            last_endurance_date: dateDaysAgo(2),
          },
        ])
        .mockResolvedValueOnce([{ zone1: 3000, zone2: 2200, zone3: 900, zone4: 500, zone5: 150 }])
        .mockResolvedValueOnce([{ hiit_count_7d: 2, last_hiit_date: dateDaysAgo(2) }])
        .mockResolvedValueOnce([{ training_date: dateDaysAgo(0) }]);

      const caller = createCaller({ db: { execute }, userId: "user-1" });
      const result = await caller.nextWorkout();

      expect(result.recommendationType).toBe("cardio");
      expect(result.cardio?.focus).toBe("z2");
    });

    it("recommends interval cardio when high-intensity volume is low and readiness is high", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce([
          {
            date: dateDaysAgo(0),
            hrv: 60,
            resting_hr: 54,
            hrv_mean_60d: 50,
            hrv_sd_60d: 8,
            rhr_mean_60d: 60,
            rhr_sd_60d: 5,
          },
        ])
        .mockResolvedValueOnce([{ efficiency_pct: 92 }])
        .mockResolvedValueOnce([{ acwr: 1.0 }])
        .mockResolvedValueOnce([{ muscle_group: "chest", last_trained_date: dateDaysAgo(0) }])
        .mockResolvedValueOnce([
          {
            strength_7d: 3,
            endurance_7d: 4,
            last_strength_date: dateDaysAgo(0),
            last_endurance_date: dateDaysAgo(2),
          },
        ])
        .mockResolvedValueOnce([
          {
            zone1: 5000,
            zone2: 3000,
            zone3: 500,
            zone4: 700,
            zone5: 250,
          },
        ])
        .mockResolvedValueOnce([{ hiit_count_7d: 1, last_hiit_date: dateDaysAgo(3) }])
        .mockResolvedValueOnce([{ training_date: dateDaysAgo(0) }]);

      const caller = createCaller({ db: { execute }, userId: "user-1" });
      const result = await caller.nextWorkout();

      expect(result.recommendationType).toBe("cardio");
      expect(result.cardio?.focus).toBe("intervals");
      expect(result.cardio?.targetZones).toContain("Z4");
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
