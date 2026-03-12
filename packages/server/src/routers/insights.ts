import { sql } from "drizzle-orm";
import { z } from "zod";
import type {
  ActivityRow,
  BodyCompRow,
  DailyRow,
  NutritionRow,
  SleepRow,
} from "../insights/engine.ts";
import { computeInsights } from "../insights/engine.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export const insightsRouter = router({
  compute: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }) => {
      const [metrics, sleep, activities, nutrition, bodyComp] = await Promise.all([
        ctx.db.execute<DailyRow>(
          sql`SELECT date, resting_hr, hrv, spo2_avg, steps, active_energy_kcal, skin_temp_c
              FROM fitness.v_daily_metrics
              WHERE user_id = ${ctx.userId}
                AND date > CURRENT_DATE - ${input.days}::int
              ORDER BY date ASC`,
        ),
        ctx.db.execute<SleepRow>(
          sql`SELECT started_at, duration_minutes, deep_minutes, rem_minutes,
                     light_minutes, awake_minutes, efficiency_pct, is_nap
              FROM fitness.v_sleep
              WHERE user_id = ${ctx.userId}
                AND started_at > CURRENT_DATE - ${input.days}::int
              ORDER BY started_at ASC`,
        ),
        ctx.db.execute<ActivityRow>(
          sql`SELECT started_at, ended_at, activity_type
              FROM fitness.v_activity
              WHERE user_id = ${ctx.userId}
                AND started_at > CURRENT_DATE - ${input.days}::int
              ORDER BY started_at ASC`,
        ),
        ctx.db.execute<NutritionRow>(
          sql`SELECT date, calories, protein_g, carbs_g, fat_g, fiber_g, water_ml
              FROM fitness.nutrition_daily
              WHERE user_id = ${ctx.userId}
                AND date > CURRENT_DATE - ${input.days}::int
              ORDER BY date ASC`,
        ),
        ctx.db.execute<BodyCompRow>(
          sql`SELECT recorded_at, weight_kg, body_fat_pct
              FROM fitness.v_body_measurement
              WHERE user_id = ${ctx.userId}
                AND recorded_at > CURRENT_DATE - ${input.days}::int
              ORDER BY recorded_at ASC`,
        ),
      ]);

      return computeInsights(metrics, sleep, activities, nutrition, bodyComp);
    }),
});
