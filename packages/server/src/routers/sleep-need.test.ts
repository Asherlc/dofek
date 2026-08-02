import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestCallerFactory, makeMockSensorStore } from "./test-helpers.ts";

const stressRepositoryMock = vi.hoisted(() => ({
  getStressScores: vi.fn(),
}));

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      userId: string | null;
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

vi.mock("../repositories/stress-repository.ts", () => ({
  StressRepository: class {
    getStressScores(days: number, endDate: string, options?: { priority?: "dashboard" }) {
      return stressRepositoryMock.getStressScores(days, endDate, options);
    }
  },
}));

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

import { sleepNeedRouter } from "./sleep-need.ts";

const createCaller = createTestCallerFactory(sleepNeedRouter);

beforeEach(() => {
  stressRepositoryMock.getStressScores.mockReset();
  stressRepositoryMock.getStressScores.mockResolvedValue({
    daily: [],
    weekly: [],
    latestScore: null,
    trend: "stable",
  });
});

interface SleepNeedFixtureRow {
  date: string;
  duration_minutes: number | null;
  next_day_hrv?: number | null;
  median_hrv?: number | null;
  good_recovery?: boolean;
  yesterday_load?: number;
  hasYesterdayLoad?: boolean;
  efficiency_pct?: number | null;
  provider_id?: string | null;
  source_name?: string | null;
  source_providers?: string[];
}

