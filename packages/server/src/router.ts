import type { inferRouterOutputs } from "@trpc/server";
import { accountErasureRouter } from "./routers/account-erasure.ts";
import { activityRouter } from "./routers/activity.ts";
import { activityRecordingRouter } from "./routers/activity-recording.ts";
import { adminRouter } from "./routers/admin.ts";
import { anomalyDetectionRouter } from "./routers/anomaly-detection.ts";
import { authRouter } from "./routers/auth.ts";
import { behaviorImpactRouter } from "./routers/behavior-impact.ts";
import { billingRouter } from "./routers/billing.ts";
import { bleHeartRateSyncRouter } from "./routers/ble-heart-rate-sync.ts";
import { bodyRouter } from "./routers/body.ts";
import { bodyAnalyticsRouter } from "./routers/body-analytics.ts";
import { calendarRouter } from "./routers/calendar.ts";
import { climbingRouter } from "./routers/climbing.ts";
import { companionPairingRouter } from "./routers/companion-pairing.ts";
import { companionTokenRouter } from "./routers/companion-token.ts";
import { correlationRouter } from "./routers/correlation.ts";
import { credentialAuthRouter } from "./routers/credential-auth.ts";
import { cyclingRouter } from "./routers/cycling.ts";
import { cyclingAdvancedRouter } from "./routers/cycling-advanced.ts";
import { dailyMetricsRouter } from "./routers/daily-metrics.ts";
import { durationCurvesRouter } from "./routers/duration-curves.ts";
import { efficiencyRouter } from "./routers/efficiency.ts";
import { fileUploadRouter } from "./routers/file-upload.ts";
import { foodRouter } from "./routers/food.ts";
import { garminAuthRouter } from "./routers/garmin-auth.ts";
import { healthKitSyncRouter } from "./routers/health-kit-sync.ts";
import { healthReportRouter } from "./routers/health-report.ts";
import { healthspanRouter } from "./routers/healthspan.ts";
import { heartRateRouter } from "./routers/heart-rate.ts";
import { hikingRouter } from "./routers/hiking.ts";
import { inertialMeasurementUnitSyncRouter } from "./routers/inertial-measurement-unit-sync.ts";
import { insightsRouter } from "./routers/insights.ts";
import { intervalsRouter } from "./routers/intervals.ts";
import { journalRouter } from "./routers/journal.ts";
import { lifeEventsRouter } from "./routers/life-events.ts";
import { mcpRouter } from "./routers/mcp.ts";
import { medicationDoseEventsRouter } from "./routers/medication-dose-events.ts";
import { menstrualCycleRouter } from "./routers/menstrual-cycle.ts";
import { mobileDashboardRouter } from "./routers/mobile-dashboard.ts";
import { monthlyReportRouter } from "./routers/monthly-report.ts";
import { nutritionRouter } from "./routers/nutrition.ts";
import { nutritionAnalyticsRouter } from "./routers/nutrition-analytics.ts";
import { personalExperimentsRouter } from "./routers/personal-experiments.ts";
import { personalizationRouter } from "./routers/personalization.ts";
import { pmcRouter } from "./routers/pmc.ts";
import { powerRouter } from "./routers/power.ts";
import { predictionsRouter } from "./routers/predictions.ts";
import { processingRouter } from "./routers/processing.ts";
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
import { subjectiveRouter } from "./routers/subjective.ts";
import { supplementsRouter } from "./routers/supplements.ts";
import { supportRouter } from "./routers/support.ts";
import { syncRouter } from "./routers/sync.ts";
import { todayPlanRouter } from "./routers/today-plan.ts";
import { tokenAuthRouter } from "./routers/token-auth.ts";
import { trainingRouter } from "./routers/training.ts";
import { trendsRouter } from "./routers/trends.ts";
import { watchAltitudeSyncRouter } from "./routers/watch-altitude-sync.ts";
import { weeklyReportRouter } from "./routers/weekly-report.ts";
import { whoopAuthRouter } from "./routers/whoop-auth.ts";
import { whoopBleSyncRouter } from "./routers/whoop-ble-sync.ts";
import { router } from "./trpc.ts";

const appRouterProcedures = {
  accountErasure: accountErasureRouter,
  admin: adminRouter,
  inertialMeasurementUnitSync: inertialMeasurementUnitSyncRouter,
  watchAltitudeSync: watchAltitudeSyncRouter,
  activity: activityRouter,
  activityRecording: activityRecordingRouter,
  anomalyDetection: anomalyDetectionRouter,
  behaviorImpact: behaviorImpactRouter,
  billing: billingRouter,
  bleHeartRateSync: bleHeartRateSyncRouter,
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
  personalExperiments: personalExperimentsRouter,
  mobileDashboard: mobileDashboardRouter,
  supplements: supplementsRouter,
  providerDetail: providerDetailRouter,
  providerGuide: providerGuideRouter,
  sync: syncRouter,
  training: trainingRouter,
  trends: trendsRouter,
  calendar: calendarRouter,
  climbing: climbingRouter,
  companionPairing: companionPairingRouter,
  companionToken: companionTokenRouter,
  correlation: correlationRouter,
  credentialAuth: credentialAuthRouter,
  tokenAuth: tokenAuthRouter,
  pmc: pmcRouter,
  power: powerRouter,
  durationCurves: durationCurvesRouter,
  efficiency: efficiencyRouter,
  food: foodRouter,
  fileUpload: fileUploadRouter,
  garminAuth: garminAuthRouter,
  heartRate: heartRateRouter,
  healthKitSync: healthKitSyncRouter,
  whoopAuth: whoopAuthRouter,
  whoopBleSync: whoopBleSyncRouter,
  strength: strengthRouter,
  cyclingAdvanced: cyclingAdvancedRouter,
  cycling: cyclingRouter,
  hiking: hikingRouter,
  predictions: predictionsRouter,
  processing: processingRouter,
  recovery: recoveryRouter,
  running: runningRouter,
  settings: settingsRouter,
  stress: stressRouter,
  subjective: subjectiveRouter,
  todayPlan: todayPlanRouter,
  healthReport: healthReportRouter,
  healthspan: healthspanRouter,
  menstrualCycle: menstrualCycleRouter,
  medicationDoseEvents: medicationDoseEventsRouter,
  mcp: mcpRouter,
  monthlyReport: monthlyReportRouter,
  weeklyReport: weeklyReportRouter,
  sportSettings: sportSettingsRouter,
  intervals: intervalsRouter,
  support: supportRouter,
};

export function createAppRouter(syncRouterOverride: typeof syncRouter) {
  return router({ ...appRouterProcedures, sync: syncRouterOverride });
}

export const appRouter = createAppRouter(syncRouter);

export type AppRouter = typeof appRouter;
export type AppRouterOutputs = inferRouterOutputs<AppRouter>;
