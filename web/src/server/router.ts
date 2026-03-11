import { router } from "../shared/trpc.ts";
import { activityRouter } from "./routers/activity.ts";
import { bodyRouter } from "./routers/body.ts";
import { dailyMetricsRouter } from "./routers/daily-metrics.ts";
import { insightsRouter } from "./routers/insights.ts";
import { lifeEventsRouter } from "./routers/life-events.ts";
import { nutritionRouter } from "./routers/nutrition.ts";
import { sleepRouter } from "./routers/sleep.ts";
import { supplementsRouter } from "./routers/supplements.ts";
import { syncRouter } from "./routers/sync.ts";

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
});

export type AppRouter = typeof appRouter;
