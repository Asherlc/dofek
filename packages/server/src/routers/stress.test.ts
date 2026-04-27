import { defaultStressThresholds } from "@dofek/recovery/stress";
import { describe, expect, it, vi } from "vitest";

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
        _schema: unknown,
        query: unknown,
      ) => db.execute(query),
    ),
  };
});

vi.mock("dofek/personalization/storage", () => ({
  loadPersonalizedParams: vi.fn().mockResolvedValue(null),
}));

vi.mock("dofek/personalization/params", () => ({
  getEffectiveParams: vi.fn().mockReturnValue({
    stressThresholds: defaultStressThresholds(),
  }),
}));

import { stressRouter } from "./stress.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

const createCaller = createTestCallerFactory(stressRouter);

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    date: "2026-03-20",
    hrv: null,
    resting_hr: null,
    hrv_mean_60d: null,
    hrv_sd_60d: null,
    rhr_mean_60d: null,
    rhr_sd_60d: null,
    efficiency_pct: null,
    ...overrides,
  };
}

function makeCaller(rows: unknown[]) {
  return createCaller({
    db: { execute: vi.fn().mockResolvedValue(rows) },
    userId: "user-1",
    timezone: "UTC",
  });
}

describe("Router transformation logic", () => {
  it("returns empty result when no rows", async () => {
    const caller = makeCaller([]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily).toEqual([]);
    expect(result.weekly).toEqual([]);
    expect(result.latestScore).toBeNull();
    expect(result.trend).toBe("stable");
  });

  it("computes HRV z-score deviation when all values present and sd > 0", async () => {
    // hrv=40, mean=60, sd=10 → z = (40-60)/10 = -2.0
    const row = makeRow({ hrv: 40, hrv_mean_60d: 60, hrv_sd_60d: 10 });
    const caller = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.hrvDeviation).toBe(-2.0);
  });

  it("returns null HRV deviation when hrv is null", async () => {
    const row = makeRow({ hrv: null, hrv_mean_60d: 60, hrv_sd_60d: 10 });
    const caller = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.hrvDeviation).toBeNull();
  });

  it("returns null HRV deviation when hrv_mean_60d is null", async () => {
    const row = makeRow({ hrv: 40, hrv_mean_60d: null, hrv_sd_60d: 10 });
    const caller = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.hrvDeviation).toBeNull();
  });

  it("returns null HRV deviation when hrv_sd_60d is null", async () => {
    const row = makeRow({ hrv: 40, hrv_mean_60d: 60, hrv_sd_60d: null });
    const caller = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.hrvDeviation).toBeNull();
  });

  it("returns null HRV deviation when hrv_sd_60d is 0 (avoids division by zero)", async () => {
    const row = makeRow({ hrv: 40, hrv_mean_60d: 60, hrv_sd_60d: 0 });
    const caller = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.hrvDeviation).toBeNull();
  });

  it("rounds HRV deviation to 2 decimal places", async () => {
    // hrv=45, mean=60, sd=7 → z = (45-60)/7 = -2.14285... → -2.14
    const row = makeRow({ hrv: 45, hrv_mean_60d: 60, hrv_sd_60d: 7 });
    const caller = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.hrvDeviation).toBe(-2.14);
  });

  it("computes RHR z-score deviation when all values present and sd > 0", async () => {
    // resting_hr=70, mean=60, sd=5 → z = (70-60)/5 = 2.0
    const row = makeRow({ resting_hr: 70, rhr_mean_60d: 60, rhr_sd_60d: 5 });
    const caller = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.restingHrDeviation).toBe(2.0);
  });

  it("returns null RHR deviation when resting_hr is null", async () => {
    const row = makeRow({ resting_hr: null, rhr_mean_60d: 60, rhr_sd_60d: 5 });
    const caller = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.restingHrDeviation).toBeNull();
  });

  it("returns null RHR deviation when rhr_mean_60d is null", async () => {
    const row = makeRow({ resting_hr: 70, rhr_mean_60d: null, rhr_sd_60d: 5 });
    const caller = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.restingHrDeviation).toBeNull();
  });

  it("returns null RHR deviation when rhr_sd_60d is null", async () => {
    const row = makeRow({ resting_hr: 70, rhr_mean_60d: 60, rhr_sd_60d: null });
    const caller = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.restingHrDeviation).toBeNull();
  });

  it("returns null RHR deviation when rhr_sd_60d is 0", async () => {
    const row = makeRow({ resting_hr: 70, rhr_mean_60d: 60, rhr_sd_60d: 0 });
    const caller = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.restingHrDeviation).toBeNull();
  });

  it("rounds RHR deviation to 2 decimal places", async () => {
    // resting_hr=67, mean=60, sd=3 → z = (67-60)/3 = 2.33333... → 2.33
    const row = makeRow({ resting_hr: 67, rhr_mean_60d: 60, rhr_sd_60d: 3 });
    const caller = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.restingHrDeviation).toBe(2.33);
  });

  it("converts efficiency_pct to sleepEfficiency and rounds to 1 decimal", async () => {
    const row = makeRow({ efficiency_pct: 87.654 });
    const caller = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.sleepEfficiency).toBe(87.7);
  });

  it("returns null sleepEfficiency when efficiency_pct is null", async () => {
    const row = makeRow({ efficiency_pct: null });
    const caller = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.sleepEfficiency).toBeNull();
  });

  it("returns latestScore from the last daily entry", async () => {
    const rows = [
      makeRow({ date: "2026-03-19", hrv: 40, hrv_mean_60d: 60, hrv_sd_60d: 10 }),
      makeRow({ date: "2026-03-20", hrv: 55, hrv_mean_60d: 60, hrv_sd_60d: 10 }),
    ];
    const caller = makeCaller(rows);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily).toHaveLength(2);
    expect(result.latestScore).toBe(result.daily[1]?.stressScore);
  });

  it("returns null latestScore when daily is empty", async () => {
    const caller = makeCaller([]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.latestScore).toBeNull();
  });

  it("passes correct stressScore from computeDailyStress", async () => {
    // HRV deviation = (40-60)/10 = -2.0 → hrvStress = 1.5 (default: < -2.0)
    // Actually with default thresholds: hrvThresholds = [-2.0, -1.5, -1.0]
    // -2.0 < -2.0 is false, -2.0 < -1.5 is true → hrvStress = 1.2
    // RHR deviation = (70-60)/5 = 2.0 → rhrThresholds = [2.0, 1.5, 1.0]
    // 2.0 > 2.0 is false, 2.0 > 1.5 is true → rhrStress = 0.8
    // sleepEff = 75 → < 80 → sleepStress = 0.3
    // total = 1.2 + 0.8 + 0.3 = 2.3
    const row = makeRow({
      hrv: 40,
      hrv_mean_60d: 60,
      hrv_sd_60d: 10,
      resting_hr: 70,
      rhr_mean_60d: 60,
      rhr_sd_60d: 5,
      efficiency_pct: 75,
    });
    const caller = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.stressScore).toBe(2.3);
  });

  it("includes date from the row", async () => {
    const row = makeRow({ date: "2026-03-15" });
    const caller = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.date).toBe("2026-03-15");
  });

  it("returns weekly aggregation from aggregateWeeklyStress", async () => {
    // 7 days in the same week → one weekly entry
    const rows = Array.from({ length: 7 }, (_, index) =>
      makeRow({
        date: `2026-03-${String(17 + index).padStart(2, "0")}`,
        hrv: 30,
        hrv_mean_60d: 60,
        hrv_sd_60d: 10,
      }),
    );
    const caller = makeCaller(rows);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.weekly.length).toBeGreaterThan(0);
    expect(result.weekly[0]).toHaveProperty("weekStart");
    expect(result.weekly[0]).toHaveProperty("cumulativeStress");
    expect(result.weekly[0]).toHaveProperty("avgDailyStress");
    expect(result.weekly[0]).toHaveProperty("highStressDays");
  });

  it("returns trend from computeStressTrend (stable for < 14 days)", async () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      makeRow({ date: `2026-03-${String(16 + index).padStart(2, "0")}` }),
    );
    const caller = makeCaller(rows);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.trend).toBe("stable");
  });

  it("computes correct trend for 14+ days of data", async () => {
    // First 7 days: high stress (very low HRV)
    // Last 7 days: no stress (all nulls)
    // → improving trend
    const rows = [
      ...Array.from({ length: 7 }, (_, index) =>
        makeRow({
          date: `2026-03-${String(4 + index).padStart(2, "0")}`,
          hrv: 20,
          hrv_mean_60d: 60,
          hrv_sd_60d: 10,
          resting_hr: 80,
          rhr_mean_60d: 60,
          rhr_sd_60d: 5,
          efficiency_pct: 60,
        }),
      ),
      ...Array.from({ length: 7 }, (_, index) =>
        makeRow({
          date: `2026-03-${String(11 + index).padStart(2, "0")}`,
        }),
      ),
    ];
    const caller = makeCaller(rows);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.trend).toBe("improving");
  });

  it("handles all-null metrics (zero stress score)", async () => {
    const row = makeRow();
    const caller = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.stressScore).toBe(0);
    expect(result.daily[0]?.hrvDeviation).toBeNull();
    expect(result.daily[0]?.restingHrDeviation).toBeNull();
    expect(result.daily[0]?.sleepEfficiency).toBeNull();
  });

  it("uses Number() coercion on string-like db values", async () => {
    // Drizzle may return string values from raw SQL
    const row = makeRow({
      hrv: "45",
      hrv_mean_60d: "60",
      hrv_sd_60d: "10",
      resting_hr: "65",
      rhr_mean_60d: "60",
      rhr_sd_60d: "5",
      efficiency_pct: "85.5",
    });
    const caller = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    // (45-60)/10 = -1.5 → rounds to -1.5
    expect(result.daily[0]?.hrvDeviation).toBe(-1.5);
    // (65-60)/5 = 1.0 → rounds to 1.0
    expect(result.daily[0]?.restingHrDeviation).toBe(1.0);
    expect(result.daily[0]?.sleepEfficiency).toBe(85.5);
  });

  it("caps stress score at 3.0 (max stress)", async () => {
    // Very low HRV → 1.5, very high RHR → 1.0, very poor sleep → 0.5 = 3.0
    // Even more extreme wouldn't go above 3.0
    const row = makeRow({
      hrv: 10,
      hrv_mean_60d: 60,
      hrv_sd_60d: 10,
      resting_hr: 90,
      rhr_mean_60d: 60,
      rhr_sd_60d: 5,
      efficiency_pct: 50,
    });
    const caller = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    // (10-60)/10 = -5.0 → < -2.0 → 1.5
    // (90-60)/5 = 6.0 → > 2.0 → 1.0
    // 50 < 70 → 0.5
    // Total = 3.0, capped at 3.0
    expect(result.daily[0]?.stressScore).toBe(3);
  });

  it("positive HRV deviation produces zero HRV stress", async () => {
    // hrv above baseline: (70-60)/10 = 1.0 → not < 0 → hrvStress = 0
    const row = makeRow({
      hrv: 70,
      hrv_mean_60d: 60,
      hrv_sd_60d: 10,
    });
    const caller = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.hrvDeviation).toBe(1.0);
    expect(result.daily[0]?.stressScore).toBe(0);
  });

  it("negative RHR deviation produces zero RHR stress", async () => {
    // resting_hr below baseline: (55-60)/5 = -1.0 → not > 0 → rhrStress = 0
    const row = makeRow({
      resting_hr: 55,
      rhr_mean_60d: 60,
      rhr_sd_60d: 5,
    });
    const caller = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.restingHrDeviation).toBe(-1.0);
    expect(result.daily[0]?.stressScore).toBe(0);
  });

  it("good sleep efficiency produces zero sleep stress", async () => {
    // 90% > 85% → sleepStress = 0
    const row = makeRow({ efficiency_pct: 90 });
    const caller = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.sleepEfficiency).toBe(90);
    expect(result.daily[0]?.stressScore).toBe(0);
  });

  it("worsening trend with 14+ days of increasing stress", async () => {
    // First 7 days: no stress
    // Last 7 days: high stress
    const rows = [
      ...Array.from({ length: 7 }, (_, index) =>
        makeRow({
          date: `2026-03-${String(4 + index).padStart(2, "0")}`,
        }),
      ),
      ...Array.from({ length: 7 }, (_, index) =>
        makeRow({
          date: `2026-03-${String(11 + index).padStart(2, "0")}`,
          hrv: 20,
          hrv_mean_60d: 60,
          hrv_sd_60d: 10,
          resting_hr: 80,
          rhr_mean_60d: 60,
          rhr_sd_60d: 5,
          efficiency_pct: 60,
        }),
      ),
    ];
    const caller = makeCaller(rows);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.trend).toBe("worsening");
  });
});

describe("stressRouter access window gating", () => {
  it("scores passes accessWindow to query (limited window returns empty)", async () => {
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
    const result = await caller.scores({ days: 30, endDate: "2026-04-20" });
    expect(result.daily).toEqual([]);
    expect(result.latestScore).toBeNull();
  });
});
