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

vi.mock("../lib/typed-sql.ts", () => ({
  executeWithSchema: vi.fn(async (db: { execute: () => Promise<unknown[]> }) => db.execute()),
}));

vi.mock("../lib/endurance-types.ts", () => ({
  enduranceTypeFilter: () => ({ sql: "true" }),
}));

import { cyclingAdvancedRouter } from "./cycling-advanced.ts";

const createCaller = createTestCallerFactory(cyclingAdvancedRouter);

function makeCaller(rows: Record<string, unknown>[] = []) {
  return createCaller({
    db: { execute: vi.fn().mockResolvedValue(rows) },
    userId: "user-1",
  });
}

describe("cyclingAdvancedRouter", () => {
  describe("rampRate", () => {
    // Pin system clock so week-boundary grouping is deterministic across environments
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-11T12:00:00Z")); // Wednesday mid-week
    });
    afterEach(() => {
      vi.useRealTimers();
    });

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
      // Should have at least 1 week of ramp rate data
      expect(result.weeks.length).toBeGreaterThan(0);
      // Each week should have numeric ctlStart, ctlEnd, rampRate
      for (const w of result.weeks) {
        expect(typeof w.ctlStart).toBe("number");
        expect(typeof w.ctlEnd).toBe("number");
        expect(typeof w.rampRate).toBe("number");
        expect(w.rampRate).toBe(Math.round((w.ctlEnd - w.ctlStart) * 100) / 100);
      }
    });

    it("gives safe recommendation for low ramp rate", async () => {
      // Small, consistent loads → low ramp rate
      const rows: { day: string; trimp: number }[] = [];
      const base = new Date();
      for (let i = 30; i >= 0; i--) {
        const d = new Date(base);
        d.setDate(d.getDate() - i);
        rows.push({ day: d.toISOString().slice(0, 10), trimp: 50 });
      }
      const caller = makeCaller(rows);
      const result = await caller.rampRate({ days: 90 });

      // Constant load → near-zero ramp rate → safe
      expect(result.recommendation).toContain("Safe");
    });

    it("gives danger recommendation for very high ramp rate", async () => {
      // Dramatic load increase → high ramp rate.
      // Use TRIMP=1000 so even a 1-day partial week exceeds the ramp threshold
      // (42-day EWMA changes CTL by ~(1000-CTL)/42 ≈ 17+/day at CTL~300).
      const rows: { day: string; trimp: number }[] = [];
      const base = new Date();
      // First 3 weeks: low load
      for (let i = 28; i >= 14; i--) {
        const d = new Date(base);
        d.setDate(d.getDate() - i);
        rows.push({ day: d.toISOString().slice(0, 10), trimp: 10 });
      }
      // Last 2 weeks: very high load
      for (let i = 13; i >= 0; i--) {
        const d = new Date(base);
        d.setDate(d.getDate() - i);
        rows.push({ day: d.toISOString().slice(0, 10), trimp: 1000 });
      }
      const caller = makeCaller(rows);
      const result = await caller.rampRate({ days: 90 });

      // Large jump should trigger danger or aggressive
      expect(result.recommendation).toMatch(/Danger|Aggressive/);
    });

    it("currentRampRate matches last week's ramp rate", async () => {
      const rows: { day: string; trimp: number }[] = [];
      const base = new Date();
      for (let i = 21; i >= 0; i--) {
        const d = new Date(base);
        d.setDate(d.getDate() - i);
        rows.push({ day: d.toISOString().slice(0, 10), trimp: 50 + i });
      }
      const caller = makeCaller(rows);
      const result = await caller.rampRate({ days: 90 });

      if (result.weeks.length > 0) {
        const lastWeek = result.weeks[result.weeks.length - 1];
        expect(result.currentRampRate).toBe(lastWeek?.rampRate ?? 0);
      }
    });
  });

  describe("trainingMonotony", () => {
    it("returns monotony data", async () => {
      const rows = [{ week: "2024-01-15", monotony: 1.5, strain: 300, weekly_load: 200 }];
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

    it("maps all fields correctly", async () => {
      const rows = [{ week: "2024-02-05", monotony: 2.1, strain: 450.5, weekly_load: 215.0 }];
      const caller = makeCaller(rows);
      const result = await caller.trainingMonotony({ days: 90 });

      expect(result[0]).toEqual({
        week: "2024-02-05",
        monotony: 2.1,
        strain: 450.5,
        weeklyLoad: 215.0,
      });
    });

    it("returns multiple weeks", async () => {
      const rows = [
        { week: "2024-01-08", monotony: 1.2, strain: 200, weekly_load: 150 },
        { week: "2024-01-15", monotony: 1.8, strain: 350, weekly_load: 200 },
      ];
      const caller = makeCaller(rows);
      const result = await caller.trainingMonotony({ days: 90 });

      expect(result).toHaveLength(2);
      expect(result[0]?.week).toBe("2024-01-08");
      expect(result[1]?.week).toBe("2024-01-15");
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
        db: { execute },
        userId: "user-1",
      });
      const result = await caller.activityVariability({ days: 90 });

      expect(result).toHaveLength(1);
      expect(result[0]?.normalizedPower).toBe(230);
      expect(result[0]?.variabilityIndex).toBe(1.15); // 230/200
      expect(result[0]?.intensityFactor).toBe(0.92); // 230/250
    });

    it("computes variability index as NP / avgPower", async () => {
      const execute = vi.fn();
      execute.mockResolvedValueOnce([{ ftp: 300 }]);
      execute.mockResolvedValueOnce([
        { date: "2024-01-15", name: "Ride", np: 280, avg_power: 250 },
      ]);

      const caller = createCaller({ db: { execute }, userId: "user-1" });
      const result = await caller.activityVariability({ days: 90 });

      // VI = 280/250 = 1.12
      expect(result[0]?.variabilityIndex).toBe(Math.round((280 / 250) * 1000) / 1000);
      // IF = 280/300 = 0.933
      expect(result[0]?.intensityFactor).toBe(Math.round((280 / 300) * 1000) / 1000);
    });

    it("maps activityName from name field", async () => {
      const execute = vi.fn();
      execute.mockResolvedValueOnce([{ ftp: 200 }]);
      execute.mockResolvedValueOnce([
        { date: "2024-01-15", name: "Zwift Race", np: 190, avg_power: 180 },
      ]);

      const caller = createCaller({ db: { execute }, userId: "user-1" });
      const result = await caller.activityVariability({ days: 90 });

      expect(result[0]?.activityName).toBe("Zwift Race");
      expect(result[0]?.date).toBe("2024-01-15");
      expect(result[0]?.averagePower).toBe(180);
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

    it("computes correct VAM formula: elevation / (seconds / 3600)", async () => {
      // 1000m in 1800s = 1000 / 0.5h = 2000 m/h
      const rows = [
        { date: "2024-01-15", name: "Climb", elevation_gain: 1000, climbing_seconds: 1800 },
      ];
      const caller = makeCaller(rows);
      const result = await caller.verticalAscentRate({ days: 90 });

      expect(result[0]?.verticalAscentRate).toBe(2000);
      expect(result[0]?.climbingMinutes).toBe(30);
      expect(result[0]?.elevationGainMeters).toBe(1000);
    });

    it("maps field names correctly", async () => {
      const rows = [
        {
          date: "2024-02-20",
          name: "Col du Galibier",
          elevation_gain: 1200,
          climbing_seconds: 5400,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.verticalAscentRate({ days: 90 });

      expect(result[0]?.date).toBe("2024-02-20");
      expect(result[0]?.activityName).toBe("Col du Galibier");
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
