import { router } from "../shared/trpc.js";
import { activityRouter } from "./routers/activity.js";
import { bodyRouter } from "./routers/body.js";
import { dailyMetricsRouter } from "./routers/daily-metrics.js";
import { insightsRouter } from "./routers/insights.js";
import { nutritionRouter } from "./routers/nutrition.js";
import { sleepRouter } from "./routers/sleep.js";

export const appRouter = router({
  activity: activityRouter,
  sleep: sleepRouter,
  dailyMetrics: dailyMetricsRouter,
  body: bodyRouter,
  nutrition: nutritionRouter,
  insights: insightsRouter,
});

export type AppRouter = typeof appRouter;
