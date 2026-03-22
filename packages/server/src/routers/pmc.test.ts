import { describe, expect, it, vi } from "vitest";

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

vi.mock("dofek/personalization/storage", () => ({
  loadPersonalizedParams: vi.fn().mockResolvedValue(null),
}));

import { TrainingStressCalculator } from "@dofek/training/training-load";
import { pmcRouter } from "./pmc.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

// Default calculator for test assertions
const calc = new TrainingStressCalculator();

// --- pmcRouter ---

const createCaller = createTestCallerFactory(pmcRouter);

describe("pmcRouter", () => {
  describe("chart", () => {
    it("returns empty data and generic model when no rows", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });
      const result = await caller.chart({ days: 180 });
      expect(result.data).toEqual([]);
      expect(result.model).toEqual({
        type: "generic",
        pairedActivities: 0,
        r2: null,
        ftp: null,
      });
    });

    it("returns generic model with no FTP when only HR activities", async () => {
      const today = new Date();
      const dateStr = today.toISOString().slice(0, 10);
      const execute = vi.fn();
      execute.mockResolvedValueOnce([
        {
          global_max_hr: 190,
          resting_hr: 55,
          id: "a1",
          date: dateStr,
          duration_min: 60,
          avg_hr: 155,
          max_hr: 180,
          avg_power: null,
          power_samples: 0,
          hr_samples: 3600,
        },
      ]);
      execute.mockResolvedValueOnce([]);

      const caller = createCaller({ db: { execute }, userId: "user-1" });
      const result = await caller.chart({ days: 180 });

      expect(result.model.type).toBe("generic");
      expect(result.model.ftp).toBeNull();
      expect(result.data.length).toBeGreaterThan(0);

      // Activity day should have non-zero load
      const actDay = result.data.find((d) => d.date === dateStr);
      if (actDay) {
        expect(actDay.load).toBeGreaterThan(0);
      }
    });

    it("computes correct load from hrTSS for HR-only activity", async () => {
      const today = new Date();
      const dateStr = today.toISOString().slice(0, 10);
      const execute = vi.fn();
      execute.mockResolvedValueOnce([
        {
          global_max_hr: 190,
          resting_hr: 55,
          id: "a1",
          date: dateStr,
          duration_min: 60,
          avg_hr: 155,
          max_hr: 180,
          avg_power: null,
          power_samples: 0,
          hr_samples: 3600,
        },
      ]);
      execute.mockResolvedValueOnce([]);

      const caller = createCaller({ db: { execute }, userId: "user-1" });
      const result = await caller.chart({ days: 180 });

      // Find the activity day and verify load matches expected hrTSS
      const actDay = result.data.find((d) => d.date === dateStr);
      expect(actDay).toBeDefined();
      const expectedHrTss = calc.computeHrTss(60, 155, 190, 55);
      expect(actDay?.load).toBeCloseTo(Math.round(expectedHrTss * 10) / 10, 1);
    });

    it("computes FTP from NP data and uses power TSS", async () => {
      const today = new Date();
      const execute = vi.fn();

      // Vary avg_hr and avg_power across activities to produce a real regression
      const activities = Array.from({ length: 12 }, (_, i) => {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        return {
          global_max_hr: 190,
          resting_hr: 55,
          id: `a${i}`,
          date: d.toISOString().slice(0, 10),
          duration_min: 30 + i * 5,
          avg_hr: 140 + i * 3,
          max_hr: 180,
          avg_power: 180 + i * 10,
          power_samples: 3600,
          hr_samples: 3600,
        };
      });
      execute.mockResolvedValueOnce(activities);

      // NP varies linearly with avg_power for a good correlation
      const npRows = activities.map((a) => ({
        activity_id: a.id,
        np: (a.avg_power ?? 200) + 20,
      }));
      execute.mockResolvedValueOnce(npRows);

      const caller = createCaller({ db: { execute }, userId: "user-1" });
      const result = await caller.chart({ days: 180 });

      // FTP = round(best_avg_power * 0.95) = round(290 * 0.95) = 276
      const bestAvgPower = Math.max(...activities.map((a) => a.avg_power));
      expect(result.model.ftp).toBe(Math.round(bestAvgPower * 0.95));
      expect(result.model.type).toBe("learned");
      expect(result.model.r2).toBeGreaterThanOrEqual(0.3);
      expect(result.model.pairedActivities).toBeGreaterThan(0);
      expect(result.data.length).toBeGreaterThan(0);
    });

    it("rounds output values to 1 decimal place", async () => {
      const today = new Date();
      const dateStr = today.toISOString().slice(0, 10);
      const execute = vi.fn();
      execute.mockResolvedValueOnce([
        {
          global_max_hr: 190,
          resting_hr: 55,
          id: "a1",
          date: dateStr,
          duration_min: 60,
          avg_hr: 155,
          max_hr: 180,
          avg_power: null,
          power_samples: 0,
          hr_samples: 3600,
        },
      ]);
      execute.mockResolvedValueOnce([]);

      const caller = createCaller({ db: { execute }, userId: "user-1" });
      const result = await caller.chart({ days: 180 });

      for (const point of result.data) {
        // Math.round(x * 10) / 10 produces at most 1 decimal
        expect(point.load).toBe(Math.round(point.load * 10) / 10);
        expect(point.ctl).toBe(Math.round(point.ctl * 10) / 10);
        expect(point.atl).toBe(Math.round(point.atl * 10) / 10);
        expect(point.tsb).toBe(Math.round(point.tsb * 10) / 10);
      }
    });

    it("trims leading days before fitness has accumulated", async () => {
      // Use an activity date in the past so there are zero days before it
      const today = new Date();
      const actDate = new Date(today);
      actDate.setDate(actDate.getDate() - 10);
      const actDateStr = actDate.toISOString().slice(0, 10);

      const execute = vi.fn();
      execute.mockResolvedValueOnce([
        {
          global_max_hr: 190,
          resting_hr: 55,
          id: "a1",
          date: actDateStr,
          duration_min: 60,
          avg_hr: 155,
          max_hr: 180,
          avg_power: null,
          power_samples: 0,
          hr_samples: 3600,
        },
      ]);
      execute.mockResolvedValueOnce([]);

      const caller = createCaller({ db: { execute }, userId: "user-1" });
      const result = await caller.chart({ days: 180 });

      // First data point should be at or near the activity (CTL starts building)
      expect(result.data.length).toBeGreaterThan(0);
      // Days after the activity should be preserved even if load is 0
      // (CTL/ATL are decaying but still meaningful)
      const daysAfterActivity = result.data.filter((d) => d.date > actDateStr);
      expect(daysAfterActivity.length).toBeGreaterThan(0);
      // Rest days after training should still appear (CTL > 0)
      expect(daysAfterActivity.some((d) => d.load === 0 && d.ctl > 0)).toBe(true);
    });

    it("produces tsb = ctl - atl", async () => {
      const today = new Date();
      const dateStr = today.toISOString().slice(0, 10);
      const execute = vi.fn();
      execute.mockResolvedValueOnce([
        {
          global_max_hr: 190,
          resting_hr: 55,
          id: "a1",
          date: dateStr,
          duration_min: 60,
          avg_hr: 155,
          max_hr: 180,
          avg_power: null,
          power_samples: 0,
          hr_samples: 3600,
        },
      ]);
      execute.mockResolvedValueOnce([]);

      const caller = createCaller({ db: { execute }, userId: "user-1" });
      const result = await caller.chart({ days: 180 });

      for (const point of result.data) {
        const expectedTsb = Math.round((point.ctl - point.atl) * 10) / 10;
        expect(point.tsb).toBe(expectedTsb);
      }
    });

    it("aggregates multiple activities on same day", async () => {
      const today = new Date();
      const dateStr = today.toISOString().slice(0, 10);
      const execute = vi.fn();
      execute.mockResolvedValueOnce([
        {
          global_max_hr: 190,
          resting_hr: 55,
          id: "a1",
          date: dateStr,
          duration_min: 30,
          avg_hr: 155,
          max_hr: 180,
          avg_power: null,
          power_samples: 0,
          hr_samples: 1800,
        },
        {
          global_max_hr: 190,
          resting_hr: 55,
          id: "a2",
          date: dateStr,
          duration_min: 30,
          avg_hr: 155,
          max_hr: 180,
          avg_power: null,
          power_samples: 0,
          hr_samples: 1800,
        },
      ]);
      execute.mockResolvedValueOnce([]);

      const caller = createCaller({ db: { execute }, userId: "user-1" });
      const result = await caller.chart({ days: 180 });

      // Combined load should be sum of both activities' hrTSS
      const actDay = result.data.find((d) => d.date === dateStr);
      expect(actDay).toBeDefined();
      const singleTss = calc.computeHrTss(30, 155, 190, 55);
      const expectedLoad = Math.round(singleTss * 2 * 10) / 10;
      expect(actDay?.load).toBeCloseTo(expectedLoad, 1);
    });
  });
});
