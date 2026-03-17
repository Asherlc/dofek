import { describe, expect, it, vi } from "vitest";

// Mock all sub-routers with minimal router shapes
const { mockRouter } = vi.hoisted(() => ({
  mockRouter: { _def: { procedures: {} } },
}));

vi.mock("./routers/activity.ts", () => ({ activityRouter: mockRouter }));
vi.mock("./routers/anomaly-detection.ts", () => ({ anomalyDetectionRouter: mockRouter }));
vi.mock("./routers/auth.ts", () => ({ authRouter: mockRouter }));
vi.mock("./routers/body.ts", () => ({ bodyRouter: mockRouter }));
vi.mock("./routers/body-analytics.ts", () => ({ bodyAnalyticsRouter: mockRouter }));
vi.mock("./routers/calendar.ts", () => ({ calendarRouter: mockRouter }));
vi.mock("./routers/cycling-advanced.ts", () => ({ cyclingAdvancedRouter: mockRouter }));
vi.mock("./routers/daily-metrics.ts", () => ({ dailyMetricsRouter: mockRouter }));
vi.mock("./routers/duration-curves.ts", () => ({ durationCurvesRouter: mockRouter }));
vi.mock("./routers/efficiency.ts", () => ({ efficiencyRouter: mockRouter }));
vi.mock("./routers/food.ts", () => ({ foodRouter: mockRouter }));
vi.mock("./routers/health-kit-sync.ts", () => ({ healthKitSyncRouter: mockRouter }));
vi.mock("./routers/healthspan.ts", () => ({ healthspanRouter: mockRouter }));
vi.mock("./routers/hiking.ts", () => ({ hikingRouter: mockRouter }));
vi.mock("./routers/insights.ts", () => ({ insightsRouter: mockRouter }));
vi.mock("./routers/intervals.ts", () => ({ intervalsRouter: mockRouter }));
vi.mock("./routers/life-events.ts", () => ({ lifeEventsRouter: mockRouter }));
vi.mock("./routers/nutrition.ts", () => ({ nutritionRouter: mockRouter }));
vi.mock("./routers/nutrition-analytics.ts", () => ({ nutritionAnalyticsRouter: mockRouter }));
vi.mock("./routers/pmc.ts", () => ({ pmcRouter: mockRouter }));
vi.mock("./routers/power.ts", () => ({ powerRouter: mockRouter }));
vi.mock("./routers/predictions.ts", () => ({ predictionsRouter: mockRouter }));
vi.mock("./routers/recovery.ts", () => ({ recoveryRouter: mockRouter }));
vi.mock("./routers/settings.ts", () => ({ settingsRouter: mockRouter }));
vi.mock("./routers/sleep.ts", () => ({ sleepRouter: mockRouter }));
vi.mock("./routers/sleep-need.ts", () => ({ sleepNeedRouter: mockRouter }));
vi.mock("./routers/sport-settings.ts", () => ({ sportSettingsRouter: mockRouter }));
vi.mock("./routers/strength.ts", () => ({ strengthRouter: mockRouter }));
vi.mock("./routers/stress.ts", () => ({ stressRouter: mockRouter }));
vi.mock("./routers/supplements.ts", () => ({ supplementsRouter: mockRouter }));
vi.mock("./routers/sync.ts", () => ({ syncRouter: mockRouter }));
vi.mock("./routers/system.ts", () => ({ systemRouter: mockRouter }));
vi.mock("./routers/training.ts", () => ({ trainingRouter: mockRouter }));
vi.mock("./routers/trends.ts", () => ({ trendsRouter: mockRouter }));
vi.mock("./routers/weekly-report.ts", () => ({ weeklyReportRouter: mockRouter }));
vi.mock("./routers/whoop-auth.ts", () => ({ whoopAuthRouter: mockRouter }));

// Mock trpc
vi.mock("./trpc.ts", async () => {
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

import type { AppRouter } from "./router.ts";
import { appRouter } from "./router.ts";

describe("appRouter", () => {
  it("is defined and exports AppRouter type", () => {
    expect(appRouter).toBeDefined();
    // Verify the router has _def with router metadata
    expect(appRouter._def).toBeDefined();
  });

  it("contains all expected sub-routers", () => {
    const _routerKeys = Object.keys(appRouter._def.procedures);
    // The merged router should have keys for each sub-router
    // Since we're using mock routers with empty procedures, check that it assembled
    expect(appRouter).toBeDefined();

    // Verify type is exported correctly
    const _typeCheck: AppRouter = appRouter;
    expect(_typeCheck).toBe(appRouter);
  });

  it("includes all 36 sub-routers in the definition", () => {
    const expectedRouters = [
      "activity",
      "anomalyDetection",
      "auth",
      "sleep",
      "sleepNeed",
      "dailyMetrics",
      "body",
      "bodyAnalytics",
      "nutrition",
      "nutritionAnalytics",
      "insights",
      "lifeEvents",
      "supplements",
      "sync",
      "system",
      "training",
      "trends",
      "calendar",
      "pmc",
      "power",
      "durationCurves",
      "efficiency",
      "food",
      "healthKitSync",
      "whoopAuth",
      "strength",
      "cyclingAdvanced",
      "hiking",
      "predictions",
      "recovery",
      "settings",
      "stress",
      "healthspan",
      "weeklyReport",
      "sportSettings",
      "intervals",
    ];

    // The router definition record should have entries for each sub-router
    const record = appRouter._def.record;
    for (const key of expectedRouters) {
      expect(record).toHaveProperty(key);
    }
    expect(Object.keys(record)).toHaveLength(expectedRouters.length);
  });
});
