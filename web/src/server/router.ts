import { router } from "../shared/trpc.js";
import { activityRouter } from "./routers/activity.js";
import { bodyRouter } from "./routers/body.js";
import { dailyMetricsRouter } from "./routers/daily-metrics.js";
import { insightsRouter } from "./routers/insights.js";
import { lifeEventsRouter } from "./routers/life-events.js";
import { nutritionRouter } from "./routers/nutrition.js";
import { sleepRouter } from "./routers/sleep.js";
import { supplementsRouter } from "./routers/supplements.js";

export const appRouter = router({
  activity: activityRouter,
  sleep: sleepRouter,
  dailyMetrics: dailyMetricsRouter,
  body: bodyRouter,
  nutrition: nutritionRouter,
  insights: insightsRouter,
  lifeEvents: lifeEventsRouter,
  supplements: supplementsRouter,
});

export type AppRouter = typeof appRouter;
