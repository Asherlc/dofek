import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      userId: string | null;
      timezone?: string;
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

type SensorStore = import("../repositories/activity-repository.ts").ActivitySensorStore;

function isMatrix(rows: unknown[] | unknown[][]): rows is unknown[][] {
  return rows.length > 0 && Array.isArray(rows[0]);
}

function makeSensorStore(rows: unknown[] | unknown[][] = []): SensorStore {
  const queryMock = isMatrix(rows)
    ? (() => {
        const fn = vi.fn();
        for (const batch of rows) fn.mockResolvedValueOnce(batch);
        fn.mockResolvedValue([]);
        return fn;
      })()
    : vi.fn().mockResolvedValue(rows);
  return {
    query: queryMock,
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
}

type SleepNightTestRow = {
  date: string;
  provider_id: string;
  started_at: string;
  ended_at: string | null;
  duration_minutes: number | null;
  deep_minutes: number | null;
  rem_minutes: number | null;
  light_minutes: number | null;
  awake_minutes: number | null;
  efficiency_pct: number | null;
};

function sleepNightRow(overrides: Partial<SleepNightTestRow> = {}): SleepNightTestRow {
  const date = overrides.date ?? "2026-03-01";
  return {
    date,
    provider_id: "apple_health",
    started_at: `${date}T22:00:00Z`,
    ended_at: `${addDays(date, 1)}T06:00:00Z`,
    duration_minutes: 480,
    deep_minutes: 90,
    rem_minutes: 105,
    light_minutes: 255,
    awake_minutes: 30,
    efficiency_pct: 93.75,
    ...overrides,
  };
}

function sleepScheduleRow(
  date: string,
  bedtimeHour: number,
  waketimeHour: number,
): SleepNightTestRow {
  return sleepNightRow({
    date,
    started_at: `${date}T${hourString(bedtimeHour)}Z`,
    ended_at: `${addDays(date, 1)}T${hourString(waketimeHour)}Z`,
  });
}

function sleepAnalyticsRow({
  date,
  durationMinutes,
  deepPct,
  remPct,
  lightPct,
  awakePct,
  efficiency,
}: {
  date: string;
  durationMinutes: number;
  deepPct: number;
  remPct: number;
  lightPct: number;
  awakePct: number;
  efficiency: number;
}): SleepNightTestRow {
  return sleepNightRow({
    date,
    duration_minutes: durationMinutes,
    deep_minutes: Math.round(durationMinutes * deepPct) / 100,
    rem_minutes: Math.round(durationMinutes * remPct) / 100,
    light_minutes: Math.round(durationMinutes * lightPct) / 100,
    awake_minutes: Math.round(durationMinutes * awakePct) / 100,
    efficiency_pct: efficiency,
  });
}

function sleepDebtRow(date: string, sleepMinutes: number, durationMinutes = sleepMinutes) {
  return sleepNightRow({
    date,
    duration_minutes: durationMinutes,
    deep_minutes: null,
    rem_minutes: null,
    light_minutes: sleepMinutes,
    awake_minutes: Math.max(0, durationMinutes - sleepMinutes),
    efficiency_pct: durationMinutes > 0 ? (sleepMinutes / durationMinutes) * 100 : null,
  });
}

function hourString(hourValue: number): string {
  const hour = Math.floor(hourValue);
  const totalSeconds = Math.round((hourValue - hour) * 3600);
  const minute = Math.floor(totalSeconds / 60);
  const second = totalSeconds % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

function addDays(dateString: string, days: number): string {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

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

import { recoveryRouter } from "./recovery.ts";

const createCaller = createTestCallerFactory(recoveryRouter);

// ── sleepConsistency ────────────────────────────────────────────

describe("recoveryRouter.sleepConsistency", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01"));
  });
  afterAll(() => {
    vi.useRealTimers();
  });
  it("returns empty array when no data", async () => {
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore([]),
    });
    const result = await caller.sleepConsistency({});
    expect(result).toEqual([]);
  });

  it("maps ClickHouse sleep rows to SleepConsistencyRow format with rounding", async () => {
    const rows = [sleepScheduleRow("2026-03-01", 22.567, 6.789)];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepConsistency({});

    expect(result).toHaveLength(1);
    expect(result[0]?.date).toBe("2026-03-01");
    // bedtimeHour rounds to 2 decimal places: 22.567 -> 22.57
    expect(result[0]?.bedtimeHour).toBe(22.57);
    expect(result[0]?.waketimeHour).toBe(6.78);
    expect(result[0]?.rollingBedtimeStddev).toBe(0);
    expect(result[0]?.rollingWaketimeStddev).toBe(0);
  });

  it("sets consistencyScore to null when fewer than 7 nights are available", async () => {
    const rows = Array.from({ length: 6 }, (_, index) =>
      sleepScheduleRow(`2026-03-${String(index + 1).padStart(2, "0")}`, 22, 7),
    );

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepConsistency({});

    expect(result.at(-1)?.consistencyScore).toBeNull();
  });

  it("computes consistencyScore when at least 7 nights are available", async () => {
    const rows = Array.from({ length: 7 }, (_, index) =>
      sleepScheduleRow(`2026-03-${String(index + 1).padStart(2, "0")}`, 22, 7),
    );

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepConsistency({});

    expect(result.at(-1)?.consistencyScore).toBe(100);
  });

  it("handles null stddev values", async () => {
    const rows = [sleepNightRow({ date: "2026-03-01", ended_at: null })];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepConsistency({});

    expect(result).toEqual([]);
  });

  it("uses default days of 90", async () => {
    const sensorStore = makeSensorStore([]);
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore,
    });
    await caller.sleepConsistency({});
    expect(sensorStore.query).toHaveBeenCalled();
  });

  it("processes multiple rows correctly", async () => {
    const rows = [sleepScheduleRow("2026-03-01", 22, 7), sleepScheduleRow("2026-03-02", 23.5, 7.5)];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepConsistency({});

    expect(result).toHaveLength(2);
    expect(result[0]?.date).toBe("2026-03-01");
    expect(result[1]?.date).toBe("2026-03-02");
    expect(result[0]?.consistencyScore).toBeNull();
    expect(result[1]?.consistencyScore).toBeNull();
  });
});

// ── hrvVariability ──────────────────────────────────────────────

describe("recoveryRouter.hrvVariability", () => {
  it("returns empty array when no data", async () => {
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore([]),
    });
    const result = await caller.hrvVariability({});
    expect(result).toEqual([]);
  });

  it("maps SQL rows to HrvVariabilityRow format with rounding", async () => {
    const rows = [
      {
        date: "2026-03-01",
        hrv: 52.678,
        rolling_mean: 48.345,
        rolling_cv: 12.567,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
      sensorStore: makeSensorStore([]),
    });
    const result = await caller.hrvVariability({});

    expect(result).toHaveLength(1);
    expect(result[0]?.date).toBe("2026-03-01");
    // hrv rounds to 1 decimal: 52.678 -> 52.7
    expect(result[0]?.hrv).toBe(52.7);
    // rollingMean rounds to 1 decimal: 48.345 -> 48.3
    expect(result[0]?.rollingMean).toBeCloseTo(48.3, 1);
    // rollingCoefficientOfVariation rounds to 2 decimal: 12.567 -> 12.57
    expect(result[0]?.rollingCoefficientOfVariation).toBe(12.57);
  });

  it("handles null hrv value", async () => {
    const rows = [
      {
        date: "2026-03-01",
        hrv: null,
        rolling_mean: 48,
        rolling_cv: 12,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
      sensorStore: makeSensorStore([]),
    });
    const result = await caller.hrvVariability({});

    expect(result[0]?.hrv).toBeNull();
  });

  it("handles null rolling_mean and rolling_cv", async () => {
    const rows = [
      {
        date: "2026-03-01",
        hrv: 50,
        rolling_mean: null,
        rolling_cv: null,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
      sensorStore: makeSensorStore([]),
    });
    const result = await caller.hrvVariability({});

    expect(result[0]?.rollingMean).toBeNull();
    expect(result[0]?.rollingCoefficientOfVariation).toBeNull();
  });

  it("uses default days of 90", async () => {
    const executeMock = vi.fn().mockResolvedValue([]);
    const caller = createCaller({
      db: { execute: executeMock },
      userId: "user-1",
      sensorStore: makeSensorStore([]),
    });
    await caller.hrvVariability({});
    expect(executeMock).toHaveBeenCalled();
  });

  it("anchors the HRV window to the supplied endDate", async () => {
    const executeMock = vi.fn().mockResolvedValue([]);
    const caller = createCaller({
      db: { execute: executeMock },
      userId: "user-1",
      sensorStore: makeSensorStore([]),
    });

    await caller.hrvVariability({ days: 30, endDate: "2026-03-15" });

    const sqlText = JSON.stringify(executeMock.mock.calls[0]?.[0]);
    expect(sqlText).toContain("2026-03-15");
    expect(sqlText).not.toContain("CURRENT_DATE");
  });
});

