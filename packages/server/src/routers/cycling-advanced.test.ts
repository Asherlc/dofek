import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{ db: unknown; userId: string | null; timezone: string }>()
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
        db: { execute: (query: unknown) => Promise<unknown[]> },
        schema: { parse: (row: unknown) => unknown },
        query: unknown,
      ) => {
        const rows = await db.execute(query);
        return rows.map((row) => schema.parse(row));
      },
    ),
  };
});

vi.mock("../lib/endurance-types.ts", () => ({
  enduranceTypeFilter: (alias: string) => {
    if (alias !== "a" && alias !== "asum") {
      throw new Error(`Unexpected alias: ${alias}`);
    }
    return { sql: `true_${alias}` };
  },
}));

import { cyclingAdvancedRouter } from "./cycling-advanced.ts";

const createCaller = createTestCallerFactory(cyclingAdvancedRouter);

function makeCaller(rows: Record<string, unknown>[] = []) {
  return createCaller({
    db: { execute: vi.fn().mockResolvedValue(rows) },
    userId: "user-1",
    timezone: "UTC",
  });
}

function hasQueryChunks(value: unknown): value is { queryChunks?: unknown[] } {
  return typeof value === "object" && value !== null && "queryChunks" in value;
}

function buildRows(
  base: Date,
  dayStart: number,
  dayEnd: number,
  trimp: number,
): { day: string; trimp: number }[] {
  const rows: { day: string; trimp: number }[] = [];
  for (let i = dayStart; i >= dayEnd; i--) {
    const date = new Date(base);
    date.setDate(date.getDate() - i);
    rows.push({ day: date.toISOString().slice(0, 10), trimp });
  }
  return rows;
}

function computeRampRateExpected(
  rows: { day: string; trimp: number }[],
  now: Date,
  days: number,
): {
  weeks: Array<{ week: string; ctlStart: number; ctlEnd: number; rampRate: number }>;
  currentRampRate: number;
  recommendation: string;
} {
  if (rows.length === 0) {
    return { weeks: [], currentRampRate: 0, recommendation: "No data" };
  }

  const loadMap = new Map(rows.map((row) => [row.day, row.trimp]));
  const firstLoad = rows[0];
  const lastLoad = rows[rows.length - 1];
  if (!firstLoad || !lastLoad) return { weeks: [], currentRampRate: 0, recommendation: "No data" };

  const startDate = new Date(firstLoad.day);
  const endDate = new Date(lastLoad.day);
  const ctlByDate = new Map<string, number>();
  let ctl = 0;

  for (
    let current = new Date(startDate);
    current <= endDate;
    current.setDate(current.getDate() + 1)
  ) {
    const key = current.toISOString().slice(0, 10);
    const load = loadMap.get(key) ?? 0;
    ctl = ctl + (load - ctl) / 42;
    ctlByDate.set(key, ctl);
  }

  const ctlEntries = [...ctlByDate.entries()].sort(([dateA], [dateB]) =>
    dateA.localeCompare(dateB),
  );
  const cutoffDate = new Date(now);
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoffStr = cutoffDate.toISOString().slice(0, 10);
  const filtered = ctlEntries.filter(([dateStr]) => dateStr >= cutoffStr);

  const weekMap = new Map<string, { first: number; last: number }>();
  for (const [dateStr, ctlValue] of filtered) {
    const dateObj = new Date(dateStr);
    const dayOfWeek = dateObj.getDay();
    const monday = new Date(dateObj);
    monday.setDate(dateObj.getDate() - ((dayOfWeek + 6) % 7));
    const weekKey = monday.toISOString().slice(0, 10);

    const existing = weekMap.get(weekKey);
    if (!existing) {
      weekMap.set(weekKey, { first: ctlValue, last: ctlValue });
    } else {
      existing.last = ctlValue;
    }
  }

  const weeks: Array<{ week: string; ctlStart: number; ctlEnd: number; rampRate: number }> = [];
  const weekKeys = [...weekMap.keys()].sort();
  for (let idx = 1; idx < weekKeys.length; idx++) {
    const prevKey = weekKeys[idx - 1];
    const currKey = weekKeys[idx];
    if (!prevKey || !currKey) continue;
    const prevWeek = weekMap.get(prevKey);
    const currWeek = weekMap.get(currKey);
    if (!prevWeek || !currWeek) continue;

    const rampRate = Math.round((currWeek.last - prevWeek.last) * 100) / 100;
    weeks.push({
      week: currKey,
      ctlStart: Math.round(prevWeek.last * 100) / 100,
      ctlEnd: Math.round(currWeek.last * 100) / 100,
      rampRate,
    });
  }

  const currentRampRate = weeks.length > 0 ? (weeks[weeks.length - 1]?.rampRate ?? 0) : 0;
  let recommendation = "Danger: ramp rate is too high, risk of overtraining or injury";
  if (Math.abs(currentRampRate) < 5) {
    recommendation = "Safe: ramp rate is within sustainable range";
  } else if (Math.abs(currentRampRate) <= 7) {
    recommendation = "Aggressive: monitor fatigue closely and ensure recovery";
  }
  return { weeks, currentRampRate, recommendation };
}

