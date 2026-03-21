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

const mockLinearRegression = vi.fn();
vi.mock("@dofek/stats/correlation", () => ({
  linearRegression: (...args: unknown[]) => mockLinearRegression(...args),
}));

vi.mock("dofek/personalization/storage", () => ({
  loadPersonalizedParams: vi.fn().mockResolvedValue(null),
}));

import {
  type ActivityRow,
  buildTssModel,
  computeHrTss,
  computePowerTss,
  computeTrimp,
  estimateFtp,
  pmcRouter,
} from "./pmc.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

// --- computeTrimp ---

describe("computeTrimp", () => {
  it("returns 0 when maxHr equals restingHr", () => {
    expect(computeTrimp(60, 150, 60, 60)).toBe(0);
  });

  it("returns 0 when maxHr less than restingHr", () => {
    expect(computeTrimp(60, 150, 50, 60)).toBe(0);
  });

  it("returns 0 when duration is 0", () => {
    expect(computeTrimp(0, 155, 190, 55)).toBe(0);
  });

  it("returns 0 when duration is negative", () => {
    expect(computeTrimp(-10, 155, 190, 55)).toBe(0);
  });

  it("returns 0 when avgHr equals restingHr (deltaHrRatio is 0)", () => {
    expect(computeTrimp(60, 55, 190, 55)).toBe(0);
  });

  it("returns 0 when avgHr below restingHr (deltaHrRatio negative)", () => {
    expect(computeTrimp(60, 50, 190, 55)).toBe(0);
  });

  it("computes correct TRIMP for known inputs", () => {
    // deltaHrRatio = (155-55)/(190-55) = 100/135
    const deltaHrRatio = (155 - 55) / (190 - 55);
    const expected = 60 * deltaHrRatio * 0.64 * Math.exp(1.92 * deltaHrRatio);
    expect(computeTrimp(60, 155, 190, 55)).toBeCloseTo(expected, 5);
  });

  it("scales linearly with duration", () => {
    const trimp30 = computeTrimp(30, 155, 190, 55);
    const trimp60 = computeTrimp(60, 155, 190, 55);
    expect(trimp60).toBeCloseTo(trimp30 * 2, 5);
  });

  it("increases more than linearly with HR due to exponential", () => {
    const trimpLow = computeTrimp(60, 120, 190, 55);
    const trimpHigh = computeTrimp(60, 170, 190, 55);
    expect(trimpHigh).toBeGreaterThan(trimpLow);
    // Verify exponential by checking ratio > linear HR ratio
    const hrRatioLow = (120 - 55) / (190 - 55);
    const hrRatioHigh = (170 - 55) / (190 - 55);
    expect(trimpHigh / trimpLow).toBeGreaterThan(hrRatioHigh / hrRatioLow);
  });

  it("uses 0.64 coefficient and 1.92 exponent factor", () => {
    // For a simple case: durationMin=1, avgHr=190, maxHr=190, restingHr=0
    // deltaHrRatio = 1.0
    // trimp = 1 * 1.0 * 0.64 * exp(1.92 * 1.0)
    const expected = 1 * 1.0 * 0.64 * Math.exp(1.92);
    expect(computeTrimp(1, 190, 190, 0)).toBeCloseTo(expected, 5);
  });
});

// --- computeHrTss ---

describe("computeHrTss", () => {
  it("returns 0 when maxHr <= restingHr", () => {
    expect(computeHrTss(60, 150, 60, 60)).toBe(0);
  });

  it("returns 0 when durationMin is 0", () => {
    expect(computeHrTss(0, 155, 190, 55)).toBe(0);
  });

  it("returns ~100 for 1 hour at threshold HR", () => {
    // Threshold HR = restingHr + 0.85 * (maxHr - restingHr)
    const maxHr = 190;
    const restingHr = 55;
    const thresholdHr = restingHr + (maxHr - restingHr) * 0.85;
    const result = computeHrTss(60, thresholdHr, maxHr, restingHr);
    expect(result).toBeCloseTo(100, 0);
  });

  it("returns less than 100 for sub-threshold effort", () => {
    expect(computeHrTss(60, 130, 190, 55)).toBeLessThan(100);
    expect(computeHrTss(60, 130, 190, 55)).toBeGreaterThan(0);
  });

  it("returns more than 100 for supra-threshold effort", () => {
    expect(computeHrTss(60, 180, 190, 55)).toBeGreaterThan(100);
  });

  it("computes correct value using trimp ratio", () => {
    const trimp = computeTrimp(60, 155, 190, 55);
    const thresholdDeltaRatio = 0.85;
    const thresholdTrimp = 60 * thresholdDeltaRatio * 0.64 * Math.exp(1.92 * thresholdDeltaRatio);
    const expected = (trimp / thresholdTrimp) * 100;
    expect(computeHrTss(60, 155, 190, 55)).toBeCloseTo(expected, 5);
  });
});

