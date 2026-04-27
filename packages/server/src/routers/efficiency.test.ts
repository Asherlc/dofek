import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      userId: string | null;
      timezone: string;
      accessWindow?: import("../billing/entitlement.ts").AccessWindow;
    }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
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
        schema: z.ZodType,
        query: unknown,
      ) => {
        const rows = await db.execute(query);
        return rows.map((row) => schema.parse(row));
      },
    ),
  };
});

vi.mock("../lib/endurance-types.ts", () => ({
  enduranceTypeFilter: () => ({ sql: "true" }),
}));

import { efficiencyRouter } from "./efficiency.ts";

const createCaller = createTestCallerFactory(efficiencyRouter);

describe("efficiencyRouter", () => {
  describe("aerobicEfficiency", () => {
    it("returns activities with exact field mapping", async () => {
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
        timezone: "UTC",
      });
      const result = await caller.aerobicEfficiency({ days: 180 });

      expect(result.maxHr).toBe(190);
      expect(result.activities).toHaveLength(1);
      expect(result.activities[0]).toEqual({
        date: "2024-01-15",
        activityType: "cycling",
        name: "Morning Ride",
        avgPowerZ2: 180,
        avgHrZ2: 140,
        efficiencyFactor: 1.286,
        z2Samples: 600,
      });
    });

    it("returns null maxHr when no data", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.aerobicEfficiency({ days: 180 });
      expect(result.maxHr).toBeNull();
      expect(result.activities).toEqual([]);
    });

    it("returns date as string when DB driver returns Date objects", async () => {
      const rows = [
        {
          max_hr: 190,
          date: new Date("2024-01-15T00:00:00.000Z"),
          activity_type: "cycling",
          name: "Ride",
          avg_power_z2: 180,
          avg_hr_z2: 140,
          efficiency_factor: 1.286,
          z2_samples: 600,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.aerobicEfficiency({ days: 180 });

      expect(typeof result.activities[0]?.date).toBe("string");
      expect(result.activities[0]?.date).toBe("2024-01-15");
    });

    it("maps multiple activities", async () => {
      const rows = [
        {
          max_hr: 185,
          date: "2024-01-10",
          activity_type: "running",
          name: "Run A",
          avg_power_z2: 250,
          avg_hr_z2: 145,
          efficiency_factor: 1.724,
          z2_samples: 400,
        },
        {
          max_hr: 185,
          date: "2024-01-12",
          activity_type: "cycling",
          name: "Ride B",
          avg_power_z2: 190,
          avg_hr_z2: 138,
          efficiency_factor: 1.377,
          z2_samples: 800,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.aerobicEfficiency({ days: 180 });

      expect(result.maxHr).toBe(185);
      expect(result.activities).toHaveLength(2);
      expect(result.activities[0]?.name).toBe("Run A");
      expect(result.activities[1]?.name).toBe("Ride B");
    });
  });

  describe("aerobicDecoupling", () => {
    it("returns exact field mapping", async () => {
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
        timezone: "UTC",
      });
      const result = await caller.aerobicDecoupling({ days: 180 });

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        date: "2024-01-15",
        activityType: "running",
        name: "Long Run",
        firstHalfRatio: 1.5,
        secondHalfRatio: 1.3,
        decouplingPct: 13.33,
        totalSamples: 3600,
      });
    });

    it("returns empty for no data", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.aerobicDecoupling({ days: 180 });
      expect(result).toEqual([]);
    });

    it("returns date as string when DB driver returns Date objects", async () => {
      const rows = [
        {
          date: new Date("2024-01-15T00:00:00.000Z"),
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
        timezone: "UTC",
      });
      const result = await caller.aerobicDecoupling({ days: 180 });

      expect(typeof result[0]?.date).toBe("string");
      expect(result[0]?.date).toBe("2024-01-15");
    });
  });

  describe("polarizationTrend", () => {
    it("computes polarization index using Treff formula with time fractions", async () => {
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
        timezone: "UTC",
      });
      const result = await caller.polarizationTrend({ days: 180 });

      expect(result.maxHr).toBe(190);
      expect(result.weeks).toHaveLength(1);

      // Treff PI = log10((f1 / (f2 * f3)) * 100) where f = fraction of total time
      const total = 5000 + 500 + 100;
      const f1 = 5000 / total;
      const f2 = 500 / total;
      const f3 = 100 / total;
      const expected = Math.round(Math.log10((f1 / (f2 * f3)) * 100) * 1000) / 1000;
      expect(result.weeks[0]?.polarizationIndex).toBe(expected);
    });

    it("returns null polarization index when z2 is 0", async () => {
      const rows = [
        { max_hr: 190, week: "2024-01-15", z1_seconds: 5000, z2_seconds: 0, z3_seconds: 100 },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.polarizationTrend({ days: 180 });
      expect(result.weeks[0]?.polarizationIndex).toBeNull();
    });

    it("returns null polarization index when z3 is 0", async () => {
      const rows = [
        { max_hr: 190, week: "2024-01-15", z1_seconds: 5000, z2_seconds: 500, z3_seconds: 0 },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.polarizationTrend({ days: 180 });
      expect(result.weeks[0]?.polarizationIndex).toBeNull();
    });

    it("returns null polarization index when z1 is 0", async () => {
      const rows = [
        { max_hr: 190, week: "2024-01-15", z1_seconds: 0, z2_seconds: 500, z3_seconds: 100 },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.polarizationTrend({ days: 180 });
      expect(result.weeks[0]?.polarizationIndex).toBeNull();
    });

    it("maps zone seconds correctly", async () => {
      const rows = [
        { max_hr: 185, week: "2024-02-01", z1_seconds: 10000, z2_seconds: 2000, z3_seconds: 500 },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.polarizationTrend({ days: 180 });

      expect(result.weeks[0]?.z1Seconds).toBe(10000);
      expect(result.weeks[0]?.z2Seconds).toBe(2000);
      expect(result.weeks[0]?.z3Seconds).toBe(500);
      expect(result.weeks[0]?.week).toBe("2024-02-01");
    });

    it("returns week as string when DB driver returns Date objects", async () => {
      // Some postgres drivers/platforms return Date objects for ::date columns
      const rows = [
        {
          max_hr: 190,
          week: new Date("2024-01-15T00:00:00.000Z"),
          z1_seconds: 5000,
          z2_seconds: 500,
          z3_seconds: 100,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.polarizationTrend({ days: 180 });

      expect(typeof result.weeks[0]?.week).toBe("string");
      expect(result.weeks[0]?.week).toBe("2024-01-15");
    });

    it("returns null maxHr when no data", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.polarizationTrend({ days: 180 });
      expect(result.maxHr).toBeNull();
      expect(result.weeks).toEqual([]);
    });

    it("computes PI for non-trivial zone distribution", async () => {
      const rows = [
        { max_hr: 190, week: "2024-01-15", z1_seconds: 3600, z2_seconds: 1800, z3_seconds: 600 },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.polarizationTrend({ days: 180 });

      // Treff PI = log10((f1 / (f2 * f3)) * 100) where f = fraction of total time
      const total = 3600 + 1800 + 600;
      const f1 = 3600 / total;
      const f2 = 1800 / total;
      const f3 = 600 / total;
      const expected = Math.round(Math.log10((f1 / (f2 * f3)) * 100) * 1000) / 1000;
      expect(result.weeks[0]?.polarizationIndex).toBe(expected);
    });
  });

  describe("access window gating", () => {
    it("aerobicEfficiency passes accessWindow to repository (limited window returns empty)", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
        accessWindow: {
          kind: "limited",
          paid: false,
          reason: "free_signup_week",
          startDate: "2026-04-10",
          endDateExclusive: "2026-04-17",
        },
      });
      const result = await caller.aerobicEfficiency({ days: 180 });
      expect(result.activities).toEqual([]);
    });
  });
});
