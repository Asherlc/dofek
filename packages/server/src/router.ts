import { activityRouter } from "./routers/activity.ts";
import { activityRecordingRouter } from "./routers/activity-recording.ts";
import { adminRouter } from "./routers/admin.ts";
import { anomalyDetectionRouter } from "./routers/anomaly-detection.ts";
import { authRouter } from "./routers/auth.ts";
import { behaviorImpactRouter } from "./routers/behavior-impact.ts";
import { billingRouter } from "./routers/billing.ts";
import { bodyRouter } from "./routers/body.ts";
import { bodyAnalyticsRouter } from "./routers/body-analytics.ts";
import { breathworkRouter } from "./routers/breathwork.ts";
import { calendarRouter } from "./routers/calendar.ts";
import { correlationRouter } from "./routers/correlation.ts";
import { credentialAuthRouter } from "./routers/credential-auth.ts";
import { cyclingAdvancedRouter } from "./routers/cycling-advanced.ts";
import { dailyMetricsRouter } from "./routers/daily-metrics.ts";
import { durationCurvesRouter } from "./routers/duration-curves.ts";
import { efficiencyRouter } from "./routers/efficiency.ts";
import { foodRouter } from "./routers/food.ts";
import { garminAuthRouter } from "./routers/garmin-auth.ts";
import { healthKitSyncRouter } from "./routers/health-kit-sync.ts";
import { healthReportRouter } from "./routers/health-report.ts";
import { healthspanRouter } from "./routers/healthspan.ts";
import { heartRateRouter } from "./routers/heart-rate.ts";
import { hikingRouter } from "./routers/hiking.ts";
import { inertialMeasurementUnitRouter } from "./routers/inertial-measurement-unit.ts";
import { inertialMeasurementUnitSyncRouter } from "./routers/inertial-measurement-unit-sync.ts";
import { insightsRouter } from "./routers/insights.ts";
import { intervalsRouter } from "./routers/intervals.ts";
import { journalRouter } from "./routers/journal.ts";
import { lifeEventsRouter } from "./routers/life-events.ts";
import { menstrualCycleRouter } from "./routers/menstrual-cycle.ts";
import { mobileDashboardRouter } from "./routers/mobile-dashboard.ts";
import { monthlyReportRouter } from "./routers/monthly-report.ts";
import { nutritionRouter } from "./routers/nutrition.ts";
import { nutritionAnalyticsRouter } from "./routers/nutrition-analytics.ts";
import { personalizationRouter } from "./routers/personalization.ts";
import { pmcRouter } from "./routers/pmc.ts";
import { powerRouter } from "./routers/power.ts";
import { predictionsRouter } from "./routers/predictions.ts";
import { providerDetailRouter } from "./routers/provider-detail.ts";
import { providerGuideRouter } from "./routers/provider-guide.ts";
import { recoveryRouter } from "./routers/recovery.ts";
import { runningRouter } from "./routers/running.ts";
import { settingsRouter } from "./routers/settings.ts";
import { sleepRouter } from "./routers/sleep.ts";
import { sleepNeedRouter } from "./routers/sleep-need.ts";
import { sportSettingsRouter } from "./routers/sport-settings.ts";
import { strengthRouter } from "./routers/strength.ts";
import { stressRouter } from "./routers/stress.ts";
import { supplementsRouter } from "./routers/supplements.ts";
import { syncRouter } from "./routers/sync.ts";
import { trainingRouter } from "./routers/training.ts";
import { trendsRouter } from "./routers/trends.ts";
import { weeklyReportRouter } from "./routers/weekly-report.ts";
import { whoopAuthRouter } from "./routers/whoop-auth.ts";
import { whoopBleSyncRouter } from "./routers/whoop-ble-sync.ts";
import { router } from "./trpc.ts";

export const appRouter = router({
  admin: adminRouter,
  inertialMeasurementUnit: inertialMeasurementUnitRouter,
  inertialMeasurementUnitSync: inertialMeasurementUnitSyncRouter,
  activity: activityRouter,
  activityRecording: activityRecordingRouter,
  anomalyDetection: anomalyDetectionRouter,
  behaviorImpact: behaviorImpactRouter,
  billing: billingRouter,
  breathwork: breathworkRouter,
  personalization: personalizationRouter,
  auth: authRouter,
  sleep: sleepRouter,
  sleepNeed: sleepNeedRouter,
  dailyMetrics: dailyMetricsRouter,
  body: bodyRouter,
  bodyAnalytics: bodyAnalyticsRouter,
  nutrition: nutritionRouter,
  nutritionAnalytics: nutritionAnalyticsRouter,
  insights: insightsRouter,
  journal: journalRouter,
  lifeEvents: lifeEventsRouter,
  supplements: supplementsRouter,
  providerDetail: providerDetailRouter,
  providerGuide: providerGuideRouter,
  sync: syncRouter,
  training: trainingRouter,
  trends: trendsRouter,
  calendar: calendarRouter,
  correlation: correlationRouter,
  credentialAuth: credentialAuthRouter,
  pmc: pmcRouter,
  power: powerRouter,
  durationCurves: durationCurvesRouter,
  efficiency: efficiencyRouter,
  food: foodRouter,
  garminAuth: garminAuthRouter,
  heartRate: heartRateRouter,
  healthKitSync: healthKitSyncRouter,
  whoopAuth: whoopAuthRouter,
  whoopBleSync: whoopBleSyncRouter,
  strength: strengthRouter,
  cyclingAdvanced: cyclingAdvancedRouter,
  hiking: hikingRouter,
  predictions: predictionsRouter,
  recovery: recoveryRouter,
  running: runningRouter,
  settings: settingsRouter,
  stress: stressRouter,
  healthReport: healthReportRouter,
  healthspan: healthspanRouter,
  menstrualCycle: menstrualCycleRouter,
  mobileDashboard: mobileDashboardRouter,
  monthlyReport: monthlyReportRouter,
  weeklyReport: weeklyReportRouter,
  sportSettings: sportSettingsRouter,
  intervals: intervalsRouter,
});

export type AppRouter = typeof appRouter;