// --- computePowerTss ---

describe("computePowerTss", () => {
  it("returns 0 when ftp is 0", () => {
    expect(computePowerTss(200, 0, 60)).toBe(0);
  });

  it("returns 0 when ftp is negative", () => {
    expect(computePowerTss(200, -100, 60)).toBe(0);
  });

  it("returns 0 when durationMin is 0", () => {
    expect(computePowerTss(200, 250, 0)).toBe(0);
  });

  it("returns 0 when durationMin is negative", () => {
    expect(computePowerTss(200, 250, -10)).toBe(0);
  });

  it("returns 0 when normalizedPower is 0", () => {
    expect(computePowerTss(0, 250, 60)).toBe(0);
  });

  it("returns 0 when normalizedPower is negative", () => {
    expect(computePowerTss(-100, 250, 60)).toBe(0);
  });

  it("returns exactly 100 for 1 hour at FTP", () => {
    // (250/250)^2 * (60/60) * 100 = 100
    expect(computePowerTss(250, 250, 60)).toBe(100);
  });

  it("computes correct value: IF^2 * hours * 100", () => {
    // NP=200, FTP=250, 60min: IF=0.8, TSS = 0.64 * 1 * 100 = 64
    expect(computePowerTss(200, 250, 60)).toBeCloseTo(64, 5);
  });

  it("scales linearly with duration", () => {
    // 30 min at FTP: (1)^2 * 0.5 * 100 = 50
    expect(computePowerTss(250, 250, 30)).toBe(50);
  });

  it("scales with intensity squared", () => {
    // NP=300, FTP=200, 60min: IF=1.5, TSS = 2.25 * 1 * 100 = 225
    expect(computePowerTss(300, 200, 60)).toBe(225);
  });

  it("handles non-standard values", () => {
    // NP=150, FTP=300, 90min: IF=0.5, TSS = 0.25 * 1.5 * 100 = 37.5
    expect(computePowerTss(150, 300, 90)).toBe(37.5);
  });
});

// --- buildTssModel ---

describe("buildTssModel", () => {
  it("returns null when fewer than 10 data points", () => {
    const paired = Array.from({ length: 9 }, (_, i) => ({
      trimp: i * 10 + 10,
      powerTss: i * 12 + 15,
    }));
    expect(buildTssModel(paired)).toBeNull();
  });

  it("returns null when exactly 0 data points", () => {
    expect(buildTssModel([])).toBeNull();
  });

  it("returns null when r2 below 0.3", () => {
    mockLinearRegression.mockReturnValue({ slope: 1, intercept: 0, rSquared: 0.2 });
    const paired = Array.from({ length: 10 }, (_, i) => ({
      trimp: i * 10 + 10,
      powerTss: Math.random() * 100,
    }));
    expect(buildTssModel(paired)).toBeNull();
  });

  it("returns null when r2 exactly 0.3 threshold boundary", () => {
    // r2 < 0.3 → null, so r2 = 0.29 → null, r2 = 0.3 → valid (>= 0.3)
    mockLinearRegression.mockReturnValue({ slope: 1, intercept: 0, rSquared: 0.29 });
    const paired = Array.from({ length: 10 }, () => ({ trimp: 50, powerTss: 60 }));
    expect(buildTssModel(paired)).toBeNull();
  });

  it("returns model when r2 exactly 0.3", () => {
    mockLinearRegression.mockReturnValue({ slope: 1, intercept: 0, rSquared: 0.3 });
    const paired = Array.from({ length: 10 }, () => ({ trimp: 50, powerTss: 60 }));
    expect(buildTssModel(paired)).not.toBeNull();
  });

  it("returns null when slope is 0", () => {
    mockLinearRegression.mockReturnValue({ slope: 0, intercept: 50, rSquared: 0.5 });
    const paired = Array.from({ length: 10 }, () => ({ trimp: 50, powerTss: 50 }));
    expect(buildTssModel(paired)).toBeNull();
  });

  it("returns null when slope is negative", () => {
    mockLinearRegression.mockReturnValue({ slope: -0.5, intercept: 100, rSquared: 0.5 });
    const paired = Array.from({ length: 10 }, () => ({ trimp: 50, powerTss: 50 }));
    expect(buildTssModel(paired)).toBeNull();
  });

  it("returns model when r2 >= 0.3 and slope > 0", () => {
    mockLinearRegression.mockReturnValue({ slope: 0.8, intercept: 5, rSquared: 0.7 });
    const paired = Array.from({ length: 10 }, (_, i) => ({
      trimp: i * 10 + 10,
      powerTss: i * 8 + 13,
    }));
    const result = buildTssModel(paired);
    expect(result).toEqual({ slope: 0.8, intercept: 5, r2: 0.7 });
  });

  it("passes correct xs and ys to linearRegression", () => {
    mockLinearRegression.mockReturnValue({ slope: 1, intercept: 0, rSquared: 0.9 });
    const paired = Array.from({ length: 10 }, (_, i) => ({
      trimp: (i + 1) * 10,
      powerTss: (i + 1) * 12,
    }));
    buildTssModel(paired);
    expect(mockLinearRegression).toHaveBeenCalledWith(
      paired.map((p) => p.trimp),
      paired.map((p) => p.powerTss),
    );
  });

  it("returns model with exactly 10 data points", () => {
    mockLinearRegression.mockReturnValue({ slope: 1.2, intercept: 10, rSquared: 0.85 });
    const paired = Array.from({ length: 10 }, (_, i) => ({
      trimp: i * 10 + 10,
      powerTss: i * 12 + 22,
    }));
    expect(buildTssModel(paired)).not.toBeNull();
  });
});