// ── workloadRatio ───────────────────────────────────────────────

describe("recoveryRouter.workloadRatio", () => {
  function callerWith(rows: unknown[]) {
    return createCaller({
      db: { execute: vi.fn() },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
  }

  it("returns empty timeSeries and zero strain when no data", async () => {
    const sensorStore = makeSensorStore([]);
    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-1",
      sensorStore,
    });
    const result = await caller.workloadRatio({});

    expect(result.timeSeries).toEqual([]);
    expect(result.displayedStrain).toBe(0);
    expect(result.displayedDate).toBeNull();
    const queryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
    expect(queryText).toContain("analytics.strain_read_model AS strain FINAL");
    expect(queryText).toContain("toDate(toTimeZone(toDateTime(strain.date), {timezone:String}))");
    expect(queryText).not.toContain("analytics.activity_summary");
  });

  it("passes the user timezone when reading strain read-model dates", async () => {
    const sensorStore = makeSensorStore([]);
    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-1",
      timezone: "America/Los_Angeles",
      sensorStore,
    });

    await caller.workloadRatio({ endDate: "2026-03-15" });

    expect(vi.mocked(sensorStore.query).mock.calls[0]?.[2]).toMatchObject({
      timezone: "America/Los_Angeles",
    });
  });

  it("maps SQL rows to WorkloadRatioRow format with rounding", async () => {
    const rows = [
      {
        date: "2026-03-01",
        daily_load: 125.678,
        acute_load: 500.345,
        chronic_load: 400.123,
        workload_ratio: 1.25,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.workloadRatio({});

    expect(result.timeSeries).toHaveLength(1);
    const row = result.timeSeries[0];
    expect(row?.date).toBe("2026-03-01");
    expect(row?.dailyLoad).toBe(125.7);
    expect(row?.acuteLoad).toBeCloseTo(500.3, 1);
    expect(row?.chronicLoad).toBe(400.1);
    expect(row?.workloadRatio).toBe(1.25);
  });

  it("handles null workload_ratio", async () => {
    const rows = [
      {
        date: "2026-03-01",
        daily_load: 50,
        acute_load: 200,
        chronic_load: 300,
        workload_ratio: null,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.workloadRatio({});

    expect(result.timeSeries[0]?.workloadRatio).toBeNull();
  });

  it("computes zero strain from zero acute load", async () => {
    const rows = [
      {
        date: "2026-03-01",
        daily_load: 0,
        acute_load: 0,
        chronic_load: 0,
        workload_ratio: null,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.workloadRatio({});

    expect(result.timeSeries[0]?.strain).toBe(0);
  });

  it("computes non-zero strain for positive acute load", async () => {
    const rows = [
      {
        date: "2026-03-01",
        daily_load: 100,
        acute_load: 500,
        chronic_load: 400,
        workload_ratio: 1.25,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.workloadRatio({});

    expect(result.timeSeries[0]?.strain).toBeGreaterThan(0);
  });

  it("derives daily strain from the day's load instead of rolling acute load", async () => {
    const rows = [
      {
        date: "2026-03-23",
        daily_load: 0,
        acute_load: 500,
        chronic_load: 400,
        workload_ratio: 1.25,
      },
    ];

    const result = await callerWith(rows).workloadRatio({});

    expect(result.timeSeries[0]?.strain).toBe(0);
    expect(result.displayedStrain).toBe(0);
  });

  it("uses default days of 90", async () => {
    const sensorStore = makeSensorStore([]);
    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-1",
      sensorStore,
    });
    await caller.workloadRatio({});
    expect(sensorStore.query).toHaveBeenCalled();
  });

  it("displayedStrain and displayedDate reflect latest daily strain", async () => {
    const rows = [
      {
        date: "2026-03-01",
        daily_load: 100,
        acute_load: 500,
        chronic_load: 400,
        workload_ratio: 1.25,
      },
      {
        date: "2026-03-02",
        daily_load: 0,
        acute_load: 400,
        chronic_load: 380,
        workload_ratio: 1.05,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.workloadRatio({});

    expect(result.displayedDate).toBe("2026-03-02");
    expect(result.displayedStrain).toBe(0);
  });
});

// ── sleepAnalytics ──────────────────────────────────────────────

describe("recoveryRouter.sleepAnalytics", () => {
  it("returns empty nightly and zero sleep debt when no data", async () => {
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore([]),
    });
    const result = await caller.sleepAnalytics({});

    expect(result.nightly).toEqual([]);
    expect(result.sleepDebt).toBe(0);
  });

  it("maps ClickHouse rows to SleepNightlyRow format with rounding", async () => {
    const rows = [
      sleepAnalyticsRow({
        date: "2026-03-01",
        durationMinutes: 480,
        deepPct: 18.567,
        remPct: 22.345,
        lightPct: 50.123,
        awakePct: 8.965,
        efficiency: 93.456,
      }),
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepAnalytics({});

    expect(result.nightly).toHaveLength(1);
    const night = result.nightly[0];
    expect(night?.date).toBe("2026-03-01");
    expect(night?.durationMinutes).toBe(480);
    expect(night?.sleepMinutes).toBeCloseTo(436.97, 1);
    // deepPct rounds to 1 decimal: 18.567 -> 18.6
    expect(night?.deepPct).toBe(18.6);
    // remPct rounds to 1 decimal: 22.345 -> 22.3
    expect(night?.remPct).toBeCloseTo(22.3, 1);
    // lightPct rounds to 1 decimal: 50.123 -> 50.1
    expect(night?.lightPct).toBe(50.1);
    // awakePct rounds to 1 decimal: 8.965 -> 9
    expect(night?.awakePct).toBe(9);
    // efficiency rounds to 1 decimal: 93.456 -> 93.5
    expect(night?.efficiency).toBeCloseTo(93.5, 1);
    expect(night?.rollingAvgDuration).toBeCloseTo(437, 1);
  });

  it("computes rolling average duration from available sleep rows", async () => {
    const rows = [sleepDebtRow("2026-03-01", 450, 480)];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepAnalytics({});

    expect(result.nightly[0]?.rollingAvgDuration).toBe(450);
  });

  it("computes positive sleep debt when sleep is below target", async () => {
    // Default sleep target is 480 min (8 hours)
    // 14 nights all at 420 min = 60 min deficit each = 60 * 14 = 840 total debt
    const rows = Array.from({ length: 14 }, (_, index) =>
      sleepDebtRow(`2026-03-${String(index + 1).padStart(2, "0")}`, 420),
    );

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepAnalytics({});

    // sleepDebt = sum of (480 - 420) for last 14 nights = 60 * 14 = 840
    expect(result.sleepDebt).toBe(840);
  });

  it("computes zero sleep debt when sleep meets or exceeds target", async () => {
    // Default sleep target is 480 min
    const rows = Array.from({ length: 14 }, (_, index) =>
      sleepDebtRow(`2026-03-${String(index + 1).padStart(2, "0")}`, 500),
    );

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepAnalytics({});

    // 500 - 480 = -20 per night -> debt contribution is negative so sum is negative
    // sleepDebt can be negative (surplus)
    expect(result.sleepDebt).toBe(-280);
  });

  it("sleep debt uses last 14 nights only", async () => {
    // 20 nights: first 6 at 300 min (large debt), last 14 at 480 min (no debt)
    const rows = [
      ...Array.from({ length: 6 }, (_, index) =>
        sleepDebtRow(`2026-02-${String(index + 20).padStart(2, "0")}`, 300),
      ),
      ...Array.from({ length: 14 }, (_, index) =>
        sleepDebtRow(`2026-03-${String(index + 1).padStart(2, "0")}`, 480),
      ),
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepAnalytics({});

    // Only last 14 nights matter (all at 480), so debt = 0
    expect(result.sleepDebt).toBe(0);
  });

  it("uses default days of 90", async () => {
    const sensorStore = makeSensorStore([]);
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore,
    });
    await caller.sleepAnalytics({});
    expect(sensorStore.query).toHaveBeenCalled();
  });
});

// ── readinessScore ──────────────────────────────────────────────

describe("recoveryRouter.readinessScore", () => {
  it("returns empty array when no data", async () => {
    const sensorStore = makeSensorStore([]);
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore,
    });
    const result = await caller.readinessScore({});
    expect(result).toEqual([]);
    const queryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
    const queryParams = vi.mocked(sensorStore.query).mock.calls[0]?.[2];
    expect(queryText).toContain("analytics.recovery_read_model AS recovery_inputs FINAL");
    expect(queryText).not.toContain("fitness.v_daily_metrics");
    expect(queryText).not.toContain("analytics.v_sleep");
    expect(queryText).not.toContain("accessStartDate");
    expect(queryText).not.toContain("accessEndDateExclusive");
    expect(queryParams).not.toHaveProperty("accessStartDate");
    expect(queryParams).not.toHaveProperty("accessEndDateExclusive");
  });

  it("computes readiness score from HRV, RHR, sleep efficiency, and respiratory rate", async () => {
    // Must be within 30 days of today
    const today = new Date();
    const recentDate = new Date(today);
    recentDate.setDate(today.getDate() - 5);
    const dateStr = recentDate.toISOString().split("T")[0];

    const rows = [
      {
        date: dateStr,
        hrv: 55,
        resting_hr: 58,
        respiratory_rate: 15,
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 92,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.readinessScore({});

    expect(result).toHaveLength(1);
    expect(result[0]?.date).toBe(dateStr);
    // HRV: z=(55-50)/10=0.5 → 72, RHR: z=(58-60)/5=-0.4 inverted=0.4 → 70
    // RR: z=(15-15)/1=0 inverted=0 → 62, Sleep: 92
    // Weighted: 72*0.5 + 70*0.2 + 92*0.15 + 62*0.15 = 73.1 → 73
    expect(result[0]?.components.hrvScore).toBe(72);
    expect(result[0]?.components.restingHrScore).toBe(70);
    expect(result[0]?.components.respiratoryRateScore).toBe(62);
    expect(result[0]?.components.sleepScore).toBe(92);
    expect(result[0]?.readinessScore).toBe(73);
  });

  it("filters out dates beyond cutoff", async () => {
    // Date that's 50 days ago with default 30 days input
    const today = new Date();
    const oldDate = new Date(today);
    oldDate.setDate(today.getDate() - 50);
    const oldDateStr = oldDate.toISOString().split("T")[0];

    const recentDate = new Date(today);
    recentDate.setDate(today.getDate() - 5);
    const recentDateStr = recentDate.toISOString().split("T")[0];

    const rows = [
      {
        date: oldDateStr,
        hrv: 50,
        resting_hr: 60,
        respiratory_rate: 15,
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 85,
      },
      {
        date: recentDateStr,
        hrv: 55,
        resting_hr: 58,
        respiratory_rate: 14,
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 90,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.readinessScore({});

    // Only the recent date should be included
    expect(result).toHaveLength(1);
    expect(result[0]?.date).toBe(recentDateStr);
  });

  it("filters out dates after the requested end date", async () => {
    const rows = [
      {
        date: "2026-05-21",
        hrv: 55,
        resting_hr: 58,
        respiratory_rate: 15,
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: null,
      },
      {
        date: "2026-05-22",
        hrv: null,
        resting_hr: null,
        respiratory_rate: null,
        hrv_mean_30d: null,
        hrv_sd_30d: null,
        rhr_mean_30d: null,
        rhr_sd_30d: null,
        rr_mean_30d: null,
        rr_sd_30d: null,
        efficiency_pct: null,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.readinessScore({ days: 30, endDate: "2026-05-21" });

    expect(result).toHaveLength(1);
    expect(result[0]?.date).toBe("2026-05-21");
  });

  it("defaults to 62 for HRV score when hrv_sd_30d is 0", async () => {
    const today = new Date();
    const recentDate = new Date(today);
    recentDate.setDate(today.getDate() - 5);
    const dateStr = recentDate.toISOString().split("T")[0];

    const rows = [
      {
        date: dateStr,
        hrv: 55,
        resting_hr: 60,
        respiratory_rate: 15,
        hrv_mean_30d: 50,
        hrv_sd_30d: 0, // zero stddev -> skip z-score, use default 62
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 85,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.readinessScore({});

    expect(result[0]?.components.hrvScore).toBe(62);
  });

  it("defaults to 62 for RHR score when rhr_sd_30d is 0", async () => {
    const today = new Date();
    const recentDate = new Date(today);
    recentDate.setDate(today.getDate() - 5);
    const dateStr = recentDate.toISOString().split("T")[0];

    const rows = [
      {
        date: dateStr,
        hrv: 55,
        resting_hr: 60,
        respiratory_rate: 15,
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 0, // zero stddev -> skip z-score, use default 62
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 85,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.readinessScore({});

    expect(result[0]?.components.restingHrScore).toBe(62);
  });

  it("defaults to 62 for respiratory rate score when rr_sd_30d is 0", async () => {
    const today = new Date();
    const recentDate = new Date(today);
    recentDate.setDate(today.getDate() - 5);
    const dateStr = recentDate.toISOString().split("T")[0];

    const rows = [
      {
        date: dateStr,
        hrv: 55,
        resting_hr: 60,
        respiratory_rate: 15,
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 0, // zero stddev
        efficiency_pct: 85,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.readinessScore({});

    expect(result[0]?.components.respiratoryRateScore).toBe(62);
  });

  it("defaults to 62 for all scores when metrics are null", async () => {
    const today = new Date();
    const recentDate = new Date(today);
    recentDate.setDate(today.getDate() - 5);
    const dateStr = recentDate.toISOString().split("T")[0];

    const rows = [
      {
        date: dateStr,
        hrv: null,
        resting_hr: null,
        respiratory_rate: null,
        hrv_mean_30d: null,
        hrv_sd_30d: null,
        rhr_mean_30d: null,
        rhr_sd_30d: null,
        rr_mean_30d: null,
        rr_sd_30d: null,
        efficiency_pct: null,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.readinessScore({});

    expect(result[0]?.components.hrvScore).toBe(62);
    expect(result[0]?.components.restingHrScore).toBe(62);
    expect(result[0]?.components.sleepScore).toBe(62);
    expect(result[0]?.components.respiratoryRateScore).toBe(62);
    // Weighted sum: 62 * 0.5 + 62 * 0.2 + 62 * 0.15 + 62 * 0.15 = 62
    expect(result[0]?.readinessScore).toBe(62);
  });

  it("clamps sleep efficiency score to 0-100 range", async () => {
    const today = new Date();
    const recentDate = new Date(today);
    recentDate.setDate(today.getDate() - 5);
    const dateStr = recentDate.toISOString().split("T")[0];

    const rows = [
      {
        date: dateStr,
        hrv: null,
        resting_hr: null,
        respiratory_rate: null,
        hrv_mean_30d: null,
        hrv_sd_30d: null,
        rhr_mean_30d: null,
        rhr_sd_30d: null,
        rr_mean_30d: null,
        rr_sd_30d: null,
        efficiency_pct: 120, // above 100
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.readinessScore({});

    // Clamped to 100
    expect(result[0]?.components.sleepScore).toBe(100);
  });

  it("clamps sleep efficiency score to min 0", async () => {
    const today = new Date();
    const recentDate = new Date(today);
    recentDate.setDate(today.getDate() - 5);
    const dateStr = recentDate.toISOString().split("T")[0];

    const rows = [
      {
        date: dateStr,
        hrv: null,
        resting_hr: null,
        respiratory_rate: null,
        hrv_mean_30d: null,
        hrv_sd_30d: null,
        rhr_mean_30d: null,
        rhr_sd_30d: null,
        rr_mean_30d: null,
        rr_sd_30d: null,
        efficiency_pct: -10, // below 0
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.readinessScore({});

    expect(result[0]?.components.sleepScore).toBe(0);
  });

  it("defaults to 62 for HRV score when only hrv is null (mean/sd present)", async () => {
    const today = new Date();
    const recentDate = new Date(today);
    recentDate.setDate(today.getDate() - 5);
    const dateStr = recentDate.toISOString().split("T")[0];

    const rows = [
      {
        date: dateStr,
        hrv: null, // null hrv but valid stats
        resting_hr: 45, // very low → high score when inverted
        respiratory_rate: 15,
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 85,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.readinessScore({});

    expect(result[0]?.components.hrvScore).toBe(62);
    // RHR should compute: z=(45-60)/5=-3, inverted=+3 → high score
    expect(result[0]?.components.restingHrScore).toBeGreaterThan(80);
  });

  it("defaults to 62 for HRV score when only hrv_mean_30d is null", async () => {
    const today = new Date();
    const recentDate = new Date(today);
    recentDate.setDate(today.getDate() - 5);
    const dateStr = recentDate.toISOString().split("T")[0];

    const rows = [
      {
        date: dateStr,
        hrv: 55,
        resting_hr: 60,
        respiratory_rate: 15,
        hrv_mean_30d: null, // null mean
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 85,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.readinessScore({});

    expect(result[0]?.components.hrvScore).toBe(62);
  });

  it("defaults to 62 for RHR score when only resting_hr is null", async () => {
    const today = new Date();
    const recentDate = new Date(today);
    recentDate.setDate(today.getDate() - 5);
    const dateStr = recentDate.toISOString().split("T")[0];

    const rows = [
      {
        date: dateStr,
        hrv: 80, // far above mean → high HRV score
        resting_hr: null, // null resting HR
        respiratory_rate: 15,
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 85,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.readinessScore({});

    expect(result[0]?.components.restingHrScore).toBe(62);
    // HRV: z=(80-50)/10=+3 → high score
    expect(result[0]?.components.hrvScore).toBeGreaterThan(80);
  });

  it("defaults to 62 for RHR score when only rhr_mean_30d is null", async () => {
    const today = new Date();
    const recentDate = new Date(today);
    recentDate.setDate(today.getDate() - 5);
    const dateStr = recentDate.toISOString().split("T")[0];

    const rows = [
      {
        date: dateStr,
        hrv: 55,
        resting_hr: 60,
        respiratory_rate: 15,
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: null, // null mean
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 85,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.readinessScore({});

    expect(result[0]?.components.restingHrScore).toBe(62);
  });

  it("defaults to 62 for respiratory score when only respiratory_rate is null", async () => {
    const today = new Date();
    const recentDate = new Date(today);
    recentDate.setDate(today.getDate() - 5);
    const dateStr = recentDate.toISOString().split("T")[0];

    const rows = [
      {
        date: dateStr,
        hrv: 80, // far above mean → high score
        resting_hr: 45, // far below mean → high score (inverted)
        respiratory_rate: null, // null respiratory rate
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 85,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.readinessScore({});

    expect(result[0]?.components.respiratoryRateScore).toBe(62);
    // HRV and RHR should compute to high scores
    expect(result[0]?.components.hrvScore).toBeGreaterThan(80);
    expect(result[0]?.components.restingHrScore).toBeGreaterThan(80);
  });

  it("high HRV (positive z-score) produces higher HRV score", async () => {
    const today = new Date();
    const recentDate = new Date(today);
    recentDate.setDate(today.getDate() - 5);
    const dateStr = recentDate.toISOString().split("T")[0];

    const rows = [
      {
        date: dateStr,
        hrv: 70, // significantly above mean of 50
        resting_hr: 60,
        respiratory_rate: 15,
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 85,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.readinessScore({});

    // z = (70-50)/10 = +2, zScoreToRecoveryScore(2) = 92
    expect(result[0]?.components.hrvScore).toBe(92);
  });

  it("low resting HR (negative z-score, inverted) produces higher RHR score", async () => {
    const today = new Date();
    const recentDate = new Date(today);
    recentDate.setDate(today.getDate() - 5);
    const dateStr = recentDate.toISOString().split("T")[0];

    const rows = [
      {
        date: dateStr,
        hrv: 50,
        resting_hr: 50, // below mean of 60 = good
        respiratory_rate: 15,
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 85,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.readinessScore({});

    // z_rhr = (50-60)/5 = -2, inverted: -(-2) = +2, should map to ~93
    expect(result[0]?.components.restingHrScore).toBeGreaterThan(80);
  });

  it("uses default days of 30", async () => {
    const sensorStore = makeSensorStore([]);
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore,
    });
    await caller.readinessScore({});
    expect(sensorStore.query).toHaveBeenCalled();
  });
});

// ── strainTarget ────────────────────────────────────────────────

describe("recoveryRouter.strainTarget", () => {
  // Sets up a strainTarget caller. PG mocks: readinessRows, then optional sleepRows.
  // CH mock: loads from analytics.strain_read_model.
  function setup({
    readinessRows = [],
    sleepRows,
    loads = [],
  }: {
    readinessRows?: unknown[];
    sleepRows?: Partial<SleepNightTestRow>[];
    loads?: unknown[];
  }) {
    const executeMock = vi.fn();
    executeMock.mockResolvedValueOnce(readinessRows);
    const sensorRows =
      readinessRows.length > 0
        ? [[], loads, (sleepRows ?? []).map((row) => sleepNightRow(row))]
        : [[], loads];
    return createCaller({
      db: { execute: executeMock },
      userId: "user-1",
      sensorStore: makeSensorStore(sensorRows),
    });
  }

  it("returns default values when no metric rows exist", async () => {
    const caller = setup({});
    const result = await caller.strainTarget({});

    expect(result.zone).toBe("Maintain");
    expect(result.targetStrain).toBeGreaterThanOrEqual(10);
    expect(result.targetStrain).toBeLessThanOrEqual(14);
    expect(result.currentStrain).toBe(0);
    expect(result.progressPercent).toBe(0);
    expect(result.explanation).toBeTruthy();
  });

  it("reads daily loads from the compact activity load read model", async () => {
    const executeMock = vi.fn().mockResolvedValueOnce([]);
    const sensorStore = makeSensorStore([[], []]);
    const caller = createCaller({
      db: { execute: executeMock },
      userId: "user-1",
      sensorStore,
    });

    await caller.strainTarget({ endDate: "2026-03-28" });

    const queryText = vi.mocked(sensorStore.query).mock.calls[1]?.[1];
    expect(queryText).toContain("analytics.strain_read_model FINAL");
    expect(queryText).not.toContain("analytics.activity_summary");
  });

  it("computes readiness from daily metrics and returns strain target", async () => {
    const caller = setup({
      readinessRows: [
        {
          date: "2026-03-22",
          resting_hr: 55,
          hrv: 60,
          spo2_avg: 98,
          respiratory_rate_avg: 14,
        },
      ],
      sleepRows: [{ efficiency_pct: 90 }],
    });
    const result = await caller.strainTarget({});

    expect(typeof result.targetStrain).toBe("number");
    expect(typeof result.currentStrain).toBe("number");
    expect(typeof result.progressPercent).toBe("number");
    expect(["Push", "Maintain", "Recovery"]).toContain(result.zone);
  });

  it("returns zero current strain when today has no activity load", async () => {
    const today = "2026-03-23";
    const caller = setup({
      loads: [
        { date: "2026-03-22", daily_load: 100 },
        { date: today, daily_load: 0 },
      ],
    });
    const result = await caller.strainTarget({ endDate: today });

    expect(result.currentStrain).toBe(0);
    expect(result.currentStrainSource).toBe("none");
    expect(result.currentPhysiologyLoad).toBeNull();
  });

  it("does not count earlier acute-window load as today's current strain", async () => {
    const today = "2026-03-23";
    const caller = setup({
      loads: [
        { date: "2026-03-17", daily_load: 180 },
        { date: "2026-03-18", daily_load: 170 },
        { date: "2026-03-19", daily_load: 160 },
        { date: "2026-03-20", daily_load: 150 },
        { date: "2026-03-21", daily_load: 140 },
        { date: "2026-03-22", daily_load: 130 },
        { date: today, daily_load: 0 },
      ],
    });
    const result = await caller.strainTarget({ endDate: today });

    expect(result.currentStrain).toBe(0);
    expect(result.progressPercent).toBe(0);
    expect(result.dailyLoad).toBe(0);
    expect(result.acuteLoad).toBeCloseTo(930 / 7, 1);
    expect(result.chronicLoad).toBeCloseTo(930 / 28, 1);
    expect(result.workloadRatio).toBe(4);
    expect(result.readinessScore).toBe(50);
  });

  it("computes progressPercent as ratio of current to target", async () => {
    const today = "2026-03-23";
    const caller = setup({
      loads: [{ date: today, daily_load: 50 }],
    });
    const result = await caller.strainTarget({ endDate: today });

    expect(result.progressPercent).toBeGreaterThan(0);
    const expectedPercent = Math.round((result.currentStrain / result.targetStrain) * 100);
    expect(result.progressPercent).toBe(expectedPercent);
  });

  it("computes current strain from activity load instead of provider strain", async () => {
    const today = "2026-03-23";
    const caller = setup({
      loads: [{ date: today, daily_load: 39.9, whoop_strain: 2 }],
    });
    const result = await caller.strainTarget({ endDate: today });

    expect(result.currentStrain).toBe(10.3);
    expect(result.currentStrainSource).toBe("activity");
    expect(result.progressPercent).toBe(Math.round((10.3 / result.targetStrain) * 100));
  });

  it("returns 0 progressPercent when targetStrain is 0", async () => {
    const caller = setup({});
    const result = await caller.strainTarget({});

    if (result.targetStrain > 0) {
      expect(result.progressPercent).toBe(
        Math.round((result.currentStrain / result.targetStrain) * 100),
      );
    } else {
      expect(result.progressPercent).toBe(0);
    }
  });

  it("uses readiness metrics with null sleep efficiency", async () => {
    const caller = setup({
      readinessRows: [
        {
          date: "2026-03-22",
          resting_hr: 55,
          hrv: 80,
          spo2_avg: null,
          respiratory_rate_avg: null,
        },
      ],
      sleepRows: [],
    });
    const result = await caller.strainTarget({});

    expect(typeof result.targetStrain).toBe("number");
  });

  it("handles null resting_hr in readiness metrics", async () => {
    const caller = setup({
      readinessRows: [
        {
          date: "2026-03-22",
          resting_hr: null,
          hrv: 60,
          spo2_avg: null,
          respiratory_rate_avg: null,
        },
      ],
      sleepRows: [],
    });
    const result = await caller.strainTarget({});

    expect(typeof result.targetStrain).toBe("number");
  });

  it("handles null hrv in readiness metrics", async () => {
    const caller = setup({
      readinessRows: [
        {
          date: "2026-03-22",
          resting_hr: 55,
          hrv: null,
          spo2_avg: null,
          respiratory_rate_avg: null,
        },
      ],
      sleepRows: [],
    });
    const result = await caller.strainTarget({});

    expect(typeof result.targetStrain).toBe("number");
  });

  it("accumulates acute and chronic loads from date window", async () => {
    const today = "2026-03-23";
    const yesterday = "2026-03-22";
    const twoDaysAgo = "2026-03-21";
    const caller = setup({
      loads: [
        { date: twoDaysAgo, daily_load: 100 },
        { date: yesterday, daily_load: 150 },
        { date: today, daily_load: 80 },
      ],
    });
    const result = await caller.strainTarget({ endDate: today });

    expect(result.targetStrain).toBeGreaterThan(0);
  });

  it("rounds currentStrain to 1 decimal place", async () => {
    const today = "2026-03-23";
    const caller = setup({ loads: [{ date: today, daily_load: 75.3 }] });
    const result = await caller.strainTarget({ endDate: today });

    const decimals = result.currentStrain.toString().split(".")[1];
    expect(!decimals || decimals.length <= 1).toBe(true);
  });

  it("clamps hrvScore to 0-100 range in strainTarget readiness components", async () => {
    const caller = setup({
      readinessRows: [
        {
          date: "2026-03-22",
          resting_hr: 55,
          hrv: 150,
          spo2_avg: null,
          respiratory_rate_avg: null,
        },
      ],
      sleepRows: [],
    });
    const result = await caller.strainTarget({});

    expect(["Push", "Maintain", "Recovery"]).toContain(result.zone);
    expect(result.targetStrain).toBeGreaterThan(0);
  });

  it("clamps restingHrScore using 120 - resting_hr formula", async () => {
    const caller = setup({
      readinessRows: [
        {
          date: "2026-03-22",
          resting_hr: 55,
          hrv: null,
          spo2_avg: null,
          respiratory_rate_avg: null,
        },
      ],
      sleepRows: [],
    });
    const result = await caller.strainTarget({});

    expect(result.targetStrain).toBeGreaterThan(0);
  });

  it("does not include loads from days outside the acute window", async () => {
    const today = "2026-03-23";
    const tenDaysAgo = "2026-03-13";
    const caller = setup({ loads: [{ date: tenDaysAgo, daily_load: 500 }] });
    const result = await caller.strainTarget({ endDate: today });

    expect(result.currentStrain).toBe(0);
  });

  it("uses sleep efficiency for sleepScore in strainTarget when available", async () => {
    const readinessRows = [
      {
        date: "2026-03-22",
        resting_hr: 55,
        hrv: 60,
        spo2_avg: null,
        respiratory_rate_avg: null,
      },
    ];
    const callerHigh = setup({ readinessRows, sleepRows: [{ efficiency_pct: 95 }] });
    const resultHigh = await callerHigh.strainTarget({});

    const callerLow = setup({ readinessRows, sleepRows: [{ efficiency_pct: 40 }] });
    const resultLow = await callerLow.strainTarget({});

    expect(resultHigh.targetStrain).toBeGreaterThanOrEqual(resultLow.targetStrain);
  });

  it("computes progressPercent as 0 when targetStrain is 0", async () => {
    const today = new Date().toISOString().split("T")[0] ?? "";
    const caller = setup({});
    const result = await caller.strainTarget({ endDate: today });

    expect(result.progressPercent).toBe(0);
  });

  it("averages acute load over 7-day window", async () => {
    const today = "2026-03-28";
    const loads = Array.from({ length: 7 }, (_, index) => {
      const date = new Date("2026-03-22");
      date.setDate(date.getDate() + index);
      return { date: date.toISOString().split("T")[0], daily_load: 100 };
    });
    const caller = setup({ loads });
    const result = await caller.strainTarget({ endDate: today });

    expect(result.targetStrain).toBeGreaterThan(0);
  });

  it("separates acute from chronic loads by day window", async () => {
    const today = "2026-03-28";
    const loads = Array.from({ length: 20 }, (_, index) => {
      const date = new Date("2026-03-01");
      date.setDate(date.getDate() + index);
      return { date: date.toISOString().split("T")[0], daily_load: 200 };
    });
    const caller = setup({ loads });
    const result = await caller.strainTarget({ endDate: today });

    expect(result.targetStrain).toBeGreaterThan(0);
    expect(result.currentStrain).toBe(0);
  });

  it("excludes loads at exactly 7 days ago from acute window", async () => {
    const today = "2026-03-28";
    const caller = setup({
      loads: [
        { date: "2026-03-21", daily_load: 1000 },
        { date: "2026-03-22", daily_load: 70 },
      ],
    });
    const result = await caller.strainTarget({ endDate: today });

    expect(result.targetStrain).toBeGreaterThan(0);
    expect(result.currentStrain).toBe(0);
  });

  it("progressPercent reflects currentStrain relative to targetStrain", async () => {
    const today = "2026-03-28";
    const caller = setup({
      loads: [
        { date: today, daily_load: 100 },
        { date: "2026-03-27", daily_load: 100 },
        { date: "2026-03-26", daily_load: 100 },
      ],
    });
    const result = await caller.strainTarget({ endDate: today });

    expect(result.currentStrain).toBeGreaterThan(0);
    expect(result.progressPercent).toBeGreaterThan(0);
    expect(result.progressPercent).toBeLessThanOrEqual(200);
  });

  it("computes currentStrain from acute load when today has load", async () => {
    const today = "2026-03-28";
    const caller = setup({ loads: [{ date: today, daily_load: 150 }] });
    const result = await caller.strainTarget({ endDate: today });

    expect(result.currentStrain).toBeGreaterThan(0);
  });

  it("acuteLoad excludes loads at exactly 7 days ago (kills < vs <= mutation)", async () => {
    const today = "2026-03-28";
    const caller = setup({
      loads: [
        { date: "2026-03-24", daily_load: 100 },
        { date: "2026-03-21", daily_load: 500 },
      ],
    });
    const result = await caller.strainTarget({ endDate: today });
    expect(result.acuteLoad).toBeCloseTo(100 / 7, 1);
  });

  it("chronicLoad excludes loads at exactly 28 days ago (kills < vs <= mutation)", async () => {
    const today = "2026-04-15";
    const caller = setup({
      loads: [
        { date: "2026-04-14", daily_load: 100 },
        { date: "2026-03-18", daily_load: 200 },
      ],
    });
    const result = await caller.strainTarget({ endDate: today });
    expect(result.chronicLoad).toBeCloseTo(100 / 28, 1);
  });

  it("acuteLoad excludes loads outside acute window (kills condition->true mutation)", async () => {
    const today = "2026-04-01";
    const caller = setup({
      loads: [
        { date: "2026-04-01", daily_load: 100 },
        { date: "2026-03-10", daily_load: 999 },
      ],
    });
    const result = await caller.strainTarget({ endDate: today });
    expect(result.acuteLoad).toBeCloseTo(100 / 7, 1);
  });

  it("chronicLoad excludes loads outside chronic window (kills condition->true mutation)", async () => {
    const today = "2026-05-01";
    const caller = setup({
      loads: [
        { date: "2026-05-01", daily_load: 100 },
        { date: "2026-03-01", daily_load: 999 },
      ],
    });
    const result = await caller.strainTarget({ endDate: today });
    expect(result.chronicLoad).toBeCloseTo(100 / 28, 1);
  });

  it("workloadRatio is null when chronicLoad is 0 (kills >0 -> true mutation)", async () => {
    const today = "2026-03-28";
    const caller = setup({ loads: [] });
    const result = await caller.strainTarget({ endDate: today });
    expect(result.workloadRatio).toBeNull();
  });

  it("dailyLoad rounds correctly (kills *10 -> /10 and /10 -> *10 mutation)", async () => {
    const today = "2026-03-28";
    const caller = setup({
      loads: [{ date: today, daily_load: 123.456 }],
    });
    const result = await caller.strainTarget({ endDate: today });
    expect(result.dailyLoad).toBe(123.5);
  });
});

// ── Mutation-killing tests for sleepConsistency ────────────────

describe("recoveryRouter.sleepConsistency - mutation killers", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01"));
  });
  afterAll(() => {
    vi.useRealTimers();
  });
  it("window_count exactly 7 produces non-null consistencyScore", async () => {
    const rows = Array.from({ length: 7 }, (_, index) =>
      sleepScheduleRow(`2026-03-${String(index + 1).padStart(2, "0")}`, 22, 7),
    );
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepConsistency({});
    expect(result.at(-1)?.consistencyScore).not.toBeNull();
    expect(result.at(-1)?.consistencyScore).toBeTypeOf("number");
  });

  it("window_count 6 produces null consistencyScore (boundary)", async () => {
    const rows = Array.from({ length: 6 }, (_, index) =>
      sleepScheduleRow(`2026-03-${String(index + 1).padStart(2, "0")}`, 22, 7),
    );
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepConsistency({});
    expect(result.at(-1)?.consistencyScore).toBeNull();
  });

  it("bedtimeHour rounds correctly (kills *10/10 vs *100/100 mutation)", async () => {
    // 22.567 * 100 / 100 = 22.57 (correct, 2 decimals)
    // 22.567 * 10 / 10 = 22.6 (wrong, 1 decimal)
    const rows = [sleepScheduleRow("2026-03-01", 22.567, 6)];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepConsistency({});
    expect(result[0]?.bedtimeHour).toBe(22.57);
  });

  it("waketimeHour rounds to 2 decimals not 1", async () => {
    const rows = [sleepScheduleRow("2026-03-01", 22, 6.789)];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepConsistency({});
    expect(result[0]?.waketimeHour).toBe(6.78);
  });

  it("rollingBedtimeStddev rounds to 2 decimals", async () => {
    const rows = [sleepScheduleRow("2026-03-01", 22, 7), sleepScheduleRow("2026-03-02", 19.088, 7)];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepConsistency({});
    expect(result.at(-1)?.rollingBedtimeStddev).toBe(1.46);
  });

  it("rollingWaketimeStddev rounds to 2 decimals", async () => {
    const rows = [sleepScheduleRow("2026-03-01", 22, 7), sleepScheduleRow("2026-03-02", 22, 8.59)];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepConsistency({});
    expect(result.at(-1)?.rollingWaketimeStddev).toBe(0.79);
  });

  it("only null bedtime stddev produces null rollingBedtimeStddev", async () => {
    const rows = [sleepScheduleRow("2026-03-01", 22, 7)];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepConsistency({});
    // 0 is a valid value, not null
    expect(result[0]?.rollingBedtimeStddev).toBe(0);
  });

  it("includes row exactly on cutoffDate boundary (kills > vs >= mutation)", async () => {
    const rows = [sleepScheduleRow("2026-01-31", 22, 7)];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepConsistency({});
    expect(result).toHaveLength(1);
    expect(result[0]?.rollingBedtimeStddev).toBe(0);
  });
});

// ── Mutation-killing tests for hrvVariability ──────────────────

describe("recoveryRouter.hrvVariability - mutation killers", () => {
  it("hrv rounds to 1 decimal (kills *100/100 mutation)", async () => {
    // 52.67 * 10 / 10 = 52.7 (correct)
    // 52.67 * 100 / 100 = 52.67 (wrong for 1 decimal)
    const rows = [
      {
        date: "2026-03-01",
        hrv: 52.67,
        rolling_mean: null,
        rolling_cv: null,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
      sensorStore: makeSensorStore([]),
    });
    const result = await caller.hrvVariability({});
    expect(result[0]?.hrv).toBe(52.7);
  });

  it("rollingMean rounds to 1 decimal", async () => {
    const rows = [
      {
        date: "2026-03-01",
        hrv: 50,
        rolling_mean: 48.345,
        rolling_cv: null,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
      sensorStore: makeSensorStore([]),
    });
    const result = await caller.hrvVariability({});
    expect(result[0]?.rollingMean).toBeCloseTo(48.3, 1);
  });

  it("rollingCoefficientOfVariation rounds to 2 decimals", async () => {
    const rows = [
      {
        date: "2026-03-01",
        hrv: 50,
        rolling_mean: 48,
        rolling_cv: 12.567,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
      sensorStore: makeSensorStore([]),
    });
    const result = await caller.hrvVariability({});
    expect(result[0]?.rollingCoefficientOfVariation).toBe(12.57);
  });

  it("zero hrv is preserved (not treated as null)", async () => {
    const rows = [
      {
        date: "2026-03-01",
        hrv: 0,
        rolling_mean: 48,
        rolling_cv: 12,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
      sensorStore: makeSensorStore([]),
    });
    const result = await caller.hrvVariability({});
    expect(result[0]?.hrv).toBe(0);
  });

  it("zero rolling_mean is preserved (not treated as null)", async () => {
    const rows = [
      {
        date: "2026-03-01",
        hrv: 50,
        rolling_mean: 0,
        rolling_cv: null,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
      sensorStore: makeSensorStore([]),
    });
    const result = await caller.hrvVariability({});
    expect(result[0]?.rollingMean).toBe(0);
  });

  it("date is passed through unmodified", async () => {
    const rows = [
      {
        date: "2026-03-15",
        hrv: 50,
        rolling_mean: null,
        rolling_cv: null,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
      sensorStore: makeSensorStore([]),
    });
    const result = await caller.hrvVariability({});
    expect(result[0]?.date).toBe("2026-03-15");
  });
});

// ── Mutation-killing tests for workloadRatio ───────────────────

describe("recoveryRouter.workloadRatio - mutation killers", () => {
  function callerWith(rows: unknown[]) {
    return createCaller({
      db: { execute: vi.fn() },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
  }

  it("dailyLoad rounds to 1 decimal (not 2)", async () => {
    const result = await callerWith([
      {
        date: "2026-03-01",
        daily_load: 125.678,
        acute_load: 500,
        chronic_load: 400,
        workload_ratio: null,
      },
    ]).workloadRatio({});
    expect(result.timeSeries[0]?.dailyLoad).toBe(125.7);
  });

  it("acuteLoad rounds to 1 decimal", async () => {
    const result = await callerWith([
      {
        date: "2026-03-01",
        daily_load: 100,
        acute_load: 500.345,
        chronic_load: 400,
        workload_ratio: null,
      },
    ]).workloadRatio({});
    expect(result.timeSeries[0]?.acuteLoad).toBeCloseTo(500.3, 1);
  });

  it("chronicLoad rounds to 1 decimal", async () => {
    const result = await callerWith([
      {
        date: "2026-03-01",
        daily_load: 100,
        acute_load: 500,
        chronic_load: 400.789,
        workload_ratio: null,
      },
    ]).workloadRatio({});
    expect(result.timeSeries[0]?.chronicLoad).toBe(400.8);
  });

  it("workloadRatio rounds to 2 decimals", async () => {
    const result = await callerWith([
      {
        date: "2026-03-01",
        daily_load: 100,
        acute_load: 500,
        chronic_load: 400,
        workload_ratio: 1.2567,
      },
    ]).workloadRatio({});
    expect(result.timeSeries[0]?.workloadRatio).toBe(1.26);
  });

  it("date is passed through to each timeSeries entry", async () => {
    const result = await callerWith([
      {
        date: "2026-03-15",
        daily_load: 50,
        acute_load: 200,
        chronic_load: 300,
        workload_ratio: 0.67,
      },
    ]).workloadRatio({});
    expect(result.timeSeries[0]?.date).toBe("2026-03-15");
  });

  it("strain is derived from rounded dailyLoad", async () => {
    const result = await callerWith([
      {
        date: "2026-03-01",
        daily_load: 50,
        acute_load: 500,
        chronic_load: 400,
        workload_ratio: 1.25,
      },
    ]).workloadRatio({});
    expect(result.timeSeries[0]?.strain).toBe(10.9);
  });

  it("computes strain from activity load instead of provider strain", async () => {
    const result = await callerWith([
      {
        date: "2026-03-01",
        daily_load: 39.9,
        acute_load: 500,
        chronic_load: 400,
        workload_ratio: 1.25,
        whoop_strain: 2,
      },
    ]).workloadRatio({});

    expect(result.timeSeries[0]?.strain).toBe(10.3);
    expect(result.displayedStrain).toBe(10.3);
  });

  it("displayedStrain defaults to 0 when timeSeries is empty", async () => {
    const result = await callerWith([]).workloadRatio({});
    expect(result.displayedStrain).toBe(0);
  });

  it("displayedDate defaults to null when timeSeries is empty", async () => {
    const result = await callerWith([]).workloadRatio({});
    expect(result.displayedDate).toBeNull();
  });
});

// ── Mutation-killing tests for sleepAnalytics ──────────────────

describe("recoveryRouter.sleepAnalytics - mutation killers", () => {
  it("deepPct rounds to 1 decimal", async () => {
    const rows = [
      sleepAnalyticsRow({
        date: "2026-03-01",
        durationMinutes: 480,
        deepPct: 18.567,
        remPct: 22,
        lightPct: 50,
        awakePct: 9,
        efficiency: 90,
      }),
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepAnalytics({});
    expect(result.nightly[0]?.deepPct).toBe(18.6);
  });

  it("remPct rounds to 1 decimal", async () => {
    const rows = [
      sleepAnalyticsRow({
        date: "2026-03-01",
        durationMinutes: 480,
        deepPct: 20,
        remPct: 22.345,
        lightPct: 50,
        awakePct: 8,
        efficiency: 90,
      }),
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepAnalytics({});
    expect(result.nightly[0]?.remPct).toBeCloseTo(22.3, 1);
  });

  it("lightPct rounds to 1 decimal", async () => {
    const rows = [
      sleepAnalyticsRow({
        date: "2026-03-01",
        durationMinutes: 480,
        deepPct: 20,
        remPct: 22,
        lightPct: 50.789,
        awakePct: 7,
        efficiency: 90,
      }),
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepAnalytics({});
    expect(result.nightly[0]?.lightPct).toBe(50.8);
  });

  it("awakePct rounds to 1 decimal", async () => {
    const rows = [
      sleepAnalyticsRow({
        date: "2026-03-01",
        durationMinutes: 480,
        deepPct: 20,
        remPct: 22,
        lightPct: 50,
        awakePct: 8.965,
        efficiency: 90,
      }),
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepAnalytics({});
    expect(result.nightly[0]?.awakePct).toBe(9);
  });

  it("efficiency rounds to 1 decimal", async () => {
    const rows = [sleepNightRow({ date: "2026-03-01", efficiency_pct: 93.456 })];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepAnalytics({});
    expect(result.nightly[0]?.efficiency).toBeCloseTo(93.5, 1);
  });

  it("rollingAvgDuration rounds to 1 decimal", async () => {
    const rows = [sleepDebtRow("2026-03-01", 455.789, 480)];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepAnalytics({});
    expect(result.nightly[0]?.rollingAvgDuration).toBe(455.8);
  });

  it("durationMinutes preserves the numeric value", async () => {
    const rows = [sleepDebtRow("2026-03-01", 450, 480)];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepAnalytics({});
    expect(result.nightly[0]?.durationMinutes).toBe(480);
  });

  it("sleepMinutes preserves the numeric value", async () => {
    const rows = [sleepDebtRow("2026-03-01", 450, 480)];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepAnalytics({});
    expect(result.nightly[0]?.sleepMinutes).toBe(450);
  });

  it("sleep debt is rounded to integer", async () => {
    // 14 nights at 470 min → deficit = (480 - 470) * 14 = 140
    const rows = Array.from({ length: 14 }, (_, index) =>
      sleepDebtRow(`2026-03-${String(index + 1).padStart(2, "0")}`, 470),
    );

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepAnalytics({});
    expect(result.sleepDebt).toBe(140);
    expect(Number.isInteger(result.sleepDebt)).toBe(true);
  });

  it("date is passed through to nightly entries", async () => {
    const rows = [sleepDebtRow("2026-03-15", 450, 480)];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepAnalytics({});
    expect(result.nightly[0]?.date).toBe("2026-03-15");
  });

  it("sleepDebt uses sleepMinutes not durationMinutes", async () => {
    // durationMinutes = 500 (would produce surplus of -280 over 14 nights)
    // sleepMinutes = 400 (produces debt of 80*14 = 1120)
    const rows = Array.from({ length: 14 }, (_, index) =>
      sleepDebtRow(`2026-03-${String(index + 1).padStart(2, "0")}`, 400, 500),
    );

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepAnalytics({});
    // 480 - 400 = 80 per night * 14 = 1120
    expect(result.sleepDebt).toBe(1120);
  });
});

// ── Mutation-killing tests for readinessScore ──────────────────

describe("recoveryRouter.readinessScore - mutation killers", () => {
  function recentDateStr(daysAgo: number): string {
    const today = new Date();
    const date = new Date(today);
    date.setDate(today.getDate() - daysAgo);
    return date.toISOString().split("T")[0] ?? "";
  }

  it("low HRV (negative z-score) produces lower HRV score", async () => {
    const dateStr = recentDateStr(5);
    const rows = [
      {
        date: dateStr,
        hrv: 30, // significantly below mean of 50
        resting_hr: 60,
        respiratory_rate: 15,
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 85,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.readinessScore({});
    // z = (30-50)/10 = -2, should map to low score
    expect(result[0]?.components.hrvScore).toBeLessThan(50);
  });

  it("high resting HR produces lower RHR score (inverted z)", async () => {
    const dateStr = recentDateStr(5);
    const rows = [
      {
        date: dateStr,
        hrv: 50,
        resting_hr: 70, // above mean of 60 = bad
        respiratory_rate: 15,
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 85,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.readinessScore({});
    // z_rhr = (70-60)/5 = +2, inverted: -2, should map to low score
    expect(result[0]?.components.restingHrScore).toBeLessThan(50);
  });

  it("low respiratory rate produces higher respiratory rate score", async () => {
    const dateStr = recentDateStr(5);
    const rows = [
      {
        date: dateStr,
        hrv: 50,
        resting_hr: 60,
        respiratory_rate: 13, // below mean of 15 = good
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 85,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.readinessScore({});
    // z_rr = (13-15)/1 = -2, inverted: +2, maps to high score
    expect(result[0]?.components.respiratoryRateScore).toBeGreaterThan(80);
  });

  it("high respiratory rate produces lower respiratory rate score", async () => {
    const dateStr = recentDateStr(5);
    const rows = [
      {
        date: dateStr,
        hrv: 50,
        resting_hr: 60,
        respiratory_rate: 17, // above mean of 15 = bad
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 85,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.readinessScore({});
    // z_rr = (17-15)/1 = +2, inverted: -2, maps to low score
    expect(result[0]?.components.respiratoryRateScore).toBeLessThan(50);
  });

  it("sleep efficiency maps directly to sleepScore (clamped 0-100)", async () => {
    const dateStr = recentDateStr(5);
    const rows = [
      {
        date: dateStr,
        hrv: null,
        resting_hr: null,
        respiratory_rate: null,
        hrv_mean_30d: null,
        hrv_sd_30d: null,
        rhr_mean_30d: null,
        rhr_sd_30d: null,
        rr_mean_30d: null,
        rr_sd_30d: null,
        efficiency_pct: 85,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.readinessScore({});
    expect(result[0]?.components.sleepScore).toBe(85);
  });

  it("readinessScore is a weighted sum of components", async () => {
    const dateStr = recentDateStr(5);
    const rows = [
      {
        date: dateStr,
        hrv: null,
        resting_hr: null,
        respiratory_rate: null,
        hrv_mean_30d: null,
        hrv_sd_30d: null,
        rhr_mean_30d: null,
        rhr_sd_30d: null,
        rr_mean_30d: null,
        rr_sd_30d: null,
        efficiency_pct: null,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.readinessScore({});
    // All defaults: 62 * 0.5 + 62 * 0.2 + 62 * 0.15 + 62 * 0.15 = 62
    expect(result[0]?.readinessScore).toBe(62);
  });

  it("defaults to 62 for hrv score when hrv is null", async () => {
    const dateStr = recentDateStr(5);
    const rows = [
      {
        date: dateStr,
        hrv: null,
        resting_hr: 60,
        respiratory_rate: 15,
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 85,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.readinessScore({});
    expect(result[0]?.components.hrvScore).toBe(62);
  });

  it("defaults to 62 for rhr score when resting_hr is null", async () => {
    const dateStr = recentDateStr(5);
    const rows = [
      {
        date: dateStr,
        hrv: 50,
        resting_hr: null,
        respiratory_rate: 15,
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 85,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.readinessScore({});
    expect(result[0]?.components.restingHrScore).toBe(62);
  });

  it("defaults to 62 for respiratory score when respiratory_rate is null", async () => {
    const dateStr = recentDateStr(5);
    const rows = [
      {
        date: dateStr,
        hrv: 50,
        resting_hr: 60,
        respiratory_rate: null,
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: null,
        rr_sd_30d: null,
        efficiency_pct: 85,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.readinessScore({});
    expect(result[0]?.components.respiratoryRateScore).toBe(62);
  });

  it("hrvScore is rounded to integer", async () => {
    const dateStr = recentDateStr(5);
    const rows = [
      {
        date: dateStr,
        hrv: 55,
        resting_hr: 60,
        respiratory_rate: 15,
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 85,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.readinessScore({});
    expect(Number.isInteger(result[0]?.components.hrvScore)).toBe(true);
    expect(Number.isInteger(result[0]?.components.restingHrScore)).toBe(true);
    expect(Number.isInteger(result[0]?.components.respiratoryRateScore)).toBe(true);
  });

  it("date is preserved in readiness output", async () => {
    const dateStr = recentDateStr(5);
    const rows = [
      {
        date: dateStr,
        hrv: null,
        resting_hr: null,
        respiratory_rate: null,
        hrv_mean_30d: null,
        hrv_sd_30d: null,
        rhr_mean_30d: null,
        rhr_sd_30d: null,
        rr_mean_30d: null,
        rr_sd_30d: null,
        efficiency_pct: null,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.readinessScore({});
    expect(result[0]?.date).toBe(dateStr);
  });
});

describe("recoveryRouter access window gating", () => {
  it("sleepConsistency passes accessWindow to query (limited window returns empty)", async () => {
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
      sensorStore: makeSensorStore([]),
    });
    const result = await caller.sleepConsistency({});
    expect(result).toEqual([]);
  });

  it("readinessScore passes accessWindow to query", async () => {
    const sensorStore = makeSensorStore([]);
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      timezone: "UTC",
      accessWindow: {
        kind: "limited",
        paid: false,
        reason: "free_signup_week",
        startDate: "2026-04-10",
        endDateExclusive: "2026-04-17",
      },
      sensorStore,
    });
    const result = await caller.readinessScore({ days: 30, endDate: "2026-04-20" });
    expect(result).toEqual([]);
    const queryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
    const queryParams = vi.mocked(sensorStore.query).mock.calls[0]?.[2];
    expect(queryText).toContain("accessStartDate");
    expect(queryText).toContain("accessEndDateExclusive");
    expect(queryParams).toMatchObject({
      accessStartDate: "2026-04-10",
      accessEndDateExclusive: "2026-04-17",
    });
  });
});
