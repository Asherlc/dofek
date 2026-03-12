import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  setupTestDatabase,
  type TestContext,
} from "../../../../../src/db/__tests__/test-helpers.ts";
import { createApp } from "../../index.ts";

/**
 * Integration tests that verify every tRPC query endpoint executes valid SQL.
 * These catch: missing columns, nested aggregates, bad view references, etc.
 *
 * Each test fires the endpoint with default params and asserts no 500 error.
 * The database is empty — we're testing SQL validity, not data correctness.
 */
describe("Router SQL validity", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();
    const app = createApp(testCtx.db);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
    await testCtx?.cleanup();
  }, 30_000);

  /** Helper: POST a tRPC query and return parsed response */
  async function query(path: string, input: Record<string, unknown> = {}) {
    const res = await fetch(`${baseUrl}/api/trpc/${path}?batch=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ "0": input }),
    });
    const data = await res.json();
    return { status: res.status, result: data[0] };
  }

  /** Assert endpoint returns 200 with no error */
  async function expectValidSql(path: string, input: Record<string, unknown> = {}) {
    const { status, result } = await query(path, input);
    if (result.error) {
      throw new Error(`${path} returned SQL error: ${result.error.message}`);
    }
    expect(status).toBe(200);
    expect(result.result).toBeDefined();
  }

  // ── Daily Metrics ──
  describe("dailyMetrics", () => {
    it("list", () => expectValidSql("dailyMetrics.list", { days: 30 }));
    it("latest", () => expectValidSql("dailyMetrics.latest"));
    it("hrvBaseline", () => expectValidSql("dailyMetrics.hrvBaseline", { days: 30 }));
    it("trends", () => expectValidSql("dailyMetrics.trends", { days: 30 }));
  });

  // ── Sleep ──
  describe("sleep", () => {
    it("list", () => expectValidSql("sleep.list", { days: 30 }));
    it("latest", () => expectValidSql("sleep.latest"));
  });

  // ── Activity ──
  describe("activity", () => {
    it("list", () => expectValidSql("activity.list", { days: 30 }));
  });

  // ── Body ──
  describe("body", () => {
    it("list", () => expectValidSql("body.list", { days: 90 }));
  });

  // ── Nutrition ──
  describe("nutrition", () => {
    it("daily", () => expectValidSql("nutrition.daily", { days: 30 }));
  });

  // ── Food ──
  describe("food", () => {
    it("list", () =>
      expectValidSql("food.list", { startDate: "2025-01-01", endDate: "2025-01-31" }));
    it("byDate", () => expectValidSql("food.byDate", { date: "2025-01-15" }));
    it("dailyTotals", () => expectValidSql("food.dailyTotals", { days: 30 }));
    it("search", () => expectValidSql("food.search", { query: "test" }));
  });

  // ── Insights ──
  describe("insights", () => {
    it("compute", () => expectValidSql("insights.compute", { days: 30 }));
  });

  // ── Training ──
  describe("training", () => {
    it("weeklyVolume", () => expectValidSql("training.weeklyVolume", { days: 90 }));
    it("hrZones", () => expectValidSql("training.hrZones", { days: 90 }));
    it("activityStats", () => expectValidSql("training.activityStats", { days: 90 }));
  });

  // ── Power ──
  describe("power", () => {
    it("powerCurve", () => expectValidSql("power.powerCurve", { days: 90 }));
    it("eftpTrend", () => expectValidSql("power.eftpTrend", { days: 90 }));
  });

  // ── PMC ──
  describe("pmc", () => {
    it("chart", () => expectValidSql("pmc.chart", { days: 90 }));
  });

  // ── Efficiency ──
  describe("efficiency", () => {
    it("aerobicEfficiency", () => expectValidSql("efficiency.aerobicEfficiency", { days: 90 }));
    it("polarizationTrend", () => expectValidSql("efficiency.polarizationTrend", { days: 90 }));
  });

  // ── Cycling Advanced ──
  describe("cyclingAdvanced", () => {
    it("rampRate", () => expectValidSql("cyclingAdvanced.rampRate", { days: 90 }));
    it("trainingMonotony", () => expectValidSql("cyclingAdvanced.trainingMonotony", { days: 90 }));
    it("activityVariability", () =>
      expectValidSql("cyclingAdvanced.activityVariability", { days: 90 }));
    it("verticalAscentRate", () =>
      expectValidSql("cyclingAdvanced.verticalAscentRate", { days: 90 }));
  });

  // ── Hiking ──
  describe("hiking", () => {
    it("gradeAdjustedPace", () => expectValidSql("hiking.gradeAdjustedPace", { days: 90 }));
    it("elevationProfile", () => expectValidSql("hiking.elevationProfile", { days: 90 }));
    it("walkingBiomechanics", () => expectValidSql("hiking.walkingBiomechanics", { days: 90 }));
    it("activityComparison", () => expectValidSql("hiking.activityComparison", { days: 90 }));
  });

  // ── Recovery ──
  describe("recovery", () => {
    it("hrvVariability", () => expectValidSql("recovery.hrvVariability", { days: 30 }));
    it("workloadRatio", () => expectValidSql("recovery.workloadRatio", { days: 30 }));
    it("sleepAnalytics", () => expectValidSql("recovery.sleepAnalytics", { days: 30 }));
    it("readinessScore", () => expectValidSql("recovery.readinessScore", { days: 30 }));
  });

  // ── Strength ──
  describe("strength", () => {
    it("volumeOverTime", () => expectValidSql("strength.volumeOverTime", { days: 90 }));
    it("estimatedOneRepMax", () => expectValidSql("strength.estimatedOneRepMax", { days: 90 }));
    it("muscleGroupVolume", () => expectValidSql("strength.muscleGroupVolume", { days: 90 }));
    it("progressiveOverload", () => expectValidSql("strength.progressiveOverload", { days: 90 }));
    it("workoutSummary", () => expectValidSql("strength.workoutSummary", { days: 90 }));
  });

  // ── Calendar ──
  describe("calendar", () => {
    it("calendarData", () => expectValidSql("calendar.calendarData", { days: 30 }));
  });

  // ── Life Events ──
  describe("lifeEvents", () => {
    it("list", () => expectValidSql("lifeEvents.list", { days: 90 }));
  });

  // ── Sync ──
  describe("sync", () => {
    it("providers", () => expectValidSql("sync.providers"));
    it("providerStats", () => expectValidSql("sync.providerStats"));
    it("logs", () => expectValidSql("sync.logs", { limit: 10 }));
  });
});