// --- estimateFtp ---

describe("estimateFtp", () => {
  function makeActivity(overrides: Partial<ActivityRow> = {}): ActivityRow {
    return {
      id: "a1",
      date: "2024-01-01",
      duration_min: 60,
      avg_hr: 155,
      max_hr: 180,
      avg_power: 200,
      power_samples: 3600,
      hr_samples: 3600,
      ...overrides,
    };
  }

  it("returns null when no activities", () => {
    expect(estimateFtp([])).toBeNull();
  });

  it("returns null when all activities too short", () => {
    const activities = [makeActivity({ duration_min: 15 })];
    expect(estimateFtp(activities)).toBeNull();
  });

  it("returns null when no power data", () => {
    const activities = [makeActivity({ avg_power: null })];
    expect(estimateFtp(activities)).toBeNull();
  });

  it("returns null when avg_power is 0", () => {
    const activities = [makeActivity({ avg_power: 0 })];
    expect(estimateFtp(activities)).toBeNull();
  });

  it("ignores NP and uses avg_power to avoid inflated interval estimates", () => {
    // NP inflates power for interval workouts (4th-power averaging).
    // Using max NP × 0.95 gives an unrealistically high FTP (e.g., 305 NP → 290 FTP).
    // Now uses avg_power only (220 × 0.95 = 209), which is more conservative.
    const activities = [makeActivity({ id: "a1", avg_power: 220 })];
    expect(estimateFtp(activities)).toBe(Math.round(220 * 0.95)); // 209
  });

  it("uses avg_power for estimation", () => {
    const activities = [makeActivity({ avg_power: 200 })];
    expect(estimateFtp(activities)).toBe(Math.round(200 * 0.95)); // 190
  });

  it("uses the highest avg_power among qualifying activities", () => {
    const activities = [
      makeActivity({ id: "a1", avg_power: 200 }),
      makeActivity({ id: "a2", avg_power: 250 }),
      makeActivity({ id: "a3", avg_power: 180 }),
    ];
    // max is 250
    expect(estimateFtp(activities)).toBe(Math.round(250 * 0.95)); // 238
  });

  it("uses Math.max not Math.min for best power", () => {
    const activities = [
      makeActivity({ id: "a1", avg_power: 100 }),
      makeActivity({ id: "a2", avg_power: 300 }),
    ];
    // Math.max → 300, Math.min would give 100
    const result = estimateFtp(activities);
    expect(result).toBe(Math.round(300 * 0.95)); // 285
    expect(result).not.toBe(Math.round(100 * 0.95)); // not 95
  });

  it("excludes activities shorter than 20 minutes", () => {
    const activities = [
      makeActivity({ id: "a1", duration_min: 19, avg_power: 400 }),
      makeActivity({ id: "a2", duration_min: 20, avg_power: 200 }),
    ];
    // a1 excluded (19 min < 20), a2 included
    expect(estimateFtp(activities)).toBe(Math.round(200 * 0.95)); // 190
  });

  it("includes activity with exactly 20 minutes", () => {
    const activities = [makeActivity({ duration_min: 20, avg_power: 250 })];
    expect(estimateFtp(activities)).toBe(Math.round(250 * 0.95)); // 238
  });

  it("returns null when avg_power is null on all activities", () => {
    const activities = [makeActivity({ id: "a1", avg_power: null, duration_min: 30 })];
    expect(estimateFtp(activities)).toBeNull();
  });

  it("multiplies by 0.95 not divides", () => {
    const activities = [makeActivity({ avg_power: 200 })];
    const result = estimateFtp(activities);
    // 200 * 0.95 = 190, 200 / 0.95 ≈ 210.5 → 211
    expect(result).toBe(190);
    expect(result).not.toBe(211);
  });

  it("filters by duration_min >= 20 not > 20", () => {
    const activities = [
      makeActivity({ id: "a1", duration_min: 19, avg_power: 300 }),
      makeActivity({ id: "a2", duration_min: 20, avg_power: 200 }),
    ];
    const result = estimateFtp(activities);
    // a1 should be excluded (19 < 20), a2 included
    expect(result).toBe(Math.round(200 * 0.95)); // 190, not 285
    expect(result).not.toBe(Math.round(300 * 0.95));
  });

  it("filters by avg_power > 0 not >= 0", () => {
    const activities = [makeActivity({ avg_power: 0, duration_min: 60 })];
    expect(estimateFtp(activities)).toBeNull();
  });

  it("rounds result to nearest integer", () => {
    // 210 * 0.95 = 199.5 → 200 (Math.round)
    const activities = [makeActivity({ avg_power: 210 })];
    expect(estimateFtp(activities)).toBe(200);
  });

  it("handles single qualifying activity correctly", () => {
    const activities = [makeActivity({ id: "a1", avg_power: 250, duration_min: 20 })];
    expect(estimateFtp(activities)).toBe(Math.round(250 * 0.95)); // 238
  });
});

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
      const expectedHrTss = computeHrTss(60, 155, 190, 55);
      expect(actDay?.load).toBeCloseTo(Math.round(expectedHrTss * 10) / 10, 1);
    });

    it("computes FTP from NP data and uses power TSS", async () => {
      mockLinearRegression.mockReturnValue({ slope: 0.8, intercept: 5, rSquared: 0.7 });
      const today = new Date();
      const execute = vi.fn();

      const activities = Array.from({ length: 12 }, (_, i) => {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        return {
          global_max_hr: 190,
          resting_hr: 55,
          id: `a${i}`,
          date: d.toISOString().slice(0, 10),
          duration_min: 60,
          avg_hr: 155,
          max_hr: 180,
          avg_power: 200,
          power_samples: 3600,
          hr_samples: 3600,
        };
      });
      execute.mockResolvedValueOnce(activities);

      const npRows = activities.map((a) => ({ activity_id: a.id, np: 220 }));
      execute.mockResolvedValueOnce(npRows);

      const caller = createCaller({ db: { execute }, userId: "user-1" });
      const result = await caller.chart({ days: 180 });

      // FTP = round(200 * 0.95) = 190 (uses avg_power, not NP)
      expect(result.model.ftp).toBe(190);
      expect(result.model.type).toBe("learned");
      expect(result.model.r2).toBe(0.7);
      expect(result.model.pairedActivities).toBeGreaterThan(0);
      expect(result.data.length).toBeGreaterThan(0);

      // Activity days should have non-zero load from power TSS
      const todayStr = today.toISOString().slice(0, 10);
      const todayPoint = result.data.find((d) => d.date === todayStr);
      if (todayPoint) {
        expect(todayPoint.load).toBeGreaterThan(0);
        // Verify it's power TSS: (220/190)^2 * 1 * 100 ≈ 134.1
        const expectedTss = computePowerTss(220, 190, 60);
        expect(todayPoint.load).toBeCloseTo(Math.round(expectedTss * 10) / 10, 1);
      }
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
      const singleTss = computeHrTss(30, 155, 190, 55);
      const expectedLoad = Math.round(singleTss * 2 * 10) / 10;
      expect(actDay?.load).toBeCloseTo(expectedLoad, 1);
    });
  });
});
