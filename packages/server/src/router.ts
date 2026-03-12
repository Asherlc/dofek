import { activityRouter } from "./routers/activity.ts";
import { bodyRouter } from "./routers/body.ts";
import { calendarRouter } from "./routers/calendar.ts";
import { cyclingAdvancedRouter } from "./routers/cycling-advanced.ts";
import { dailyMetricsRouter } from "./routers/daily-metrics.ts";
import { efficiencyRouter } from "./routers/efficiency.ts";
import { foodRouter } from "./routers/food.ts";
import { healthKitSyncRouter } from "./routers/health-kit-sync.ts";
import { healthspanRouter } from "./routers/healthspan.ts";
import { hikingRouter } from "./routers/hiking.ts";
import { insightsRouter } from "./routers/insights.ts";
import { lifeEventsRouter } from "./routers/life-events.ts";
import { nutritionRouter } from "./routers/nutrition.ts";
import { pmcRouter } from "./routers/pmc.ts";
import { powerRouter } from "./routers/power.ts";
import { recoveryRouter } from "./routers/recovery.ts";
import { settingsRouter } from "./routers/settings.ts";
import { sleepRouter } from "./routers/sleep.ts";
import { sleepNeedRouter } from "./routers/sleep-need.ts";
import { strengthRouter } from "./routers/strength.ts";
import { stressRouter } from "./routers/stress.ts";
import { supplementsRouter } from "./routers/supplements.ts";
import { syncRouter } from "./routers/sync.ts";
import { trainingRouter } from "./routers/training.ts";
import { weeklyReportRouter } from "./routers/weekly-report.ts";
import { whoopAuthRouter } from "./routers/whoop-auth.ts";
import { router } from "./trpc.ts";

export const appRouter = router({
  activity: activityRouter,
  sleep: sleepRouter,
  sleepNeed: sleepNeedRouter,
  dailyMetrics: dailyMetricsRouter,
  body: bodyRouter,
  nutrition: nutritionRouter,
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
  recovery: recoveryRouter,
  settings: settingsRouter,
  stress: stressRouter,
  healthspan: healthspanRouter,
  weeklyReport: weeklyReportRouter,
});

export type AppRouter = typeof appRouter;
