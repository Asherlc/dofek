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

vi.mock("dofek/lib/cache", () => ({
  queryCache: {
    invalidateByPrefix: vi.fn().mockResolvedValue(undefined),
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

import { queryCache } from "dofek/lib/cache";
import { DISCONNECT_CHILD_TABLES } from "./provider-detail.ts";
import { recoveryRouter } from "./recovery.ts";
import { settingsRouter } from "./settings.ts";
import { sleepNeedRouter } from "./sleep-need.ts";
import { sportSettingsRouter } from "./sport-settings.ts";

function queryChunkLength(value: unknown): number {
  if (!value || typeof value !== "object" || !("queryChunks" in value)) return -1;
  const queryChunks = Reflect.get(value, "queryChunks");
  return Array.isArray(queryChunks) ? queryChunks.length : -1;
}

function expectCallsUseNonEmptySql(executeMock: ReturnType<typeof vi.fn>) {
  for (const [arg] of executeMock.mock.calls) {
    expect(queryChunkLength(arg)).toBeGreaterThan(0);
  }
}

// ── Recovery Router ──

describe("recoveryRouter", () => {
  const createCaller = createTestCallerFactory(recoveryRouter);

  function makeCaller(rows: Record<string, unknown>[] = []) {
    return createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
      timezone: "UTC",
    });
  }

  describe("sleepConsistency", () => {
    it("returns empty when no sleep data", async () => {
      const caller = makeCaller([]);
      const result = await caller.sleepConsistency({ days: 90 });
      expect(result).toEqual([]);
    });

    it("computes consistency score", async () => {
      const rows = [
        {
          date: "2024-01-15",
          bedtime_hour: 22.5,
          waketime_hour: 6.5,
          rolling_bedtime_stddev: 0.3,
          rolling_waketime_stddev: 0.4,
          window_count: 14,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.sleepConsistency({ days: 90 });

      expect(result).toHaveLength(1);
      expect(result[0]?.consistencyScore).not.toBeNull();
      // Low stddev means high consistency
      expect(result[0]?.consistencyScore).toBeGreaterThan(50);
    });

    it("returns null consistency when window too small", async () => {
      const rows = [
        {
          date: "2024-01-15",
          bedtime_hour: 22.5,
          waketime_hour: 6.5,
          rolling_bedtime_stddev: 0.3,
          rolling_waketime_stddev: 0.4,
          window_count: 3,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.sleepConsistency({ days: 90 });

      expect(result[0]?.consistencyScore).toBeNull();
    });

    it("computes consistency at exactly 7-day window boundary", async () => {
      const rows = [
        {
          date: "2024-01-15",
          bedtime_hour: 22.5,
          waketime_hour: 6.5,
          rolling_bedtime_stddev: 0.3,
          rolling_waketime_stddev: 0.4,
          window_count: 7,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.sleepConsistency({ days: 90 });

      expect(result[0]?.consistencyScore).not.toBeNull();
    });

    it("rounds bedtime and waketime hours to two decimal places", async () => {
      const rows = [
        {
          date: "2024-01-15",
          bedtime_hour: 22.456789,
          waketime_hour: 6.123456,
          rolling_bedtime_stddev: 0.3,
          rolling_waketime_stddev: 0.4,
          window_count: 14,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.sleepConsistency({ days: 90 });

      expect(result[0]?.bedtimeHour).toBe(22.46);
      expect(result[0]?.waketimeHour).toBe(6.12);
    });

    it("returns null stddev values when rolling stats are null", async () => {
      const rows = [
        {
          date: "2024-01-15",
          bedtime_hour: 22.5,
          waketime_hour: 6.5,
          rolling_bedtime_stddev: null,
          rolling_waketime_stddev: null,
          window_count: 14,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.sleepConsistency({ days: 90 });

      expect(result[0]?.rollingBedtimeStddev).toBeNull();
      expect(result[0]?.rollingWaketimeStddev).toBeNull();
    });

    it("rounds rolling stddev to two decimal places", async () => {
      const rows = [
        {
          date: "2024-01-15",
          bedtime_hour: 22.5,
          waketime_hour: 6.5,
          rolling_bedtime_stddev: 0.3456,
          rolling_waketime_stddev: 0.7891,
          window_count: 14,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.sleepConsistency({ days: 90 });

      expect(result[0]?.rollingBedtimeStddev).toBe(0.35);
      expect(result[0]?.rollingWaketimeStddev).toBe(0.79);
    });
  });

  describe("hrvVariability", () => {
    it("returns HRV variability data", async () => {
      const rows = [{ date: "2024-01-15", hrv: 55, rolling_mean: 60, rolling_cv: 12.5 }];
      const caller = makeCaller(rows);
      const result = await caller.hrvVariability({ days: 90 });

      expect(result).toHaveLength(1);
      expect(result[0]?.hrv).toBe(55);
      expect(result[0]?.rollingCoefficientOfVariation).toBe(12.5);
    });

    it("handles null values", async () => {
      const rows = [{ date: "2024-01-15", hrv: null, rolling_mean: null, rolling_cv: null }];
      const caller = makeCaller(rows);
      const result = await caller.hrvVariability({ days: 90 });

      expect(result[0]?.hrv).toBeNull();
      expect(result[0]?.rollingMean).toBeNull();
      expect(result[0]?.rollingCoefficientOfVariation).toBeNull();
    });

    it("rounds HRV values to one decimal place", async () => {
      const rows = [{ date: "2024-01-15", hrv: 55.456, rolling_mean: 60.789, rolling_cv: 12.567 }];
      const caller = makeCaller(rows);
      const result = await caller.hrvVariability({ days: 90 });

      expect(result[0]?.hrv).toBe(55.5);
      expect(result[0]?.rollingMean).toBe(60.8);
      expect(result[0]?.rollingCoefficientOfVariation).toBe(12.57);
    });
  });

  describe("workloadRatio", () => {
    it("returns workload ratio data with displayed strain", async () => {
      const rows = [
        {
          date: "2024-01-15",
          daily_load: 80,
          acute_load: 400,
          chronic_load: 350,
          workload_ratio: 1.14,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.workloadRatio({ days: 90 });

      expect(result.timeSeries).toHaveLength(1);
      expect(result.timeSeries[0]?.workloadRatio).toBe(1.14);
      expect(result.timeSeries[0]?.strain).toBeGreaterThan(0);
      expect(result.displayedStrain).toBeGreaterThan(0);
      expect(result.displayedDate).toBe("2024-01-15");
    });

    it("handles null workload ratio", async () => {
      const rows = [
        { date: "2024-01-15", daily_load: 0, acute_load: 0, chronic_load: 0, workload_ratio: null },
      ];
      const caller = makeCaller(rows);
      const result = await caller.workloadRatio({ days: 90 });

      expect(result.timeSeries[0]?.workloadRatio).toBeNull();
      expect(result.displayedStrain).toBe(0);
    });
  });

  describe("sleepAnalytics", () => {
    it("computes sleep analytics with debt using actual sleep time", async () => {
      const rows = Array.from({ length: 14 }, (_, i) => ({
        date: `2024-01-${String(i + 1).padStart(2, "0")}`,
        duration_minutes: 480,
        sleep_minutes: 420,
        deep_pct: 15,
        rem_pct: 20,
        light_pct: 55,
        awake_pct: 10,
        efficiency: 88,
        rolling_avg_duration: 420,
      }));
      const caller = makeCaller(rows);
      const result = await caller.sleepAnalytics({ days: 90 });

      expect(result.nightly).toHaveLength(14);
      expect(result.nightly[0]?.durationMinutes).toBe(480);
      expect(result.nightly[0]?.sleepMinutes).toBe(420);
      // 14 nights * (480 - 420) = 840 min debt (based on sleepMinutes)
      expect(result.sleepDebt).toBe(840);
    });

    it("rounds stage percentages to one decimal place", async () => {
      const rows = [
        {
          date: "2024-01-15",
          duration_minutes: 480,
          sleep_minutes: 420,
          deep_pct: 15.456,
          rem_pct: 20.789,
          light_pct: 55.123,
          awake_pct: 8.632,
          efficiency: 88.567,
          rolling_avg_duration: null,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.sleepAnalytics({ days: 90 });

      expect(result.nightly[0]?.deepPct).toBe(15.5);
      expect(result.nightly[0]?.remPct).toBe(20.8);
      expect(result.nightly[0]?.lightPct).toBe(55.1);
      expect(result.nightly[0]?.awakePct).toBe(8.6);
      expect(result.nightly[0]?.efficiency).toBe(88.6);
    });

    it("returns null rolling average when not available", async () => {
      const rows = [
        {
          date: "2024-01-15",
          duration_minutes: 480,
          sleep_minutes: 420,
          deep_pct: 15,
          rem_pct: 20,
          light_pct: 55,
          awake_pct: 10,
          efficiency: 88,
          rolling_avg_duration: null,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.sleepAnalytics({ days: 90 });

      expect(result.nightly[0]?.rollingAvgDuration).toBeNull();
    });

    it("rounds rolling average to one decimal place", async () => {
      const rows = [
        {
          date: "2024-01-15",
          duration_minutes: 480,
          sleep_minutes: 420,
          deep_pct: 15,
          rem_pct: 20,
          light_pct: 55,
          awake_pct: 10,
          efficiency: 88,
          rolling_avg_duration: 425.678,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.sleepAnalytics({ days: 90 });

      expect(result.nightly[0]?.rollingAvgDuration).toBe(425.7);
    });

    it("returns empty analytics when no data", async () => {
      const caller = makeCaller([]);
      const result = await caller.sleepAnalytics({ days: 90 });
      expect(result.nightly).toEqual([]);
      expect(result.sleepDebt).toBe(0);
    });
  });

  describe("readinessScore", () => {
    it("computes readiness from metrics", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const rows = [
        {
          date: today,
          hrv: 65,
          resting_hr: 52,
          hrv_mean_60d: 60,
          hrv_sd_60d: 10,
          rhr_mean_60d: 55,
          rhr_sd_60d: 3,
          efficiency_pct: 90,
          acwr: 1.0,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.readinessScore({ days: 30 });

      expect(result.length).toBeGreaterThan(0);
      const firstRow = result[0];
      expect(firstRow.readinessScore).toBeGreaterThanOrEqual(0);
      expect(firstRow.readinessScore).toBeLessThanOrEqual(100);
      expect(firstRow.components).toHaveProperty("hrvScore");
      expect(firstRow.components).toHaveProperty("sleepScore");
    });

    it("uses default scores for null metrics", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const rows = [
        {
          date: today,
          hrv: null,
          resting_hr: null,
          hrv_mean_60d: null,
          hrv_sd_60d: null,
          rhr_mean_60d: null,
          rhr_sd_60d: null,
          efficiency_pct: null,
          acwr: null,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.readinessScore({ days: 30 });

      if (result.length > 0) {
        // All null defaults to 62 for each component (sigmoid center)
        expect(result[0]?.readinessScore).toBe(62);
        expect(result[0]?.components.hrvScore).toBe(62);
        expect(result[0]?.components.restingHrScore).toBe(62);
        expect(result[0]?.components.sleepScore).toBe(62);
        expect(result[0]?.components.respiratoryRateScore).toBe(62);
      }
    });

    it("computes respiratory rate score when data is available", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const rows = [
        {
          date: today,
          hrv: null,
          resting_hr: null,
          respiratory_rate: 14,
          hrv_mean_30d: null,
          hrv_sd_30d: null,
          rhr_mean_30d: null,
          rhr_sd_30d: null,
          rr_mean_30d: 15,
          rr_sd_30d: 1,
          efficiency_pct: null,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.readinessScore({ days: 30 });

      if (result.length > 0) {
        // Lower respiratory rate than baseline = better recovery
        expect(result[0]?.components.respiratoryRateScore).toBeGreaterThan(62);
      }
    });

    it("uses default respiratory rate score when data is partially null", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const rows = [
        {
          date: today,
          hrv: 60,
          resting_hr: 55,
          respiratory_rate: null,
          hrv_mean_30d: 60,
          hrv_sd_30d: 10,
          rhr_mean_30d: 55,
          rhr_sd_30d: 3,
          rr_mean_30d: 15,
          rr_sd_30d: 1,
          efficiency_pct: 90,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.readinessScore({ days: 30 });

      if (result.length > 0) {
        // Respiratory rate is null → default score 62
        expect(result[0]?.components.respiratoryRateScore).toBe(62);
      }
    });

    it("verifies all component scores are rounded", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const rows = [
        {
          date: today,
          hrv: 65,
          resting_hr: 52,
          respiratory_rate: 14,
          hrv_mean_30d: 60,
          hrv_sd_30d: 10,
          rhr_mean_30d: 55,
          rhr_sd_30d: 3,
          rr_mean_30d: 15,
          rr_sd_30d: 1,
          efficiency_pct: 85,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.readinessScore({ days: 30 });

      if (result.length > 0) {
        const components = result[0]?.components;
        expect(Number.isInteger(components?.hrvScore)).toBe(true);
        expect(Number.isInteger(components?.restingHrScore)).toBe(true);
        expect(Number.isInteger(components?.sleepScore)).toBe(true);
        expect(Number.isInteger(components?.respiratoryRateScore)).toBe(true);
      }
    });
  });
});

// ── Settings Router ──

describe("settingsRouter", () => {
  const createCaller = createTestCallerFactory(settingsRouter);

  describe("get", () => {
    it("returns setting value", async () => {
      const rows = [{ key: "theme", value: "dark" }];
      const execute = vi.fn().mockResolvedValue(rows);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.get({ key: "theme" });
      expect(result).toEqual({ key: "theme", value: "dark" });
      expectCallsUseNonEmptySql(execute);
    });

    it("returns null when setting not found", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.get({ key: "nonexistent" });
      expect(result).toBeNull();
    });
  });

  describe("getAll", () => {
    it("returns all settings", async () => {
      const rows = [
        { key: "theme", value: "dark" },
        { key: "units", value: "metric" },
      ];
      const execute = vi.fn().mockResolvedValue(rows);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.getAll();
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ key: "theme", value: "dark" });
      expect(result[1]).toEqual({ key: "units", value: "metric" });
      expectCallsUseNonEmptySql(execute);
    });
  });

  describe("set", () => {
    it("upserts a setting", async () => {
      const rows = [{ key: "theme", value: "light" }];
      const execute = vi.fn().mockResolvedValue(rows);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.set({ key: "theme", value: "light" });
      expect(result).toEqual({ key: "theme", value: "light" });
      expectCallsUseNonEmptySql(execute);
    });

    it("invalidates server-side settings cache after upsert", async () => {
      const rows = [{ key: "unitSystem", value: "imperial" }];
      const execute = vi.fn().mockResolvedValue(rows);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
      });
      await caller.set({ key: "unitSystem", value: "imperial" });
      expect(queryCache.invalidateByPrefix).toHaveBeenCalledWith("user-1:settings.");
    });

    it("throws when upsert fails", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });
      await expect(caller.set({ key: "theme", value: "dark" })).rejects.toThrow(
        "Failed to upsert setting",
      );
    });
  });

  describe("deleteAllUserData", () => {
    it("deletes provider and user-scoped data in one transaction", async () => {
      const txExecute = vi.fn().mockResolvedValue([]);
      const mockTransaction = vi
        .fn()
        .mockImplementation(async (fn: (tx: { execute: typeof txExecute }) => Promise<void>) => {
          await fn({ execute: txExecute });
        });

      const caller = createCaller({
        db: { execute: vi.fn(), transaction: mockTransaction },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.deleteAllUserData();
      expect(result).toEqual({ success: true });
      expect(mockTransaction).toHaveBeenCalledTimes(1);
      expect(txExecute).toHaveBeenCalledTimes(DISCONNECT_CHILD_TABLES.length + 4);
      expectCallsUseNonEmptySql(txExecute);
    });
  });

  describe("slackStatus", () => {
    const slackEnvKeys = [
      "SLACK_CLIENT_ID",
      "SLACK_SIGNING_SECRET",
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN",
    ] as const;

    function withCleanSlackEnv() {
      const previousValues = new Map<(typeof slackEnvKeys)[number], string | undefined>();
      for (const key of slackEnvKeys) {
        previousValues.set(key, process.env[key]);
      }

      for (const key of slackEnvKeys) {
        delete process.env[key];
      }

      return () => {
        for (const key of slackEnvKeys) {
          const value = previousValues.get(key);
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      };
    }

    it("returns slack status", async () => {
      const restoreEnv = withCleanSlackEnv();
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.slackStatus();
      expect(result).toHaveProperty("configured");
      expect(result).toHaveProperty("connected");
      expect(result.configured).toBe(false);
      expect(result.connected).toBe(false);
      restoreEnv();
    });

    it("returns connected when slack account exists", async () => {
      const rows = [{ provider_account_id: "slack-123" }];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.slackStatus();
      expect(result.connected).toBe(true);
    });

    it("returns configured when Socket Mode env vars are set", async () => {
      const restoreEnv = withCleanSlackEnv();
      try {
        process.env.SLACK_BOT_TOKEN = "xoxb-test";
        process.env.SLACK_APP_TOKEN = "xapp-test";
        const caller = createCaller({
          db: { execute: vi.fn().mockResolvedValue([]) },
          userId: "user-1",
          timezone: "UTC",
        });
        const result = await caller.slackStatus();
        expect(result.configured).toBe(true);
      } finally {
        restoreEnv();
      }
    });

    it("returns configured when OAuth env vars are set", async () => {
      const restoreEnv = withCleanSlackEnv();
      try {
        process.env.SLACK_CLIENT_ID = "client-id";
        process.env.SLACK_SIGNING_SECRET = "signing-secret";
        const caller = createCaller({
          db: { execute: vi.fn().mockResolvedValue([]) },
          userId: "user-1",
          timezone: "UTC",
        });
        const result = await caller.slackStatus();
        expect(result.configured).toBe(true);
      } finally {
        restoreEnv();
      }
    });

    it("requires both OAuth env vars", async () => {
      const restoreEnv = withCleanSlackEnv();
      try {
        process.env.SLACK_CLIENT_ID = "client-id";
        const caller = createCaller({
          db: { execute: vi.fn().mockResolvedValue([]) },
          userId: "user-1",
          timezone: "UTC",
        });
        const result = await caller.slackStatus();
        expect(result.configured).toBe(false);
      } finally {
        restoreEnv();
      }
    });

    it("requires both Socket Mode env vars", async () => {
      const restoreEnv = withCleanSlackEnv();
      try {
        process.env.SLACK_BOT_TOKEN = "xoxb-test";
        const caller = createCaller({
          db: { execute: vi.fn().mockResolvedValue([]) },
          userId: "user-1",
          timezone: "UTC",
        });
        const result = await caller.slackStatus();
        expect(result.configured).toBe(false);
      } finally {
        restoreEnv();
      }
    });
  });
});

// ── Sleep Need Router ──

describe("sleepNeedRouter", () => {
  const createCaller = createTestCallerFactory(sleepNeedRouter);

  describe("calculate", () => {
    it("returns default baseline when insufficient data", async () => {
      const rows = [
        {
          date: "2024-01-15",
          duration_minutes: 450,
          next_day_hrv: null,
          median_hrv: null,
          good_recovery: false,
          yesterday_load: 0,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.calculate({});

      expect(result.baselineMinutes).toBe(480); // default 8hr
      expect(result.totalNeedMinutes).toBeGreaterThanOrEqual(480);
    });

    it("computes personalized baseline from good nights", async () => {
      const rows = [];
      for (let i = 0; i < 20; i++) {
        rows.push({
          date: `2024-01-${String(i + 1).padStart(2, "0")}`,
          duration_minutes: 460,
          next_day_hrv: 65,
          median_hrv: 60,
          good_recovery: true,
          yesterday_load: 50,
        });
      }
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.calculate({});

      expect(result.baselineMinutes).toBe(460);
      expect(result.strainDebtMinutes).toBe(10); // 50/5 = 10
      expect(result.recentNights).toHaveLength(7);
    });

    it("handles empty data", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.calculate({});

      expect(result.baselineMinutes).toBe(480);
      expect(result.recentNights).toHaveLength(7);
      // All 7 nights should be null (calendar-based)
      for (const night of result.recentNights) {
        expect(night.actualMinutes).toBeNull();
        expect(night.debtMinutes).toBeNull();
      }
      expect(result.canRecommend).toBe(false);
    });

    it("always returns exactly 7 recent nights even with sparse data", async () => {
      // endDate=2026-03-15, yesterday=2026-03-14
      const rows = [
        {
          date: "2026-03-14",
          duration_minutes: 420,
          next_day_hrv: 60,
          median_hrv: 55,
          good_recovery: true,
          yesterday_load: 0,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.calculate({ endDate: "2026-03-15" });

      expect(result.recentNights).toHaveLength(7);
      // 6 nights should have null actualMinutes, 1 should have data
      const withData = result.recentNights.filter((n) => n.actualMinutes !== null);
      const withoutData = result.recentNights.filter((n) => n.actualMinutes === null);
      expect(withData).toHaveLength(1);
      expect(withoutData).toHaveLength(6);
    });

    it("sets canRecommend=true when yesterday has sleep data", async () => {
      // endDate=2026-03-15, yesterday=2026-03-14
      const rows = [
        {
          date: "2026-03-14",
          duration_minutes: 450,
          next_day_hrv: null,
          median_hrv: null,
          good_recovery: false,
          yesterday_load: 0,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.calculate({ endDate: "2026-03-15" });

      expect(result.canRecommend).toBe(true);
    });

    it("sets canRecommend=false when yesterday has no sleep data", async () => {
      // endDate=2026-03-15, yesterday=2026-03-14 — data only from 2026-03-12
      const rows = [
        {
          date: "2026-03-12",
          duration_minutes: 450,
          next_day_hrv: null,
          median_hrv: null,
          good_recovery: false,
          yesterday_load: 0,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.calculate({ endDate: "2026-03-15" });

      expect(result.canRecommend).toBe(false);
    });

    it("shows null nights with neededMinutes still set", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.calculate({ endDate: "2026-03-15" });

      // Even null nights should have neededMinutes (the baseline)
      for (const night of result.recentNights) {
        expect(night.neededMinutes).toBe(480);
      }
    });
  });
});

// ── Sport Settings Router ──

describe("sportSettingsRouter", () => {
  const createCaller = createTestCallerFactory(sportSettingsRouter);

  function makeCaller(rows: Record<string, unknown>[] = []) {
    return createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
      timezone: "UTC",
    });
  }

  describe("list", () => {
    it("returns sport settings", async () => {
      const rows = [{ sport: "cycling", ftp: 250 }];
      const caller = makeCaller(rows);
      const result = await caller.list();
      expect(result).toEqual(rows);
    });
  });

  describe("getBySport", () => {
    it("returns setting for sport", async () => {
      const rows = [{ sport: "cycling", ftp: 250 }];
      const caller = makeCaller(rows);
      const result = await caller.getBySport({ sport: "cycling" });
      expect(result).toEqual(rows[0]);
    });

    it("returns null when not found", async () => {
      const caller = makeCaller([]);
      const result = await caller.getBySport({ sport: "swimming" });
      expect(result).toBeNull();
    });
  });

  describe("history", () => {
    it("returns setting history for sport", async () => {
      const rows = [
        { sport: "cycling", ftp: 260, effective_from: "2024-02-01" },
        { sport: "cycling", ftp: 250, effective_from: "2024-01-01" },
      ];
      const caller = makeCaller(rows);
      const result = await caller.history({ sport: "cycling" });
      expect(result).toHaveLength(2);
    });
  });

  describe("upsert", () => {
    it("creates sport settings", async () => {
      const created = { sport: "cycling", ftp: 250 };
      const caller = makeCaller([created]);
      const result = await caller.upsert({ sport: "cycling", ftp: 250 });
      expect(result).toEqual(created);
    });
  });

  describe("delete", () => {
    it("deletes sport settings", async () => {
      const caller = makeCaller([]);
      const result = await caller.delete({
        id: "00000000-0000-0000-0000-000000000001",
      });
      expect(result).toEqual({ success: true });
    });
  });
});
