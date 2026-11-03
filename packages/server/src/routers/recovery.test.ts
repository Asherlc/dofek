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
        for (const batch of rows) {
          fn.mockResolvedValueOnce(batch);
        }
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
  source_name?: string | null;
  source_providers?: string[];
  selected_session_id?: string | null;
  overlapping_sessions?: {
    session_id: string;
    provider_id: string;
    source_name: string | null;
    source_providers: string[];
    timezone: string | null;
    start_utc_offset_minutes: number | null;
    end_utc_offset_minutes: number | null;
    local_time_source: SleepNightTestRow["local_time_source"];
    started_at: string;
    ended_at: string | null;
    duration_minutes: number | null;
  }[];
  timezone: string | null;
  start_utc_offset_minutes: number | null;
  end_utc_offset_minutes: number | null;
  local_time_source:
    | "provider_timezone"
    | "provider_offset"
    | "device_timezone"
    | "device_offset"
    | "unknown";
  started_at: string;
  ended_at: string | null;
  duration_minutes: number | null;
  deep_minutes: number | null;
  rem_minutes: number | null;
  light_minutes: number | null;
  awake_minutes: number | null;
  efficiency_pct: number | null;
  staging_available: boolean;
};

function sleepNightRow(overrides: Partial<SleepNightTestRow> = {}): SleepNightTestRow {
  const date = overrides.date ?? "2026-03-01";
  return {
    date,
    provider_id: "apple_health",
    source_name: null,
    source_providers: [],
    selected_session_id: null,
    overlapping_sessions: [],
    timezone: null,
    start_utc_offset_minutes: 0,
    end_utc_offset_minutes: 0,
    local_time_source: "device_offset",
    started_at: `${date}T22:00:00Z`,
    ended_at: `${addDays(date, 1)}T06:00:00Z`,
    duration_minutes: 480,
    deep_minutes: 90,
    rem_minutes: 105,
    light_minutes: 255,
    awake_minutes: 30,
    efficiency_pct: 93.75,
    staging_available: true,
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
    deep_minutes: 0,
    rem_minutes: 0,
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
      timezone: "America/Los_Angeles",
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

  it("omits schedule rows when the record local time is unknown", async () => {
    const rows = [
      sleepNightRow({
        timezone: null,
        start_utc_offset_minutes: null,
        end_utc_offset_minutes: null,
        local_time_source: "unknown",
      }),
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      timezone: "America/Los_Angeles",
      sensorStore: makeSensorStore(rows),
    });

    await expect(caller.sleepConsistency({})).resolves.toEqual([]);
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
  it("displayedDate reflects the latest workload row", async () => {
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
  });

  it("returns empty timeSeries and zero strain when no data", async () => {
    const sensorStore = makeSensorStore([]);
    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-1",
      sensorStore,
    });
    const result = await caller.workloadRatio({});

    expect(result.timeSeries).toEqual([]);
    expect(result.displayedDate).toBeNull();
    const queryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
    expect(queryText).toContain("analytics.daily_strain AS strain FINAL");
    expect(queryText).toContain("strain.is_deleted = 0");
    expect(queryText).toContain("toDate(toTimeZone(toDateTime(strain.date), {timezone:String}))");
    expect(queryText).not.toContain("analytics.activity_summary");
    expect(vi.mocked(sensorStore.query).mock.calls[0]?.[3]).toEqual({ priority: "dashboard" });
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

  it("passes limited access windows to workload ratio strain queries", async () => {
    const sensorStore = makeSensorStore([]);
    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-1",
      timezone: "UTC",
      accessWindow: {
        kind: "limited",
        startDate: "2026-03-10",
        endDateExclusive: "2026-03-20",
      },
      sensorStore,
    });

    await caller.workloadRatio({ endDate: "2026-03-28" });

    const queryText = String(vi.mocked(sensorStore.query).mock.calls[0]?.[1]);
    const queryParams = vi.mocked(sensorStore.query).mock.calls[0]?.[2];
    expect(queryText).toContain("strain.date >= toDate({accessStartDate:String})");
    expect(queryText).toContain("strain.date < toDate({accessEndDateExclusive:String})");
    expect(queryParams).toMatchObject({
      accessStartDate: "2026-03-10",
      accessEndDateExclusive: "2026-03-20",
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
});

// ── sleepAnalytics ──────────────────────────────────────────────

describe("recoveryRouter.sleepAnalytics", () => {
  it("returns unavailable summary metrics when no sleep data exists", async () => {
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore([]),
    });
    const result = await caller.sleepAnalytics({});

    expect(result.nightly).toEqual([]);
    expect(result.averageSleepMinutes).toBeNull();
    expect(result.averageEfficiencyPercent).toBeNull();
  });

  it("preserves missing sleep values while keeping measured zeroes available", async () => {
    const rows = [
      sleepNightRow({
        date: "2026-03-01",
        duration_minutes: null,
        deep_minutes: null,
        rem_minutes: null,
        light_minutes: null,
        awake_minutes: null,
        efficiency_pct: null,
        staging_available: false,
      }),
      sleepNightRow({
        date: "2026-03-02",
        provider_id: "whoop",
        duration_minutes: 0,
        deep_minutes: 0,
        rem_minutes: 0,
        light_minutes: 0,
        awake_minutes: 0,
        efficiency_pct: 0,
        staging_available: true,
      }),
      sleepNightRow({
        date: "2026-03-03",
        duration_minutes: 480,
        deep_minutes: null,
        rem_minutes: null,
        light_minutes: null,
        awake_minutes: null,
        efficiency_pct: null,
        staging_available: true,
      }),
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepAnalytics({});

    expect(result.nightly[0]).toMatchObject({
      durationMinutes: null,
      sleepMinutes: null,
      rollingAvgDuration: null,
      durationState: {
        status: "missing",
        reason: "Sleep duration was not recorded.",
        nextAction: "Sync sleep data from a source that reports sleep duration.",
      },
      sleepState: {
        status: "missing",
        reason: "Sleep duration was not recorded.",
        nextAction: "Sync sleep data from a source that reports sleep duration.",
      },
      stageState: {
        status: "missing",
        reason: "Sleep stages were not reported for this night.",
        nextAction: "Sync sleep data from a source that reports sleep stages.",
      },
    });
    expect(result.nightly[1]).toMatchObject({
      durationMinutes: 0,
      sleepMinutes: 0,
      rollingAvgDuration: 0,
      durationState: { status: "available" },
      sleepState: { status: "available" },
      stageState: { status: "available" },
      deepPct: null,
      remPct: null,
      lightPct: null,
      awakePct: null,
    });
    expect(result.nightly[2]).toMatchObject({
      durationMinutes: 480,
      sleepMinutes: null,
      durationState: { status: "available" },
      sleepState: { status: "missing" },
      stageState: { status: "missing" },
      deepPct: null,
      remPct: null,
      lightPct: null,
      awakePct: null,
    });
    expect(result.averageSleepMinutes).toBe(0);
    expect(result.averageEfficiencyPercent).toBe(0);
  });

  it.each(["deep_minutes", "rem_minutes", "light_minutes", "awake_minutes"] as const)(
    "withholds every stage percentage when %s is missing",
    async (missingStage) => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        sensorStore: makeSensorStore([
          sleepNightRow({
            [missingStage]: null,
          }),
        ]),
      });
      const result = await caller.sleepAnalytics({});

      expect(result.nightly[0]).toMatchObject({
        deepPct: null,
        remPct: null,
        lightPct: null,
        awakePct: null,
        stageState: {
          status: "missing",
          reason: "Sleep stages were not reported for this night.",
          nextAction: "Sync sleep data from a source that reports sleep stages.",
        },
      });
    },
  );

  it("withholds stage percentages when staging is unavailable despite complete stage minutes", async () => {
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore([
        sleepNightRow({
          staging_available: false,
        }),
      ]),
    });
    const result = await caller.sleepAnalytics({});

    expect(result.nightly[0]).toMatchObject({
      durationMinutes: 480,
      sleepMinutes: null,
      deepPct: null,
      remPct: null,
      lightPct: null,
      awakePct: null,
      stageState: { status: "missing" },
    });
  });

  it("derives Apple Health sleep minutes from complete stage minutes", async () => {
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore([
        sleepNightRow({
          deep_minutes: 90,
          rem_minutes: 105,
          light_minutes: 255,
          awake_minutes: 30,
        }),
      ]),
    });
    const result = await caller.sleepAnalytics({});

    expect(result.nightly[0]).toMatchObject({
      durationMinutes: 480,
      sleepMinutes: 450,
      deepPct: 18.8,
      remPct: 21.9,
      lightPct: 53.1,
      awakePct: 6.3,
      durationState: { status: "available" },
      sleepState: { status: "available" },
      stageState: { status: "available" },
    });
  });

  it("preserves recorded duration for a non-Apple provider when staging is unavailable", async () => {
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore([
        sleepNightRow({
          provider_id: "whoop",
          staging_available: false,
          deep_minutes: 30,
          rem_minutes: 30,
          light_minutes: 120,
          awake_minutes: 120,
        }),
      ]),
    });
    const result = await caller.sleepAnalytics({});

    expect(result.nightly[0]?.durationMinutes).toBe(480);
    expect(result.nightly[0]?.sleepMinutes).toBe(480);
  });

  it("keeps Apple Health sleep unavailable when staging is unavailable", async () => {
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore([
        sleepNightRow({
          provider_id: "apple_health",
          staging_available: false,
          deep_minutes: 30,
          rem_minutes: 30,
          light_minutes: 120,
          awake_minutes: 120,
        }),
      ]),
    });
    const result = await caller.sleepAnalytics({});

    expect(result.nightly[0]).toMatchObject({
      durationMinutes: 480,
      durationState: { status: "available" },
      sleepMinutes: null,
      sleepState: { status: "missing" },
      stageState: { status: "missing" },
    });
  });

  it("keeps Apple Health sleep unavailable when staging reports no stage minutes", async () => {
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore([
        sleepNightRow({
          deep_minutes: null,
          rem_minutes: null,
          light_minutes: null,
          awake_minutes: null,
        }),
      ]),
    });
    const result = await caller.sleepAnalytics({});

    expect(result.nightly[0]).toMatchObject({
      durationMinutes: 480,
      sleepMinutes: null,
      durationState: { status: "available" },
      sleepState: {
        status: "missing",
        reason: "Sleep stages were not reported for this night.",
        nextAction: "Sync sleep data from a source that reports sleep stages.",
      },
      stageState: {
        status: "missing",
        reason: "Sleep stages were not reported for this night.",
        nextAction: "Sync sleep data from a source that reports sleep stages.",
      },
    });
  });

  it.each([
    ["deep_minutes", 90],
    ["rem_minutes", 105],
    ["light_minutes", 255],
    ["awake_minutes", 30],
  ] as const)(
    "keeps Apple Health sleep unavailable when only %s is reported",
    async (presentStage, stageMinutes) => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        sensorStore: makeSensorStore([
          sleepNightRow({
            deep_minutes: null,
            rem_minutes: null,
            light_minutes: null,
            awake_minutes: null,
            [presentStage]: stageMinutes,
          }),
        ]),
      });
      const result = await caller.sleepAnalytics({});

      expect(result.nightly[0]).toMatchObject({
        sleepMinutes: null,
        deepPct: null,
        remPct: null,
        lightPct: null,
        awakePct: null,
        sleepState: { status: "missing" },
        stageState: { status: "missing" },
      });
    },
  );

  it("keeps missing duration null when Apple Health stages provide sleep minutes", async () => {
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore([
        sleepNightRow({
          duration_minutes: null,
        }),
      ]),
    });
    const result = await caller.sleepAnalytics({});

    expect(result.nightly[0]).toMatchObject({
      durationMinutes: null,
      sleepMinutes: 450,
      deepPct: null,
      remPct: null,
      lightPct: null,
      awakePct: null,
      durationState: {
        status: "missing",
        reason: "Sleep duration was not recorded.",
        nextAction: "Sync sleep data from a source that reports sleep duration.",
      },
      sleepState: { status: "available" },
    });
  });

  it("filters unavailable nights out of average sleep and debt calculations", async () => {
    const rows = [
      sleepNightRow({
        date: "2026-03-01",
        provider_id: "whoop",
        duration_minutes: null,
        efficiency_pct: null,
        staging_available: false,
      }),
      sleepNightRow({
        date: "2026-03-02",
        provider_id: "whoop",
        duration_minutes: 0,
      }),
      sleepNightRow({
        date: "2026-03-03",
        provider_id: "whoop",
        duration_minutes: 300,
      }),
      sleepNightRow({
        date: "2026-03-04",
        provider_id: "whoop",
        duration_minutes: 480,
      }),
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepAnalytics({});

    // The null night is excluded; the measured values are 0, 300, and 480.
    expect(result.averageSleepMinutes).toBe(260);
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
    expect(night?.localTimeContext).toEqual({
      timezone: null,
      startUtcOffsetMinutes: 0,
      endUtcOffsetMinutes: 0,
      source: "device_offset",
    });
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
    expect(result.averageSleepMinutes).toBeCloseTo(437, 1);
    expect(result.averageEfficiencyPercent).toBe(93.5);
  });

  it("maps the server-owned nightly selection and overlap evidence", async () => {
    const selectedSessionId = "00000000-0000-4000-8000-000000001774";
    const overlappingSessionId = "00000000-0000-4000-8000-000000001775";
    const rows = [
      sleepNightRow({
        provider_id: "whoop",
        source_name: "WHOOP 4.0",
        source_providers: ["apple_health", "whoop"],
        selected_session_id: selectedSessionId,
        overlapping_sessions: [
          {
            session_id: overlappingSessionId,
            provider_id: "oura",
            source_name: "Oura Ring",
            source_providers: ["oura"],
            timezone: "America/Los_Angeles",
            start_utc_offset_minutes: -420,
            end_utc_offset_minutes: -420,
            local_time_source: "provider_timezone",
            started_at: "2026-03-01T23:30:00Z",
            ended_at: "2026-03-02T05:00:00Z",
            duration_minutes: 330,
          },
        ],
      }),
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepAnalytics({});

    expect(result.nightly[0]).toMatchObject({
      providerId: "whoop",
      sourceName: "WHOOP 4.0",
      sourceProviders: ["apple_health", "whoop"],
      selectedSessionId,
      overlappingSessions: [
        {
          sessionId: overlappingSessionId,
          providerId: "oura",
          sourceName: "Oura Ring",
          sourceProviders: ["oura"],
          localTimeContext: {
            timezone: "America/Los_Angeles",
            startUtcOffsetMinutes: -420,
            endUtcOffsetMinutes: -420,
            source: "provider_timezone",
          },
          startedAt: "2026-03-01T23:30:00.000Z",
          endedAt: "2026-03-02T05:00:00.000Z",
          durationMinutes: 330,
        },
      ],
    });
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

  it("computes summary averages across multiple sleep nights", async () => {
    const rows = [
      sleepAnalyticsRow({
        date: "2026-03-01",
        durationMinutes: 400,
        deepPct: 20,
        remPct: 20,
        lightPct: 50,
        awakePct: 10,
        efficiency: 80,
      }),
      sleepAnalyticsRow({
        date: "2026-03-02",
        durationMinutes: 500,
        deepPct: 20,
        remPct: 20,
        lightPct: 50,
        awakePct: 10,
        efficiency: 90,
      }),
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepAnalytics({});

    expect(result.averageSleepMinutes).toBe(405);
    expect(result.averageEfficiencyPercent).toBe(85);
  });

  it("excludes an incomplete provider row from stage and efficiency averages", async () => {
    const rows = [
      sleepAnalyticsRow({
        date: "2026-03-01",
        durationMinutes: 480,
        deepPct: 20,
        remPct: 20,
        lightPct: 50,
        awakePct: 10,
        efficiency: 90,
      }),
      sleepNightRow({
        date: "2026-03-02",
        provider_id: "apple_health",
        duration_minutes: 480,
        deep_minutes: null,
        rem_minutes: null,
        light_minutes: null,
        awake_minutes: null,
        efficiency_pct: null,
        staging_available: false,
      }),
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });
    const result = await caller.sleepAnalytics({});

    expect(result.averageEfficiencyPercent).toBe(90);
    expect(result.nightly[1]).toMatchObject({
      stagingAvailable: false,
      deepPct: null,
      remPct: null,
      lightPct: null,
      awakePct: null,
      efficiency: null,
    });
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

  it("displayedDate defaults to null when timeSeries is empty", async () => {
    const result = await callerWith([]).workloadRatio({});
    expect(result.displayedDate).toBeNull();
  });

  it("omits outputWindowStart when workloadRatio requests all history", async () => {
    const sensorStore = makeSensorStore([]);
    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-1",
      timezone: "UTC",
      sensorStore,
    });

    await caller.workloadRatio({ days: null, endDate: "2026-03-31" });

    const queryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
    const queryParams = vi.mocked(sensorStore.query).mock.calls[0]?.[2];
    expect(queryText).not.toContain("outputWindowStart");
    expect(queryParams).not.toHaveProperty("outputWindowStart");
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

  it("rollingAvgDuration averages multiple available nights", async () => {
    const rows = [sleepDebtRow("2026-03-01", 400, 430), sleepDebtRow("2026-03-02", 500, 530)];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      sensorStore: makeSensorStore(rows),
    });

    const result = await caller.sleepAnalytics({});

    expect(result.nightly[0]?.sleepMinutes).toBe(400);
    expect(result.nightly[1]?.sleepMinutes).toBe(500);
    expect(result.nightly[1]?.rollingAvgDuration).toBe(450);
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
        reason: "free_recent_week",
        startDate: "2026-04-10",
        endDateExclusive: "2026-04-17",
      },
      sensorStore: makeSensorStore([]),
    });
    const result = await caller.sleepConsistency({});
    expect(result).toEqual([]);
  });
});
