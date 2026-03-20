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

vi.mock("../lib/cache.ts", () => ({
  queryCache: {
    invalidateByPrefix: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../lib/typed-sql.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/typed-sql.ts")>();
  return {
    ...original,
    executeWithSchema: vi.fn(async (db: { execute: () => Promise<unknown[]> }) => db.execute()),
  };
});

import { queryCache } from "../lib/cache.ts";
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
    });
  });

  describe("workloadRatio", () => {
    it("returns workload ratio data", async () => {
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

      expect(result).toHaveLength(1);
      expect(result[0]?.workloadRatio).toBe(1.14);
    });

    it("handles null workload ratio", async () => {
      const rows = [
        { date: "2024-01-15", daily_load: 0, acute_load: 0, chronic_load: 0, workload_ratio: null },
      ];
      const caller = makeCaller(rows);
      const result = await caller.workloadRatio({ days: 90 });

      expect(result[0]?.workloadRatio).toBeNull();
    });
  });

  describe("sleepAnalytics", () => {
    it("computes sleep analytics with debt", async () => {
      const rows = Array.from({ length: 14 }, (_, i) => ({
        date: `2024-01-${String(i + 1).padStart(2, "0")}`,
        duration_minutes: 420,
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
      // 14 nights * (480 - 420) = 840 min debt
      expect(result.sleepDebt).toBe(840);
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
      const r = result[0];
      expect(r.readinessScore).toBeGreaterThanOrEqual(0);
      expect(r.readinessScore).toBeLessThanOrEqual(100);
      expect(r.components).toHaveProperty("hrvScore");
      expect(r.components).toHaveProperty("sleepScore");
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
        // All null defaults to 50 for each component
        expect(result[0]?.readinessScore).toBe(50);
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
      });
      const result = await caller.get({ key: "theme" });
      expect(result).toEqual({ key: "theme", value: "dark" });
      expectCallsUseNonEmptySql(execute);
    });

    it("returns null when setting not found", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
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
      });

      const result = await caller.deleteAllUserData();
      expect(result).toEqual({ success: true });
      expect(mockTransaction).toHaveBeenCalledTimes(1);
      expect(txExecute).toHaveBeenCalledTimes(DISCONNECT_CHILD_TABLES.length + 1 + 4);
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
      });
      const result = await caller.calculate();

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
      });
      const result = await caller.calculate();

      expect(result.baselineMinutes).toBe(460);
      expect(result.strainDebtMinutes).toBe(10); // 50/5 = 10
      expect(result.recentNights).toHaveLength(7);
    });

    it("handles empty data", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });
      const result = await caller.calculate();

      expect(result.baselineMinutes).toBe(480);
      expect(result.recentNights).toEqual([]);
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
