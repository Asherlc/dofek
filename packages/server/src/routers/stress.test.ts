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
      sensorStore?: import("../repositories/activity-repository.ts").ActivitySensorStore;
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
    hrv_z_score: null,
    resting_hr_z_score: null,
    efficiency_pct: null,
    ...overrides,
  };
}

function makeCaller(rows: unknown[], query = vi.fn().mockResolvedValue(rows)) {
  const caller = createCaller({
    db: { execute: vi.fn().mockResolvedValue([]) },
    userId: "user-1",
    timezone: "UTC",
    sensorStore: {
      query,
      getActivitySummaries: vi.fn().mockResolvedValue([]),
      getStream: vi.fn().mockResolvedValue([]),
      getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
      getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
      getPowerCurveSamples: vi.fn().mockResolvedValue([]),
      getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
      getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
      getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
      getPaceCurveRows: vi.fn().mockResolvedValue([]),
    },
  });
  return { caller, query };
}

describe("Router transformation logic", () => {
  it("returns empty result when no rows", async () => {
    const { caller } = makeCaller([]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily).toEqual([]);
    expect(result.weekly).toEqual([]);
    expect(result.latestScore).toBeNull();
    expect(result.trend).toBe("stable");
  });

  it("reads daily recovery inputs from the ClickHouse read model", async () => {
    const { caller, query } = makeCaller([]);

    await caller.scores({ days: 30, endDate: "2026-03-24" });

    const queryText = query.mock.calls.find(
      ([, sqlText]) => typeof sqlText === "string" && sqlText.includes("analytics.daily_recovery"),
    )?.[1];
    expect(queryText).toEqual(expect.any(String));
    expect(queryText).toContain("hrv_z_score");
    expect(queryText).toContain("resting_hr_z_score");
    expect(queryText).toContain("recovery_inputs.is_deleted = 0");
    expect(queryText).not.toContain("fitness.v_daily_metrics");
    expect(queryText).not.toContain("analytics.v_sleep");
  });

  it("uses a lower date bound for finite selected ranges", async () => {
    const { caller, query } = makeCaller([]);

    await caller.scores({ days: 30, endDate: "2026-03-24" });

    const queryText = query.mock.calls[0]?.[1];
    const queryParams = query.mock.calls[0]?.[2];
    expect(queryText).toContain("recovery_inputs.date > toDate({windowStart:String})");
    expect(queryParams).toMatchObject({ windowStart: "2026-02-22", endDate: "2026-03-24" });
  });

  it("omits the lower date bound when days is null", async () => {
    const { caller, query } = makeCaller([]);

    await caller.scores({ days: null, endDate: "2026-03-24" });

    const queryText = query.mock.calls[0]?.[1];
    const queryParams = query.mock.calls[0]?.[2];
    expect(queryText).toContain("recovery_inputs.user_id = {userId:UUID}");
    expect(queryText).not.toContain("windowStart");
    expect(queryParams).toMatchObject({ userId: "user-1", endDate: "2026-03-24" });
    expect(queryParams).not.toHaveProperty("windowStart");
  });

  it("rejects unbounded day windows", async () => {
    const { caller } = makeCaller([]);
    await expect(caller.scores({ days: 366, endDate: "2026-03-24" })).rejects.toThrow();
  });

  it("returns the canonical HRV z-score deviation", async () => {
    const row = makeRow({ hrv_z_score: -2 });
    const { caller } = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.hrvDeviation).toBe(-2.0);
  });

  it("returns null HRV deviation when its canonical z-score is null", async () => {
    const row = makeRow({ hrv_z_score: null });
    const { caller } = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.hrvDeviation).toBeNull();
  });

  it("returns null HRV deviation when the canonical z-score is null", async () => {
    const row = makeRow({ hrv_z_score: null });
    const { caller } = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.hrvDeviation).toBeNull();
  });

  it("keeps a missing canonical HRV z-score null", async () => {
    const row = makeRow({ hrv_z_score: null });
    const { caller } = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.hrvDeviation).toBeNull();
  });

  it("does not derive HRV deviation from raw inputs", async () => {
    const row = makeRow({ hrv_z_score: null });
    const { caller } = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.hrvDeviation).toBeNull();
  });

  it("rounds HRV deviation to 2 decimal places", async () => {
    const row = makeRow({ hrv_z_score: -2.142857 });
    const { caller } = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.hrvDeviation).toBe(-2.14);
  });

  it("returns the canonical RHR z-score deviation", async () => {
    const row = makeRow({ resting_hr_z_score: 2 });
    const { caller } = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.restingHrDeviation).toBe(2.0);
  });

  it("returns null RHR deviation when its canonical z-score is null", async () => {
    const row = makeRow({ resting_hr_z_score: null });
    const { caller } = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.restingHrDeviation).toBeNull();
  });

  it("returns null RHR deviation when the canonical z-score is null", async () => {
    const row = makeRow({ resting_hr_z_score: null });
    const { caller } = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.restingHrDeviation).toBeNull();
  });

  it("keeps a missing canonical RHR z-score null", async () => {
    const row = makeRow({ resting_hr_z_score: null });
    const { caller } = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.restingHrDeviation).toBeNull();
  });

  it("does not derive RHR deviation from raw inputs", async () => {
    const row = makeRow({ resting_hr_z_score: null });
    const { caller } = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.restingHrDeviation).toBeNull();
  });

  it("rounds RHR deviation to 2 decimal places", async () => {
    const row = makeRow({ resting_hr_z_score: 2.333333 });
    const { caller } = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.restingHrDeviation).toBe(2.33);
  });

  it("converts efficiency_pct to sleepEfficiency and rounds to 1 decimal", async () => {
    const row = makeRow({ efficiency_pct: 87.654 });
    const { caller } = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.sleepEfficiency).toBe(87.7);
  });

  it("returns null sleepEfficiency when efficiency_pct is null", async () => {
    const row = makeRow({ efficiency_pct: null });
    const { caller } = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.sleepEfficiency).toBeNull();
  });

  it("returns latestScore from the last daily entry", async () => {
    const rows = [
      makeRow({ date: "2026-03-19", hrv_z_score: -2 }),
      makeRow({ date: "2026-03-20", hrv_z_score: -0.5 }),
    ];
    const { caller } = makeCaller(rows);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily).toHaveLength(2);
    expect(result.latestScore).toBe(result.daily[1]?.stressScore);
  });

  it("returns null latestScore when daily is empty", async () => {
    const { caller } = makeCaller([]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.latestScore).toBeNull();
  });

  it("passes correct stressScore from computeDailyStress", async () => {
    // HRV z-score -2.0 → hrvStress = 1.5 (default: < -2.0)
    // Actually with default thresholds: hrvThresholds = [-2.0, -1.5, -1.0]
    // -2.0 < -2.0 is false, -2.0 < -1.5 is true → hrvStress = 1.2
    // RHR z-score 2.0 → rhrThresholds = [2.0, 1.5, 1.0]
    // 2.0 > 2.0 is false, 2.0 > 1.5 is true → rhrStress = 0.8
    // sleepEff = 75 → < 80 → sleepStress = 0.3
    // total = 1.2 + 0.8 + 0.3 = 2.3
    const row = makeRow({
      hrv_z_score: -2,
      resting_hr_z_score: 2,
      efficiency_pct: 75,
    });
    const { caller } = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.stressScore).toBe(2.3);
  });

  it("includes date from the row", async () => {
    const row = makeRow({ date: "2026-03-15" });
    const { caller } = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.date).toBe("2026-03-15");
  });

  it("returns weekly aggregation from aggregateWeeklyStress", async () => {
    // 7 days in the same week → one weekly entry
    const rows = Array.from({ length: 7 }, (_, index) =>
      makeRow({
        date: `2026-03-${String(17 + index).padStart(2, "0")}`,
        hrv_z_score: -3,
      }),
    );
    const { caller } = makeCaller(rows);
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
    const { caller } = makeCaller(rows);
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
          hrv_z_score: -4,
          resting_hr_z_score: 4,
          efficiency_pct: 60,
        }),
      ),
      ...Array.from({ length: 7 }, (_, index) =>
        makeRow({
          date: `2026-03-${String(11 + index).padStart(2, "0")}`,
        }),
      ),
    ];
    const { caller } = makeCaller(rows);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.trend).toBe("improving");
  });

  it("handles all-null metrics (zero stress score)", async () => {
    const row = makeRow();
    const { caller } = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.stressScore).toBe(0);
    expect(result.daily[0]?.hrvDeviation).toBeNull();
    expect(result.daily[0]?.restingHrDeviation).toBeNull();
    expect(result.daily[0]?.sleepEfficiency).toBeNull();
  });

  it("uses Number() coercion on string-like db values", async () => {
    // Drizzle may return string values from raw SQL
    const row = makeRow({
      hrv_z_score: "-1.5",
      resting_hr_z_score: "1",
      efficiency_pct: "85.5",
    });
    const { caller } = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    // Canonical HRV z-score -1.5 is preserved.
    expect(result.daily[0]?.hrvDeviation).toBe(-1.5);
    // Canonical RHR z-score 1.0 is preserved.
    expect(result.daily[0]?.restingHrDeviation).toBe(1.0);
    expect(result.daily[0]?.sleepEfficiency).toBe(85.5);
  });

  it("caps stress score at 3.0 (max stress)", async () => {
    // Very low HRV → 1.5, very high RHR → 1.0, very poor sleep → 0.5 = 3.0
    // Even more extreme wouldn't go above 3.0
    const row = makeRow({
      hrv_z_score: -5,
      resting_hr_z_score: 6,
      efficiency_pct: 50,
    });
    const { caller } = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    // HRV z-score -5.0 → < -2.0 → 1.5
    // RHR z-score 6.0 → > 2.0 → 1.0
    // 50 < 70 → 0.5
    // Total = 3.0, capped at 3.0
    expect(result.daily[0]?.stressScore).toBe(3);
  });

  it("positive HRV deviation produces zero HRV stress", async () => {
    // Positive HRV z-score → hrvStress = 0
    const row = makeRow({
      hrv_z_score: 1,
    });
    const { caller } = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.hrvDeviation).toBe(1.0);
    expect(result.daily[0]?.stressScore).toBe(0);
  });

  it("negative RHR deviation produces zero RHR stress", async () => {
    // Negative RHR z-score → rhrStress = 0
    const row = makeRow({
      resting_hr_z_score: -1,
    });
    const { caller } = makeCaller([row]);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.daily[0]?.restingHrDeviation).toBe(-1.0);
    expect(result.daily[0]?.stressScore).toBe(0);
  });

  it("good sleep efficiency produces zero sleep stress", async () => {
    // 90% > 85% → sleepStress = 0
    const row = makeRow({ efficiency_pct: 90 });
    const { caller } = makeCaller([row]);
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
          hrv_z_score: -4,
          resting_hr_z_score: 4,
          efficiency_pct: 60,
        }),
      ),
    ];
    const { caller } = makeCaller(rows);
    const result = await caller.scores({ days: 30, endDate: "2026-03-24" });
    expect(result.trend).toBe("worsening");
  });
});

describe("stressRouter access window gating", () => {
  it("scores passes accessWindow to query (limited window returns empty)", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const sensorStore = {
      query: vi.fn().mockResolvedValue([]),
      getActivitySummaries: vi.fn().mockResolvedValue([]),
      getStream: vi.fn().mockResolvedValue([]),
      getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
      getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
      getPowerCurveSamples: vi.fn().mockResolvedValue([]),
      getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
      getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
      getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
      getPaceCurveRows: vi.fn().mockResolvedValue([]),
    };
    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
      sensorStore,
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
    const queryText = sensorStore.query.mock.calls[0]?.[1];
    const queryParams = sensorStore.query.mock.calls[0]?.[2];
    expect(queryText).toContain("accessStartDate");
    expect(queryText).toContain("accessEndDateExclusive");
    expect(queryParams).toMatchObject({
      accessStartDate: "2026-04-10",
      accessEndDateExclusive: "2026-04-17",
    });
  });
});
