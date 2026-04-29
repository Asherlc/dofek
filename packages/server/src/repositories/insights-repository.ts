import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { computeInsights } from "../insights/engine.ts";
import {
  activityRowSchema,
  bodyCompRowSchema,
  dailyRowSchema,
  nutritionRowSchema,
  sleepRowSchema,
} from "../insights/schemas.ts";
import { dateWindowStart, timestampWindowStart } from "../lib/date-window.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";

export class InsightsRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;

  constructor(db: Pick<Database, "execute">, userId: string) {
    this.#db = db;
    this.#userId = userId;
  }

  async computeInsights(days: number, endDate: string) {
    const [metrics, sleep, activities, nutrition, bodyComp] = await Promise.all([
      executeWithSchema(
        this.#db,
        dailyRowSchema,
        sql`SELECT dm.date, drhr.resting_hr, dm.hrv, dm.spo2_avg, dm.steps, dm.active_energy_kcal, dm.skin_temp_c
            FROM fitness.v_daily_metrics dm
            LEFT JOIN fitness.derived_resting_heart_rate drhr
              ON drhr.user_id = dm.user_id
             AND drhr.date = dm.date
            WHERE dm.user_id = ${this.#userId}
              AND dm.date > ${dateWindowStart(endDate, days)}
            ORDER BY dm.date ASC`,
      ),
      executeWithSchema(
        this.#db,
        sleepRowSchema,
        sql`SELECT started_at, duration_minutes, deep_minutes, rem_minutes,
                   light_minutes, awake_minutes, efficiency_pct, is_nap
            FROM fitness.v_sleep
            WHERE user_id = ${this.#userId}
              AND started_at > ${timestampWindowStart(endDate, days)}
            ORDER BY started_at ASC`,
      ),
      executeWithSchema(
        this.#db,
        activityRowSchema,
        sql`SELECT started_at, ended_at, activity_type
            FROM fitness.v_activity
            WHERE user_id = ${this.#userId}
              AND started_at > ${timestampWindowStart(endDate, days)}
            ORDER BY started_at ASC`,
      ),
      executeWithSchema(
        this.#db,
        nutritionRowSchema,
        sql`SELECT date, calories, protein_g, carbs_g, fat_g, fiber_g, water_ml
            FROM fitness.v_nutrition_daily
            WHERE user_id = ${this.#userId}
              AND date > ${dateWindowStart(endDate, days)}
            ORDER BY date ASC`,
      ),
      executeWithSchema(
        this.#db,
        bodyCompRowSchema,
        sql`SELECT recorded_at, weight_kg, body_fat_pct
            FROM fitness.v_body_measurement
            WHERE user_id = ${this.#userId}
              AND recorded_at > ${timestampWindowStart(endDate, days)}
            ORDER BY recorded_at ASC`,
      ),
    ]);

    return computeInsights(metrics, sleep, activities, nutrition, bodyComp);
  }
}
