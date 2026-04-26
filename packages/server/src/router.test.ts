import { describe, expect, it, vi } from "vitest";

// Mock all sub-routers with minimal router shapes
const { mockRouter } = vi.hoisted(() => ({
  mockRouter: { _def: { procedures: {} } },
}));

vi.mock("./routers/inertial-measurement-unit.ts", () => ({
  inertialMeasurementUnitRouter: mockRouter,
}));
vi.mock("./routers/inertial-measurement-unit-sync.ts", () => ({
  inertialMeasurementUnitSyncRouter: mockRouter,
}));
vi.mock("./routers/activity.ts", () => ({ activityRouter: mockRouter }));
vi.mock("./routers/activity-recording.ts", () => ({ activityRecordingRouter: mockRouter }));
vi.mock("./routers/anomaly-detection.ts", () => ({ anomalyDetectionRouter: mockRouter }));
vi.mock("./routers/auth.ts", () => ({ authRouter: mockRouter }));
vi.mock("./routers/behavior-impact.ts", () => ({ behaviorImpactRouter: mockRouter }));
vi.mock("./routers/breathwork.ts", () => ({ breathworkRouter: mockRouter }));
vi.mock("./routers/body.ts", () => ({ bodyRouter: mockRouter }));
vi.mock("./routers/body-analytics.ts", () => ({ bodyAnalyticsRouter: mockRouter }));
vi.mock("./routers/calendar.ts", () => ({ calendarRouter: mockRouter }));
vi.mock("./routers/correlation.ts", () => ({ correlationRouter: mockRouter }));
vi.mock("./routers/credential-auth.ts", () => ({ credentialAuthRouter: mockRouter }));
vi.mock("./routers/cycling-advanced.ts", () => ({ cyclingAdvancedRouter: mockRouter }));
vi.mock("./routers/daily-metrics.ts", () => ({ dailyMetricsRouter: mockRouter }));
vi.mock("./routers/duration-curves.ts", () => ({ durationCurvesRouter: mockRouter }));
vi.mock("./routers/efficiency.ts", () => ({ efficiencyRouter: mockRouter }));
vi.mock("./routers/food.ts", () => ({ foodRouter: mockRouter }));
vi.mock("./routers/garmin-auth.ts", () => ({ garminAuthRouter: mockRouter }));
vi.mock("./routers/heart-rate.ts", () => ({ heartRateRouter: mockRouter }));
vi.mock("./routers/health-kit-sync.ts", () => ({ healthKitSyncRouter: mockRouter }));
vi.mock("./routers/health-report.ts", () => ({ healthReportRouter: mockRouter }));
vi.mock("./routers/healthspan.ts", () => ({ healthspanRouter: mockRouter }));
vi.mock("./routers/hiking.ts", () => ({ hikingRouter: mockRouter }));
vi.mock("./routers/insights.ts", () => ({ insightsRouter: mockRouter }));
vi.mock("./routers/intervals.ts", () => ({ intervalsRouter: mockRouter }));
vi.mock("./routers/journal.ts", () => ({ journalRouter: mockRouter }));
vi.mock("./routers/life-events.ts", () => ({ lifeEventsRouter: mockRouter }));
vi.mock("./routers/menstrual-cycle.ts", () => ({ menstrualCycleRouter: mockRouter }));
vi.mock("./routers/monthly-report.ts", () => ({ monthlyReportRouter: mockRouter }));
vi.mock("./routers/nutrition.ts", () => ({ nutritionRouter: mockRouter }));
vi.mock("./routers/nutrition-analytics.ts", () => ({ nutritionAnalyticsRouter: mockRouter }));
vi.mock("./routers/personalization.ts", () => ({ personalizationRouter: mockRouter }));
vi.mock("./routers/provider-detail.ts", () => ({ providerDetailRouter: mockRouter }));
vi.mock("./routers/provider-guide.ts", () => ({ providerGuideRouter: mockRouter }));
vi.mock("./routers/pmc.ts", () => ({ pmcRouter: mockRouter }));
vi.mock("./routers/power.ts", () => ({ powerRouter: mockRouter }));
vi.mock("./routers/predictions.ts", () => ({ predictionsRouter: mockRouter }));
vi.mock("./routers/recovery.ts", () => ({ recoveryRouter: mockRouter }));
vi.mock("./routers/running.ts", () => ({ runningRouter: mockRouter }));
vi.mock("./routers/settings.ts", () => ({ settingsRouter: mockRouter }));
vi.mock("./routers/sleep.ts", () => ({ sleepRouter: mockRouter }));
vi.mock("./routers/sleep-need.ts", () => ({ sleepNeedRouter: mockRouter }));
vi.mock("./routers/sport-settings.ts", () => ({ sportSettingsRouter: mockRouter }));
vi.mock("./routers/strength.ts", () => ({ strengthRouter: mockRouter }));
vi.mock("./routers/stress.ts", () => ({ stressRouter: mockRouter }));
vi.mock("./routers/supplements.ts", () => ({ supplementsRouter: mockRouter }));
vi.mock("./routers/sync.ts", () => ({ syncRouter: mockRouter }));
vi.mock("./routers/training.ts", () => ({ trainingRouter: mockRouter }));
vi.mock("./routers/trends.ts", () => ({ trendsRouter: mockRouter }));
vi.mock("./routers/weekly-report.ts", () => ({ weeklyReportRouter: mockRouter }));
vi.mock("./routers/whoop-auth.ts", () => ({ whoopAuthRouter: mockRouter }));
vi.mock("./routers/whoop-ble-sync.ts", () => ({ whoopBleSyncRouter: mockRouter }));
vi.mock("./routers/admin.ts", () => ({ adminRouter: mockRouter }));

// Mock trpc
vi.mock("./trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{ db: unknown; userId: string | null; timezone: string }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    adminProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
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

  it("includes all sub-routers in the definition", () => {
    const expectedRouters = [
      "admin",
      "inertialMeasurementUnit",
      "inertialMeasurementUnitSync",
      "activity",
      "activityRecording",
      "anomalyDetection",
      "auth",
      "behaviorImpact",
      "breathwork",
      "sleep",
      "sleepNeed",
      "dailyMetrics",
      "body",
      "bodyAnalytics",
      "nutrition",
      "nutritionAnalytics",
      "personalization",
      "insights",
      "lifeEvents",
      "supplements",
      "providerDetail",
      "providerGuide",
      "sync",
      "training",
      "trends",
      "calendar",
      "correlation",
      "credentialAuth",
      "pmc",
      "power",
      "durationCurves",
      "efficiency",
      "food",
      "garminAuth",
      "heartRate",
      "healthKitSync",
      "healthReport",
      "whoopAuth",
      "whoopBleSync",
      "strength",
      "cyclingAdvanced",
      "hiking",
      "predictions",
      "recovery",
      "running",
      "settings",
      "stress",
      "healthspan",
      "menstrualCycle",
      "monthlyReport",
      "weeklyReport",
      "sportSettings",
      "intervals",
      "journal",
    ];

    // The router definition record should have entries for each sub-router
    const record = appRouter._def.record;
    for (const key of expectedRouters) {
      expect(record).toHaveProperty(key);
    }
    expect(Object.keys(record)).toHaveLength(expectedRouters.length);
  });
});
