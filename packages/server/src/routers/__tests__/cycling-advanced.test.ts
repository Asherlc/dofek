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

vi.mock("../../lib/endurance-types.ts", () => ({
  enduranceTypeFilter: () => ({ sql: "true" }),
}));

import { cyclingAdvancedRouter } from "../cycling-advanced.ts";

const createCaller = createTestCallerFactory(cyclingAdvancedRouter);

function makeCaller(rows: Record<string, unknown>[] = []) {
  return createCaller({
    db: { execute: vi.fn().mockResolvedValue(rows) } as never,
    userId: "user-1",
  });
}

describe("cyclingAdvancedRouter", () => {
  describe("rampRate", () => {
    it("returns empty when no data", async () => {
      const caller = makeCaller([]);
      const result = await caller.rampRate({ days: 90 });
      expect(result.weeks).toEqual([]);
      expect(result.currentRampRate).toBe(0);
      expect(result.recommendation).toBe("No data");
    });

    it("computes ramp rate from daily loads", async () => {
      // Create ~2 weeks of daily TRIMP data
      const rows: { day: string; trimp: number }[] = [];
      const base = new Date();
      for (let i = 14; i >= 0; i--) {
        const d = new Date(base);
        d.setDate(d.getDate() - i);
        rows.push({ day: d.toISOString().slice(0, 10), trimp: 50 + i * 2 });
      }
      const caller = makeCaller(rows);
      const result = await caller.rampRate({ days: 90 });

      expect(result.recommendation).toBeDefined();
      expect(typeof result.currentRampRate).toBe("number");
    });
  });

  describe("trainingMonotony", () => {
    it("returns monotony data", async () => {
      const rows = [
        { week: "2024-01-15", monotony: 1.5, strain: 300, weekly_load: 200 },
      ];
      const caller = makeCaller(rows);
      const result = await caller.trainingMonotony({ days: 90 });

      expect(result).toHaveLength(1);
      expect(result[0]?.monotony).toBe(1.5);
      expect(result[0]?.weeklyLoad).toBe(200);
    });

    it("returns empty when no data", async () => {
      const caller = makeCaller([]);
      const result = await caller.trainingMonotony({ days: 90 });
      expect(result).toEqual([]);
    });
  });

  describe("activityVariability", () => {
    it("returns empty when no FTP data", async () => {
      const caller = makeCaller([]);
      const result = await caller.activityVariability({ days: 90 });
      expect(result).toEqual([]);
    });

    it("computes variability from power data", async () => {
      const execute = vi.fn();
      // First call: FTP estimation
      execute.mockResolvedValueOnce([{ ftp: 250 }]);
      // Second call: NP/avg power per activity
      execute.mockResolvedValueOnce([
        { date: "2024-01-15", name: "Ride", np: 230, avg_power: 200 },
      ]);

      const caller = createCaller({
        db: { execute } as never,
        userId: "user-1",
      });
      const result = await caller.activityVariability({ days: 90 });

      expect(result).toHaveLength(1);
      expect(result[0]?.normalizedPower).toBe(230);
      expect(result[0]?.variabilityIndex).toBe(1.15); // 230/200
      expect(result[0]?.intensityFactor).toBe(0.92); // 230/250
    });
  });

  describe("verticalAscentRate", () => {
    it("computes VAM from climbing data", async () => {
      const rows = [
        {
          date: "2024-01-15",
          name: "Mountain Ride",
          elevation_gain: 500,
          climbing_seconds: 3600,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.verticalAscentRate({ days: 90 });

      expect(result).toHaveLength(1);
      expect(result[0]?.verticalAscentRate).toBe(500); // 500m / 1hr
      expect(result[0]?.climbingMinutes).toBe(60);
    });

    it("returns 0 VAM when climbing seconds is 0", async () => {
      const rows = [
        { date: "2024-01-15", name: "Flat Ride", elevation_gain: 0, climbing_seconds: 0 },
      ];
      const caller = makeCaller(rows);
      const result = await caller.verticalAscentRate({ days: 90 });

      expect(result[0]?.verticalAscentRate).toBe(0);
    });
  });

  describe("pedalDynamics", () => {
    it("returns pedal dynamics data", async () => {
      const rows = [
        {
          date: "2024-01-15",
          name: "Trainer Ride",
          avg_balance: 49.5,
          avg_torque_effectiveness: 85.3,
          avg_pedal_smoothness: 22.1,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.pedalDynamics({ days: 90 });

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        date: "2024-01-15",
        activityName: "Trainer Ride",
        leftRightBalance: 49.5,
        avgTorqueEffectiveness: 85.3,
        avgPedalSmoothness: 22.1,
      });
    });
  });
});