function addDays(dateString: string, days: number): string {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function completeSleepNeedRows(
  overrides: Partial<SleepNeedFixtureRow> = {},
): SleepNeedFixtureRow[] {
  return Array.from({ length: 7 }, (_, index) => ({
    date: addDays("2026-03-15", index - 7),
    duration_minutes: 480,
    next_day_hrv: 50,
    median_hrv: 45,
    good_recovery: true,
    yesterday_load: 0,
    ...overrides,
  }));
}

function toClickHouseSleepRows(rows: SleepNeedFixtureRow[]) {
  return rows.map((row) => ({
    date: row.date,
    timezone: null,
    start_utc_offset_minutes: 0,
    end_utc_offset_minutes: 0,
    local_time_source: "provider_offset",
    started_at: `${row.date}T22:00:00`,
    ended_at: `${addDays(row.date, 1)}T06:00:00`,
    duration_minutes: row.duration_minutes,
    deep_minutes: null,
    rem_minutes: null,
    light_minutes: null,
    awake_minutes: null,
    efficiency_pct: row.efficiency_pct === undefined ? 90 : row.efficiency_pct,
    staging_available: false,
    provider_id: row.provider_id ?? null,
    source_name: row.source_name ?? null,
    source_providers: row.source_providers ?? (row.provider_id ? [row.provider_id] : []),
  }));
}

function toHrvRows(rows: SleepNeedFixtureRow[]) {
  return rows
    .filter((row) => row.next_day_hrv !== undefined)
    .map((row) => ({
      date: addDays(row.date, 1),
      hrv: row.next_day_hrv ?? null,
    }));
}

function createCalculateCaller(rows: SleepNeedFixtureRow[]) {
  const yesterdayLoad = rows[0]?.yesterday_load ?? 0;
  const hasYesterdayLoad = rows[0]?.hasYesterdayLoad ?? true;
  return createCaller({
    db: { execute: vi.fn().mockResolvedValue(toHrvRows(rows)) },
    userId: "user-1",
    sensorStore: makeMockSensorStore([
      hasYesterdayLoad ? [{ load: yesterdayLoad }] : [],
      toClickHouseSleepRows(rows),
    ]),
  });
}

function createPerformanceCaller(rows: SleepNeedFixtureRow[]) {
  const sleepRows = [...rows].sort((leftRow, rightRow) =>
    leftRow.date.localeCompare(rightRow.date),
  );
  const clickHouseRows = toClickHouseSleepRows(sleepRows);
  return createCaller({
    db: { execute: vi.fn() },
    userId: "user-1",
    sensorStore: makeMockSensorStore([clickHouseRows, clickHouseRows, []]),
  });
}

describe("sleepNeedRouter", () => {
  describe("calculateV2", () => {
    it("returns the unavailable variant without recommendation fields when prior sleep is missing", async () => {
      const caller = createCalculateCaller([]);

      const result = await caller.calculateV2({ endDate: "2026-03-15" });

      expect(result).toEqual({
        availability: "missing_previous_night",
        epistemicStatus: { kind: "unavailable", label: "Unavailable" },
        message: "Sync last night's sleep data to see tonight's sleep need.",
      });
    });

    it("returns the unavailable variant when the prior-night duration is missing", async () => {
      const caller = createCalculateCaller([
        {
          date: "2026-03-14",
          duration_minutes: null,
        },
      ]);

      const result = await caller.calculateV2({ endDate: "2026-03-15" });

      expect(result).toEqual({
        availability: "missing_previous_night",
        epistemicStatus: { kind: "unavailable", label: "Unavailable" },
        message: "Sync last night's sleep data to see tonight's sleep need.",
      });
    });

    it("returns an insufficient-data state when baseline history is short", async () => {
      const caller = createCalculateCaller([
        {
          date: "2026-03-14",
          duration_minutes: 390,
          next_day_hrv: 50,
          yesterday_load: 100,
        },
      ]);

      const result = await caller.calculateV2({ endDate: "2026-03-15" });

      expect(result).toEqual({
        availability: "insufficient_data",
        epistemicStatus: { kind: "unavailable", label: "Unavailable" },
        reason: "insufficient_baseline_history",
        message: "Sync at least 7 qualifying nights to estimate sleep need.",
        nextAction: "Sync more sleep and recovery data.",
      });
    });

    it("returns an insufficient-data state when yesterday's load is missing", async () => {
      const caller = createCalculateCaller([...completeSleepNeedRows({ hasYesterdayLoad: false })]);

      const result = await caller.calculateV2({ endDate: "2026-03-15" });

      expect(result).toEqual({
        availability: "insufficient_data",
        epistemicStatus: { kind: "unavailable", label: "Unavailable" },
        reason: "missing_previous_day_load",
        message: "Sync yesterday's activity data to include training load in sleep need.",
        nextAction: "Sync activity data for the previous day.",
      });
    });

    it("excludes older missing durations from debt and recent-night values", async () => {
      const recentRows = completeSleepNeedRows().map((row) =>
        row.date === "2026-03-13" ? { ...row, duration_minutes: null } : row,
      );
      recentRows.push({
        date: "2026-03-07",
        duration_minutes: 480,
        next_day_hrv: 50,
        median_hrv: 45,
        good_recovery: true,
        yesterday_load: 0,
      });
      const caller = createCalculateCaller([
        {
          date: "2026-03-01",
          duration_minutes: null,
        },
        ...recentRows,
      ]);

      const result = await caller.calculateV2({ endDate: "2026-03-15" });

      expect(result).toMatchObject({
        availability: "available",
        epistemicStatus: { kind: "estimated", label: "Estimated" },
        accumulatedDebtMinutes: 0,
        debtRecoveryMinutes: 0,
        totalNeedMinutes: 480,
        estimateMetadata: {
          baselineQualifyingNightCount: 7,
          debtObservedNightCount: 7,
          basisLabel:
            "Baseline uses the average of 7 qualifying nights followed by at-or-above-median heart rate variability.",
        },
      });
      if (result.availability !== "available") {
        throw new Error("Expected available sleep need");
      }
      expect(result.recentNights.find((night) => night.date === "2026-03-01")).toBeUndefined();
      expect(result.recentNights.find((night) => night.date === "2026-03-13")).toMatchObject({
        actualMinutes: null,
        debtMinutes: null,
      });
    });
  });

  // ── calculate ──────────────────────────────────────────

  describe("calculate", () => {
    it("requires a ClickHouse sensor store", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });

      await expect(caller.calculate({ endDate: "2026-03-15" })).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message:
          "sleepNeed.calculate requires the ClickHouse activity analytics store. Set CLICKHOUSE_URL and retry.",
      });
    });

    it("preserves the legacy recommendation shape when no data is available", async () => {
      const sensorStore = makeMockSensorStore([]);
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        sensorStore,
      });
      const result = await caller.calculate({ endDate: "2026-03-15" });

      expect(result).toMatchObject({
        baselineMinutes: 480,
        strainDebtMinutes: 0,
        accumulatedDebtMinutes: 0,
        totalNeedMinutes: 480,
        recentNights: expect.any(Array),
        canRecommend: false,
      });
      const queryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
      expect(queryText).toContain("analytics.daily_strain FINAL");
      expect(queryText).toContain("sumOrNull(daily_load)");
      expect(queryText).toContain("is_deleted = 0");
      expect(queryText).toContain("toDate(toTimeZone(toDateTime(date), {timezone:String}))");
      expect(queryText).not.toContain("analytics.activity_summary");
    });

    it("passes the user timezone when selecting yesterday's strain load", async () => {
      const sensorStore = makeMockSensorStore([[{ load: 0 }], []]);
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "America/Los_Angeles",
        sensorStore,
      });

      await caller.calculate({ endDate: "2026-03-15" });

      expect(vi.mocked(sensorStore.query).mock.calls[0]?.[2]).toMatchObject({
        timezone: "America/Los_Angeles",
      });
    });

    it("computes baseline from good recovery nights when >= 7 good nights", async () => {
      // Create nights where good_recovery is true and duration varies
      const rows = Array.from({ length: 10 }, (_, i) => ({
        date: `2026-03-${String(i + 1).padStart(2, "0")}`,
        duration_minutes: 450 + i * 5, // 450, 455, 460, ... 495
        next_day_hrv: 50,
        median_hrv: 45,
        good_recovery: true,
        yesterday_load: 0,
      }));

      const caller = createCalculateCaller(rows);
      const result = await caller.calculate({ endDate: "2026-03-11" });

      // Average of 450, 455, 460, 465, 470, 475, 480, 485, 490, 495 = 472.5
      expect(result.baselineMinutes).toBe(473); // rounded
    });

    it("keeps the legacy recommendation unavailable when fewer than 7 good nights exist", async () => {
      const rows = Array.from({ length: 5 }, (_, i) => ({
        date: `2026-03-${String(i + 1).padStart(2, "0")}`,
        duration_minutes: 450,
        next_day_hrv: 50,
        median_hrv: 45,
        good_recovery: true,
        yesterday_load: 0,
      }));
      rows.push({
        date: "2026-03-14",
        duration_minutes: 450,
        next_day_hrv: 50,
        median_hrv: 45,
        good_recovery: false,
        yesterday_load: 0,
      });

      const caller = createCalculateCaller(rows);
      const result = await caller.calculate({ endDate: "2026-03-15" });

      expect(result.baselineMinutes).toBe(480);
      expect(result.canRecommend).toBe(false);
    });

    it("excludes bad recovery nights from baseline calculation", async () => {
      const rows = [
        // 7 good nights at 420 min
        ...Array.from({ length: 7 }, (_, i) => ({
          date: `2026-03-${String(i + 1).padStart(2, "0")}`,
          duration_minutes: 420,
          next_day_hrv: 55,
          median_hrv: 45,
          good_recovery: true,
          yesterday_load: 0,
        })),
        // 3 bad recovery nights at 600 min (should be excluded from baseline)
        ...Array.from({ length: 3 }, (_, i) => ({
          date: `2026-03-${String(i + 8).padStart(2, "0")}`,
          duration_minutes: 600,
          next_day_hrv: 30,
          median_hrv: 45,
          good_recovery: false,
          yesterday_load: 0,
        })),
      ];

      const caller = createCalculateCaller(rows);
      const result = await caller.calculate({ endDate: "2026-03-11" });

      // Only good nights (420 min each) count for baseline
      expect(result.baselineMinutes).toBe(420);
    });

    it("computes strain debt from yesterday's load, capped at 60 minutes", async () => {
      const rows = completeSleepNeedRows({ yesterday_load: 200 });

      const caller = createCalculateCaller(rows);
      const result = await caller.calculate({ endDate: "2026-03-15" });

      // strainDebt = Math.min(60, Math.round(200 / 5)) = Math.min(60, 40) = 40
      expect(result.strainDebtMinutes).toBe(40);
    });

    it("caps strain debt at 60 minutes for very high load", async () => {
      const rows = completeSleepNeedRows({ yesterday_load: 500 });

      const caller = createCalculateCaller(rows);
      const result = await caller.calculate({ endDate: "2026-03-15" });

      expect(result.strainDebtMinutes).toBe(60);
    });

    it("uses yesterday_load from first row in array", async () => {
      const rows = completeSleepNeedRows({ yesterday_load: 150 });
      rows[1] = { ...rows[1], yesterday_load: 0 };

      const caller = createCalculateCaller(rows);
      const result = await caller.calculate({ endDate: "2026-03-15" });

      // yesterdayLoad = rows[0].yesterday_load = 150
      // strainDebt = min(60, round(150/5)) = min(60, 30) = 30
      expect(result.strainDebtMinutes).toBe(30);
    });

    it("defaults yesterday_load to 0 when no rows", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        sensorStore: makeMockSensorStore([]),
      });
      const result = await caller.calculate({ endDate: "2026-03-15" });

      expect(result.strainDebtMinutes).toBe(0);
      expect(result.canRecommend).toBe(false);
    });

    it("computes accumulated sleep debt over last 14 nights", async () => {
      // 14 nights each at 430 min with baseline 480
      const rows = Array.from({ length: 20 }, (_, i) => ({
        date: `2026-03-${String(i + 1).padStart(2, "0")}`,
        duration_minutes: 430,
        next_day_hrv: 55,
        median_hrv: 45,
        good_recovery: true,
        yesterday_load: 0,
      }));

      const caller = createCalculateCaller(rows);
      const result = await caller.calculate({ endDate: "2026-03-15" });

      // baseline = avg of 20 good nights at 430 = 430
      // last14: all 430, deficit per night = 430 - 430 = 0
      expect(result.accumulatedDebtMinutes).toBe(0);
    });

    it("accumulated debt only counts positive deficits", async () => {
      // Mixed nights: some above, some below baseline
      const rows = [
        ...Array.from({ length: 7 }, (_, i) => ({
          date: `2026-02-${String(i + 20).padStart(2, "0")}`,
          duration_minutes: 480,
          next_day_hrv: 55,
          median_hrv: 45,
          good_recovery: true,
          yesterday_load: 0,
        })),
        // These 7 nights are at 420 (below baseline of 480)
        ...Array.from({ length: 7 }, (_, i) => ({
          date: `2026-03-${String(i + 1).padStart(2, "0")}`,
          duration_minutes: 420,
          next_day_hrv: 55,
          median_hrv: 45,
          good_recovery: true,
          yesterday_load: 0,
        })),
        // These 7 nights are at 520 (above baseline of 480)
        ...Array.from({ length: 7 }, (_, i) => ({
          date: `2026-03-${String(i + 8).padStart(2, "0")}`,
          duration_minutes: 520,
          next_day_hrv: 55,
          median_hrv: 45,
          good_recovery: true,
          yesterday_load: 0,
        })),
      ];

      const caller = createCalculateCaller(rows);
      const result = await caller.calculate({ endDate: "2026-03-15" });

      // Baseline = avg of 21 good nights = (7*480 + 7*420 + 7*520) / 21 = (3360+2940+3640)/21 = 9940/21 ≈ 473
      // last14: 7 nights at 420, 7 at 520
      // deficit per 420 night = 473 - 420 = 53 -> 7 * 53 = 371
      // deficit per 520 night = 473 - 520 = -47 -> 0 (only positive counts)
      // accumulatedDebt = 371
      expect(result.accumulatedDebtMinutes).toBeGreaterThan(0);
    });

    it("totalNeedMinutes = baseline + strainDebt + debtRecovery", async () => {
      const rows = Array.from({ length: 14 }, (_, i) => ({
        date: `2026-03-${String(i + 1).padStart(2, "0")}`,
        duration_minutes: 400,
        next_day_hrv: 55,
        median_hrv: 45,
        good_recovery: true,
        yesterday_load: 100,
      }));

      const caller = createCalculateCaller(rows);
      const result = await caller.calculate({ endDate: "2026-03-15" });

      // baseline = avg of 14 good nights at 400 = 400 (>= 7 good nights)
      // strainDebt = min(60, round(100/5)) = 20
      // accumulatedDebt: last14 nights at 400, baseline=400 -> 0 deficit per night
      // debtRecovery = round(0 * 0.25) = 0
      // total = 400 + 20 + 0 = 420
      expect(result.totalNeedMinutes).toBe(
        result.baselineMinutes +
          result.strainDebtMinutes +
          Math.round(result.accumulatedDebtMinutes * 0.25),
      );
    });

    it("recentNights shows last 7 calendar nights with debt tracking", async () => {
      // Data covers 2026-03-01 through 2026-03-14, endDate is 2026-03-15
      // Calendar: 2026-03-09 through 2026-03-15
      // Data exists for 2026-03-09 through 2026-03-14, missing for 2026-03-15
      const rows = Array.from({ length: 14 }, (_, i) => ({
        date: `2026-03-${String(i + 1).padStart(2, "0")}`,
        duration_minutes: 450,
        next_day_hrv: 55,
        median_hrv: 45,
        good_recovery: true,
        yesterday_load: 0,
      }));

      const caller = createCalculateCaller(rows);
      const result = await caller.calculate({ endDate: "2026-03-15" });

      expect(result.recentNights).toHaveLength(7);
      // baseline = 450 (14 good nights at 450)
      // Calendar nights with data: actual=450, needed=450, debt=0
      // Last night (2026-03-15) has no data → null
      const withData = result.recentNights.filter((n) => n.actualMinutes !== null);
      for (const night of withData) {
        expect(night.actualMinutes).toBe(450);
        expect(night.neededMinutes).toBe(450);
        expect(night.debtMinutes).toBe(0);
      }
    });

    it("recentNights dates are calendar dates ending at endDate", async () => {
      const rows = Array.from({ length: 14 }, (_, i) => ({
        date: `2026-03-${String(i + 1).padStart(2, "0")}`,
        duration_minutes: 450,
        next_day_hrv: 55,
        median_hrv: 45,
        good_recovery: true,
        yesterday_load: 0,
      }));

      const caller = createCalculateCaller(rows);
      const result = await caller.calculate({ endDate: "2026-03-15" });

      // Calendar: endDate-7 through endDate-1 (last 7 completed nights, excluding today)
      expect(result.recentNights[0]?.date).toBe("2026-03-08");
      expect(result.recentNights[6]?.date).toBe("2026-03-14");
    });

    it("recentNights computes positive debt when actual < baseline", async () => {
      const rows = Array.from({ length: 10 }, (_, i) => ({
        date: `2026-03-${String(i + 1).padStart(2, "0")}`,
        duration_minutes: 420,
        next_day_hrv: 55,
        median_hrv: 45,
        good_recovery: true,
        yesterday_load: 0,
      }));

      const caller = createCalculateCaller(rows);
      const result = await caller.calculate({ endDate: "2026-03-11" });

      // baseline = 420, actual = 420, debt = 0
      // Only check nights that have data (some calendar dates may be null)
      for (const night of result.recentNights) {
        if (night.debtMinutes !== null) {
          expect(night.debtMinutes).toBe(0);
        }
      }
    });

    it("recentNights debt is 0 when actual > baseline", async () => {
      // 8 good nights at 480 and 2 good nights at 520 (all good)
      const rows = [
        ...Array.from({ length: 8 }, (_, i) => ({
          date: `2026-03-${String(i + 1).padStart(2, "0")}`,
          duration_minutes: 480,
          next_day_hrv: 55,
          median_hrv: 45,
          good_recovery: true,
          yesterday_load: 0,
        })),
        ...Array.from({ length: 2 }, (_, i) => ({
          date: `2026-03-${String(i + 9).padStart(2, "0")}`,
          duration_minutes: 520,
          next_day_hrv: 55,
          median_hrv: 45,
          good_recovery: true,
          yesterday_load: 0,
        })),
      ];

      const caller = createCalculateCaller(rows);
      const result = await caller.calculate({ endDate: "2026-03-11" });

      // baseline = (8*480 + 2*520)/10 = (3840 + 1040)/10 = 488
      // Recent nights at 520 have debtMinutes = max(0, 488-520) = 0
      const nights520 = result.recentNights.filter((n) => n.actualMinutes === 520);
      for (const night of nights520) {
        expect(night.debtMinutes).toBe(0);
      }
    });

    it("excludes zero-duration good nights from baseline", async () => {
      // Some good nights with 0 duration should be excluded
      const rows = [
        ...Array.from({ length: 7 }, (_, i) => ({
          date: `2026-03-${String(i + 8).padStart(2, "0")}`,
          duration_minutes: 480,
          next_day_hrv: 55,
          median_hrv: 45,
          good_recovery: true,
          yesterday_load: 0,
        })),
        {
          date: "2026-03-07",
          duration_minutes: 0,
          next_day_hrv: 55,
          median_hrv: 45,
          good_recovery: true,
          yesterday_load: 0,
        },
      ];

      const caller = createCalculateCaller(rows);
      const result = await caller.calculate({ endDate: "2026-03-15" });

      // Only 7 good nights with duration > 0 at 480 each
      expect(result.baselineMinutes).toBe(480);
    });

    it("includes provenance on recent nights with sleep data", async () => {
      const rows: SleepNeedFixtureRow[] = [];
      for (let dayOffset = 7; dayOffset >= 1; dayOffset -= 1) {
        rows.push({
          date: addDays("2026-03-15", -dayOffset),
          duration_minutes: 480,
          provider_id: "whoop",
          next_day_hrv: 50,
          median_hrv: 45,
          good_recovery: true,
          yesterday_load: 0,
        });
      }

      const caller = createCalculateCaller(rows);
      const result = await caller.calculate({ endDate: "2026-03-15" });

      for (const night of result.recentNights) {
        expect(night.providerId).toBe("whoop");
        expect(night.sourceName).toBeNull();
        expect(night.sourceProviders).toEqual(["whoop"]);
      }
    });

    it("maps provenance from the matching sleep row for each recent night", async () => {
      const rows: SleepNeedFixtureRow[] = [];
      for (let dayOffset = 7; dayOffset >= 1; dayOffset -= 1) {
        const date = addDays("2026-03-15", -dayOffset);
        rows.push({
          date,
          duration_minutes: 480,
          provider_id: date === "2026-03-14" ? "apple_health" : "whoop",
          source_name: date === "2026-03-14" ? "Apple Watch" : null,
          source_providers: date === "2026-03-14" ? ["apple_health", "whoop"] : ["whoop"],
          next_day_hrv: 50,
          median_hrv: 45,
          good_recovery: true,
          yesterday_load: 0,
        });
      }

      const caller = createCalculateCaller(rows);
      const result = await caller.calculate({ endDate: "2026-03-15" });

      expect(result.recentNights.find((night) => night.date === "2026-03-13")).toMatchObject({
        providerId: "whoop",
        sourceName: null,
        sourceProviders: ["whoop"],
      });
      expect(result.recentNights.find((night) => night.date === "2026-03-14")).toMatchObject({
        providerId: "apple_health",
        sourceName: "Apple Watch",
        sourceProviders: ["apple_health", "whoop"],
      });
    });

    it("returns the legacy calendar shape when recent nights have no sleep data", async () => {
      const caller = createCalculateCaller([]);
      const result = await caller.calculate({ endDate: "2026-03-15" });

      expect(result.recentNights).toHaveLength(7);
      expect(result.recentNights.every((night) => night.actualMinutes === null)).toBe(true);
      expect(result.canRecommend).toBe(false);
    });
  });

  // ── performance ──────────────────────────────────────────

  describe("performance", () => {
    it("requires a ClickHouse sensor store", async () => {
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
      });

      await expect(caller.performance({ endDate: "2026-03-15" })).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message:
          "sleepNeed.performance requires the ClickHouse activity analytics store. Set CLICKHOUSE_URL and retry.",
      });
    });

    it("returns null when no sleep data", async () => {
      const caller = createPerformanceCaller([]);
      const result = await caller.performance({ endDate: "2026-03-15" });

      expect(result).toBeNull();
    });

    it("returns null when duration_minutes is null", async () => {
      const caller = createPerformanceCaller([
        { date: "2026-03-14", duration_minutes: null, efficiency_pct: 90 },
      ]);
      const result = await caller.performance({ endDate: "2026-03-15" });

      expect(result).toBeNull();
    });

    it("returns sleep performance info when data is available", async () => {
      const caller = createPerformanceCaller([
        { date: "2026-03-14", duration_minutes: 450, efficiency_pct: 92 },
        { date: "2026-03-01", duration_minutes: 480 },
      ]);
      const result = await caller.performance({ endDate: "2026-03-15" });

      expect(result).not.toBeNull();
      expect(result?.actualMinutes).toBe(450);
      expect(result?.neededMinutes).toBe(480);
      expect(result?.efficiency).toBe(92);
      expect(result?.score).toBeGreaterThanOrEqual(0);
      expect(result?.score).toBeLessThanOrEqual(100);
      expect(["Excellent", "Good", "Fair", "Poor"]).toContain(result?.tier);
      expect(result?.recommendedBedtime).toMatch(/^\d{2}:\d{2}$/);
    });

    it("returns the effective date and timezone with sleep performance", async () => {
      const caller = createPerformanceCaller([
        { date: "2026-03-14", duration_minutes: 450, efficiency_pct: 92 },
        { date: "2026-03-01", duration_minutes: 480 },
      ]);

      const result = await caller.performance({ endDate: "2026-03-15" });

      expect(result?.summaryDateContext).toEqual({
        effectiveDate: "2026-03-15",
        timezone: "UTC",
      });
    });

    it("reads dashboard sleep performance from the daily sleep summary once", async () => {
      const rows = [
        { date: "2026-03-14", duration_minutes: 450, efficiency_pct: 92 },
        { date: "2026-03-01", duration_minutes: 480 },
      ];
      const clickHouseRows = toClickHouseSleepRows(rows);
      const sensorStore = makeMockSensorStore([clickHouseRows]);
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
        sensorStore,
      });

      await caller.performance({ endDate: "2026-03-15" });

      const queryTexts = vi.mocked(sensorStore.query).mock.calls.map((call) => String(call[1]));
      expect(
        queryTexts.filter((queryText) => queryText.includes("analytics.daily_sleep")),
      ).toHaveLength(1);
      expect(
        queryTexts.filter((queryText) => queryText.includes("analytics.v_sleep")),
      ).toHaveLength(0);
    });

    it("uses dashboard priority for every sleep-performance ClickHouse read", async () => {
      const rows = [
        { date: "2026-03-14", duration_minutes: 450, efficiency_pct: 92 },
        { date: "2026-03-01", duration_minutes: 480 },
      ];
      const clickHouseRows = toClickHouseSleepRows(rows);
      const sensorStore = makeMockSensorStore([clickHouseRows]);
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
        sensorStore,
      });

      await caller.performance({ endDate: "2026-03-15" });

      const queryOptions = vi.mocked(sensorStore.query).mock.calls.map((call) => call[3]);
      expect(queryOptions).toEqual([{ priority: "dashboard" }]);
      expect(stressRepositoryMock.getStressScores).toHaveBeenCalledWith(90, "2026-03-15", {
        priority: "dashboard",
      });
    });

    it("includes provenance from the daily sleep model on performance response", async () => {
      const caller = createPerformanceCaller([
        {
          date: "2026-03-14",
          duration_minutes: 450,
          efficiency_pct: 92,
          provider_id: "whoop",
          source_name: "WHOOP 4.0",
          source_providers: ["whoop", "apple_health"],
        },
        { date: "2026-03-01", duration_minutes: 480, provider_id: "apple_health" },
      ]);
      const result = await caller.performance({ endDate: "2026-03-15" });

      expect(result?.providerId).toBe("whoop");
      expect(result?.sourceName).toBe("WHOOP 4.0");
      expect(result?.sourceProviders).toEqual(["whoop", "apple_health"]);
    });

    it("uses the historical sleep average for provider-backed rows", async () => {
      const caller = createPerformanceCaller([
        {
          date: "2026-03-14",
          duration_minutes: 465,
          efficiency_pct: 72,
          provider_id: "provider-a",
        },
        { date: "2026-03-01", duration_minutes: 480, provider_id: "provider-a" },
      ]);
      const result = await caller.performance({ endDate: "2026-03-15" });

      expect(result?.neededMinutes).toBe(480);
      expect(result?.score).toBe(89);
    });

    it("averages provider-agnostic duration, efficiency, consistency, and stress components", async () => {
      stressRepositoryMock.getStressScores.mockResolvedValueOnce({
        daily: [
          {
            date: "2026-03-14",
            stressScore: 2.55,
            hrvDeviation: null,
            restingHrDeviation: null,
            sleepEfficiency: 72,
          },
        ],
        weekly: [],
        latestScore: 2.55,
        trend: "stable",
      });
      const rows = [
        { date: "2026-03-14", duration_minutes: 465, efficiency_pct: 72 },
        ...Array.from({ length: 6 }, (_, index) => ({
          date: `2026-03-${String(index + 8).padStart(2, "0")}`,
          duration_minutes: 480,
          efficiency_pct: 90,
        })),
      ];
      const caller = createPerformanceCaller(rows);
      const result = await caller.performance({ endDate: "2026-03-15" });

      expect(result?.components?.hours).toBe(97);
      expect(result?.components?.efficiency).toBe(72);
      expect(result?.components?.consistency).toBe(100);
      expect(result?.components?.lowStress).toBe(15);
      expect(result?.score).toBe(71);
    });

    it("uses component scoring when consistency is available without stress", async () => {
      const rows = [
        { date: "2026-03-14", duration_minutes: 465, efficiency_pct: 72 },
        ...Array.from({ length: 6 }, (_, index) => ({
          date: `2026-03-${String(index + 8).padStart(2, "0")}`,
          duration_minutes: 480,
          efficiency_pct: 90,
        })),
      ];
      const caller = createPerformanceCaller(rows);
      const result = await caller.performance({ endDate: "2026-03-15" });

      expect(result?.components?.hours).toBe(97);
      expect(result?.components?.efficiency).toBe(72);
      expect(result?.components?.consistency).toBe(100);
      expect(result?.components?.lowStress).toBeNull();
      expect(result?.score).toBe(90);
    });

    it("uses component scoring when stress is available without consistency", async () => {
      stressRepositoryMock.getStressScores.mockResolvedValueOnce({
        daily: [
          {
            date: "2026-03-14",
            stressScore: 2.55,
            hrvDeviation: null,
            restingHrDeviation: null,
            sleepEfficiency: 72,
          },
        ],
        weekly: [],
        latestScore: 2.55,
        trend: "stable",
      });
      const caller = createPerformanceCaller([
        { date: "2026-03-14", duration_minutes: 465, efficiency_pct: 72 },
        { date: "2026-03-01", duration_minutes: 480 },
      ]);
      const result = await caller.performance({ endDate: "2026-03-15" });

      expect(result?.components?.hours).toBe(97);
      expect(result?.components?.efficiency).toBe(72);
      expect(result?.components?.consistency).toBeNull();
      expect(result?.components?.lowStress).toBe(15);
      expect(result?.score).toBe(61);
    });

    it("matches stress to the latest sleep date before scoring low stress", async () => {
      stressRepositoryMock.getStressScores.mockResolvedValueOnce({
        daily: [
          {
            date: "2026-03-13",
            stressScore: 0,
            hrvDeviation: null,
            restingHrDeviation: null,
            sleepEfficiency: 80,
          },
          {
            date: "2026-03-14",
            stressScore: 3,
            hrvDeviation: null,
            restingHrDeviation: null,
            sleepEfficiency: 80,
          },
        ],
        weekly: [],
        latestScore: 3,
        trend: "stable",
      });
      const rows = [
        { date: "2026-03-14", duration_minutes: 480, efficiency_pct: 80 },
        ...Array.from({ length: 6 }, (_, index) => ({
          date: `2026-03-${String(index + 8).padStart(2, "0")}`,
          duration_minutes: 480,
          efficiency_pct: 90,
        })),
      ];
      const caller = createPerformanceCaller(rows);
      const result = await caller.performance({ endDate: "2026-03-15" });

      expect(result?.components?.lowStress).toBe(0);
      expect(result?.score).toBe(70);
    });

    it("returns unavailable performance when efficiency was not reported", async () => {
      const caller = createPerformanceCaller([
        { date: "2026-03-14", duration_minutes: 480, efficiency_pct: null },
        { date: "2026-03-01", duration_minutes: 480 },
      ]);
      const result = await caller.performance({ endDate: "2026-03-15" });

      expect(result).toBeNull();
    });

    it("uses default baseline of 480 when avg_duration is null", async () => {
      const caller = createPerformanceCaller([
        { date: "2026-03-14", duration_minutes: 450, efficiency_pct: 90 },
        { date: "2026-03-01", duration_minutes: null },
      ]);
      const result = await caller.performance({ endDate: "2026-03-15" });

      expect(result).not.toBeNull();
      expect(result?.neededMinutes).toBe(480);
    });

    it("uses default baseline of 480 when no baseline rows", async () => {
      const caller = createPerformanceCaller([
        { date: "2026-03-14", duration_minutes: 450, efficiency_pct: 90 },
      ]);
      const result = await caller.performance({ endDate: "2026-03-15" });

      expect(result).not.toBeNull();
      expect(result?.neededMinutes).toBe(480);
    });

    it("computes recommended bedtime in HH:MM format", async () => {
      const caller = createPerformanceCaller([
        { date: "2026-03-14", duration_minutes: 480, efficiency_pct: 95 },
        { date: "2026-03-01", duration_minutes: 480 },
      ]);
      const result = await caller.performance({ endDate: "2026-03-15" });

      expect(result?.recommendedBedtime).toMatch(/^\d{2}:\d{2}$/);
      // For 480 min need + 15 min fall-asleep, from 07:00 wake time:
      // 420 min (7h) - 480 - 15 = -75 min from midnight = 22:45
      expect(result?.recommendedBedtime).toBe("22:45");
    });

    it("rounds neededMinutes to integer", async () => {
      const caller = createPerformanceCaller([
        { date: "2026-03-14", duration_minutes: 450, efficiency_pct: 90 },
        { date: "2026-03-01", duration_minutes: 467.8 },
      ]);
      const result = await caller.performance({ endDate: "2026-03-15" });

      expect(result?.neededMinutes).toBe(468);
      expect(Number.isInteger(result?.neededMinutes)).toBe(true);
    });
  });
});
