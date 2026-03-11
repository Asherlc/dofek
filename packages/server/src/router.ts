import { activityRouter } from "./routers/activity.ts";
import { bodyRouter } from "./routers/body.ts";
import { calendarRouter } from "./routers/calendar.ts";
import { dailyMetricsRouter } from "./routers/daily-metrics.ts";
import { efficiencyRouter } from "./routers/efficiency.ts";
import { insightsRouter } from "./routers/insights.ts";
import { lifeEventsRouter } from "./routers/life-events.ts";
import { nutritionRouter } from "./routers/nutrition.ts";
import { pmcRouter } from "./routers/pmc.ts";
import { powerRouter } from "./routers/power.ts";
import { sleepRouter } from "./routers/sleep.ts";
import { supplementsRouter } from "./routers/supplements.ts";
import { syncRouter } from "./routers/sync.ts";
import { trainingRouter } from "./routers/training.ts";
import { whoopAuthRouter } from "./routers/whoop-auth.ts";
import { router } from "./trpc.ts";

export const appRouter = router({
  activity: activityRouter,
  sleep: sleepRouter,
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
  whoopAuth: whoopAuthRouter,
});

export type AppRouter = typeof appRouter;