function expectNonEmptySqlQuery(execute: ReturnType<typeof vi.fn>, callIndex: number): void {
  const query = execute.mock.calls[callIndex]?.[0];
  expect(hasQueryChunks(query)).toBe(true);
  if (!hasQueryChunks(query)) return;
  expect(Array.isArray(query.queryChunks)).toBe(true);
  expect(query.queryChunks?.length ?? 0).toBeGreaterThan(0);
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
      const now = new Date();
      const rows: { day: string; trimp: number }[] = [];
      const base = new Date(now);
      for (let i = 14; i >= 0; i--) {
        const date = new Date(base);
        date.setDate(date.getDate() - i);
        rows.push({ day: date.toISOString().slice(0, 10), trimp: 50 + i * 2 });
      }
      const caller = makeCaller(rows);
      const result = await caller.rampRate({ days: 90 });
      const expected = computeRampRateExpected(rows, now, 90);

      expect(result).toEqual(expected);
    });

    it("gives safe recommendation for low ramp rate", async () => {
      // Small, consistent loads → low ramp rate
      const rows: { day: string; trimp: number }[] = [];
      const base = new Date();
      for (let i = 30; i >= 0; i--) {
        const date = new Date(base);
        date.setDate(date.getDate() - i);
        rows.push({ day: date.toISOString().slice(0, 10), trimp: 50 });
      }
      const caller = makeCaller(rows);
      const result = await caller.rampRate({ days: 90 });

      // Constant load → near-zero ramp rate → safe
      expect(result.recommendation).toContain("Safe");
    });

    it("gives danger recommendation for very high ramp rate", async () => {
      // Freeze time to a Sunday so week grouping is deterministic
      // (avoids flaky failures when a partial week has too few days)
      vi.useFakeTimers({ now: new Date("2026-01-25T12:00:00Z") });
      try {
        const rows: { day: string; trimp: number }[] = [];
        const base = new Date();
        // First 3 weeks: low load
        for (let i = 28; i >= 14; i--) {
          const date = new Date(base);
          date.setDate(date.getDate() - i);
          rows.push({ day: date.toISOString().slice(0, 10), trimp: 10 });
        }
        // Last 2 weeks: very high load
        for (let i = 13; i >= 0; i--) {
          const date = new Date(base);
          date.setDate(date.getDate() - i);
          rows.push({ day: date.toISOString().slice(0, 10), trimp: 1000 });
        }
        const caller = makeCaller(rows);
        const result = await caller.rampRate({ days: 90 });

        // Large jump should trigger danger
        expect(result.recommendation).toContain("Danger");
      } finally {
        vi.useRealTimers();
      }
    });

    it("gives aggressive recommendation for moderate-high ramp rate", async () => {
      const base = new Date();
      let chosenRows: { day: string; trimp: number }[] | null = null;
      let expected: ReturnType<typeof computeRampRateExpected> | null = null;

      for (const high of [80, 100, 120, 150, 200, 250, 300, 350, 400, 500]) {
        const candidate = [...buildRows(base, 28, 14, 10), ...buildRows(base, 13, 0, high)];
        const projected = computeRampRateExpected(candidate, base, 90);
        if (projected.recommendation.includes("Aggressive")) {
          chosenRows = candidate;
          expected = projected;
          break;
        }
      }
      expect(chosenRows).not.toBeNull();
      expect(expected).not.toBeNull();

      const caller = makeCaller(chosenRows ?? []);
      const result = await caller.rampRate({ days: 90 });

      expect(result.currentRampRate).toBe(expected?.currentRampRate);
      expect(result.recommendation).toContain("Aggressive");
    });

    it("currentRampRate matches last week's ramp rate", async () => {
      const rows: { day: string; trimp: number }[] = [];
      const base = new Date();
      for (let i = 21; i >= 0; i--) {
        const date = new Date(base);
        date.setDate(date.getDate() - i);
        rows.push({ day: date.toISOString().slice(0, 10), trimp: 50 + i });
      }
      const caller = makeCaller(rows);
      const result = await caller.rampRate({ days: 90 });

      if (result.weeks.length > 0) {
        const lastWeek = result.weeks[result.weeks.length - 1];
        expect(result.currentRampRate).toBe(lastWeek?.rampRate ?? 0);
      }
    });

    it("executes a non-empty SQL query", async () => {
      const execute = vi.fn().mockResolvedValue([{ day: "2026-03-11", trimp: 75 }]);
      const caller = createCaller({ db: { execute }, userId: "user-1", timezone: "UTC" });

      await caller.rampRate({ days: 90 });

      expectNonEmptySqlQuery(execute, 0);
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

    it("executes a non-empty SQL query", async () => {
      const execute = vi
        .fn()
        .mockResolvedValue([{ week: "2024-01-08", monotony: 1.2, strain: 200, weekly_load: 150 }]);
      const caller = createCaller({ db: { execute }, userId: "user-1", timezone: "UTC" });

      await caller.trainingMonotony({ days: 90 });

      expectNonEmptySqlQuery(execute, 0);
    });
  });

  describe("activityVariability", () => {
    it("returns empty rows and zero totalCount when no FTP data", async () => {
      const caller = makeCaller([]);
      const result = await caller.activityVariability({ days: 90 });
      expect(result).toEqual({ rows: [], totalCount: 0 });
    });

    it("computes variability from power data", async () => {
      const execute = vi.fn();
      // First call: FTP estimation
      execute.mockResolvedValueOnce([{ ftp: 250 }]);
      // Second call: NP/avg power per activity (with total_count from COUNT(*) OVER())
      execute.mockResolvedValueOnce([
        {
          activity_id: "ride-1",
          date: "2024-01-15",
          name: "Ride",
          np: 230,
          avg_power: 200,
          total_count: 1,
        },
      ]);

      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.activityVariability({ days: 90 });

      expect(result.rows).toHaveLength(1);
      expect(result.totalCount).toBe(1);
      expect(result.rows[0]?.normalizedPower).toBe(230);
      expect(result.rows[0]?.variabilityIndex).toBe(1.15); // 230/200
      expect(result.rows[0]?.intensityFactor).toBe(0.92); // 230/250
      expectNonEmptySqlQuery(execute, 0);
      expectNonEmptySqlQuery(execute, 1);
    });

    it("computes variability index as NP / avgPower", async () => {
      const execute = vi.fn();
      execute.mockResolvedValueOnce([{ ftp: 300 }]);
      execute.mockResolvedValueOnce([
        {
          activity_id: "ride-2",
          date: "2024-01-15",
          name: "Ride",
          np: 280,
          avg_power: 250,
          total_count: 1,
        },
      ]);

      const caller = createCaller({ db: { execute }, userId: "user-1", timezone: "UTC" });
      const result = await caller.activityVariability({ days: 90 });

      // VI = 280/250 = 1.12
      expect(result.rows[0]?.variabilityIndex).toBe(Math.round((280 / 250) * 1000) / 1000);
      // IF = 280/300 = 0.933
      expect(result.rows[0]?.intensityFactor).toBe(Math.round((280 / 300) * 1000) / 1000);
    });

    it("maps activityName from name field", async () => {
      const execute = vi.fn();
      execute.mockResolvedValueOnce([{ ftp: 200 }]);
      execute.mockResolvedValueOnce([
        {
          activity_id: "ride-3",
          date: "2024-01-15",
          name: "Zwift Race",
          np: 190,
          avg_power: 180,
          total_count: 1,
        },
      ]);

      const caller = createCaller({ db: { execute }, userId: "user-1", timezone: "UTC" });
      const result = await caller.activityVariability({ days: 90 });

      expect(result.rows[0]?.activityId).toBe("ride-3");
      expect(result.rows[0]?.activityName).toBe("Zwift Race");
      expect(result.rows[0]?.date).toBe("2024-01-15");
      expect(result.rows[0]?.averagePower).toBe(180);
    });

    it("returns totalCount from the query regardless of limit/offset", async () => {
      const execute = vi.fn();
      execute.mockResolvedValueOnce([{ ftp: 250 }]);
      execute.mockResolvedValueOnce([
        {
          activity_id: "ride-4",
          date: "2024-01-15",
          name: "Ride 1",
          np: 230,
          avg_power: 200,
          total_count: 5,
        },
        {
          activity_id: "ride-5",
          date: "2024-01-16",
          name: "Ride 2",
          np: 240,
          avg_power: 210,
          total_count: 5,
        },
      ]);

      const caller = createCaller({ db: { execute }, userId: "user-1", timezone: "UTC" });
      const result = await caller.activityVariability({ days: 90, limit: 2, offset: 0 });

      expect(result.rows).toHaveLength(2);
      expect(result.totalCount).toBe(5);
    });

    it("returns empty rows safely when page offset has no rows", async () => {
      const execute = vi.fn();
      execute.mockResolvedValueOnce([{ ftp: 250 }]);
      execute.mockResolvedValueOnce([]);

      const caller = createCaller({ db: { execute }, userId: "user-1", timezone: "UTC" });
      const result = await caller.activityVariability({ days: 90, limit: 20, offset: 200 });

      expect(result).toEqual({ rows: [], totalCount: 0 });
    });

    it("does not execute the activity query when FTP is missing", async () => {
      const execute = vi.fn();
      execute.mockResolvedValueOnce([]);
      execute.mockResolvedValueOnce([
        {
          activity_id: "ride-6",
          date: "2024-01-15",
          name: "Ride",
          np: 230,
          avg_power: 200,
          total_count: 1,
        },
      ]);

      const caller = createCaller({ db: { execute }, userId: "user-1", timezone: "UTC" });
      const result = await caller.activityVariability({ days: 90, limit: 20, offset: 0 });

      expect(result).toEqual({ rows: [], totalCount: 0 });
      expect(execute).toHaveBeenCalledTimes(1);
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

    it("executes a non-empty SQL query", async () => {
      const execute = vi
        .fn()
        .mockResolvedValue([
          { date: "2024-01-15", name: "Climb", elevation_gain: 500, climbing_seconds: 3600 },
        ]);
      const caller = createCaller({ db: { execute }, userId: "user-1", timezone: "UTC" });

      await caller.verticalAscentRate({ days: 90 });

      expectNonEmptySqlQuery(execute, 0);
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

    it("executes a non-empty SQL query", async () => {
      const execute = vi.fn().mockResolvedValue([
        {
          date: "2024-01-15",
          name: "Trainer Ride",
          avg_balance: 49.5,
          avg_torque_effectiveness: 85.3,
          avg_pedal_smoothness: 22.1,
        },
      ]);
      const caller = createCaller({ db: { execute }, userId: "user-1", timezone: "UTC" });

      await caller.pedalDynamics({ days: 90 });

      expectNonEmptySqlQuery(execute, 0);
    });
  });
});
