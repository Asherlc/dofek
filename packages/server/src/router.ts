import { activityRouter } from "./routers/activity.ts";
import { anomalyDetectionRouter } from "./routers/anomaly-detection.ts";
import { bodyRouter } from "./routers/body.ts";
import { bodyAnalyticsRouter } from "./routers/body-analytics.ts";
import { calendarRouter } from "./routers/calendar.ts";
import { cyclingAdvancedRouter } from "./routers/cycling-advanced.ts";
import { dailyMetricsRouter } from "./routers/daily-metrics.ts";
import { efficiencyRouter } from "./routers/efficiency.ts";
import { foodRouter } from "./routers/food.ts";
import { healthKitSyncRouter } from "./routers/health-kit-sync.ts";
import { hikingRouter } from "./routers/hiking.ts";
import { insightsRouter } from "./routers/insights.ts";
import { lifeEventsRouter } from "./routers/life-events.ts";
import { nutritionRouter } from "./routers/nutrition.ts";
import { nutritionAnalyticsRouter } from "./routers/nutrition-analytics.ts";
import { pmcRouter } from "./routers/pmc.ts";
import { powerRouter } from "./routers/power.ts";
import { predictionsRouter } from "./routers/predictions.ts";
import { recoveryRouter } from "./routers/recovery.ts";
import { settingsRouter } from "./routers/settings.ts";
import { sleepRouter } from "./routers/sleep.ts";
import { strengthRouter } from "./routers/strength.ts";
import { supplementsRouter } from "./routers/supplements.ts";
import { syncRouter } from "./routers/sync.ts";
import { trainingRouter } from "./routers/training.ts";
import { whoopAuthRouter } from "./routers/whoop-auth.ts";
import { router } from "./trpc.ts";

export const appRouter = router({
  activity: activityRouter,
  anomalyDetection: anomalyDetectionRouter,
  sleep: sleepRouter,
  dailyMetrics: dailyMetricsRouter,
  body: bodyRouter,
  bodyAnalytics: bodyAnalyticsRouter,
  nutrition: nutritionRouter,
  nutritionAnalytics: nutritionAnalyticsRouter,
  insights: insightsRouter,
  lifeEvents: lifeEventsRouter,
  supplements: supplementsRouter,
  sync: syncRouter,
  training: trainingRouter,
  calendar: calendarRouter,
  pmc: pmcRouter,
  power: powerRouter,
  efficiency: efficiencyRouter,
  food: foodRouter,
  healthKitSync: healthKitSyncRouter,
  whoopAuth: whoopAuthRouter,
  strength: strengthRouter,
  cyclingAdvanced: cyclingAdvancedRouter,
  hiking: hikingRouter,
  predictions: predictionsRouter,
  recovery: recoveryRouter,
  settings: settingsRouter,
});

export type AppRouter = typeof appRouter;
