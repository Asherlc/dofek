import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { computeInsights } from "../insights/engine.ts";
import {
  activityRowSchema,
  dailyRowSchema,
  nutritionRowSchema,
  sleepRowSchema,
} from "../insights/schemas.ts";
import {
  dateWindowStart,
  dateWindowStartString,
  timestampWindowStart,
} from "../lib/date-window.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { fetchBodyCompRows } from "./body-clickhouse.ts";
import { fetchRestingHeartRateRows } from "./resting-heart-rate-query.ts";

export class InsightsRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #timezone: string;
  readonly #sensorStore: Pick<ActivitySensorStore, "query">;

  constructor(
    db: Pick<Database, "execute">,
    userId: string,
    timezone: string,
    sensorStore: Pick<ActivitySensorStore, "query">,
  ) {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
    this.#sensorStore = sensorStore;
  }

  async computeInsights(days: number, endDate: string) {
    const [metricRows, restingHeartRateRows, sleep, activities, nutrition, bodyComp] =
      await Promise.all([
        this.#sensorStore.query(
          dailyRowSchema,
          `SELECT
            toString(daily_metrics.date) AS date,
            NULL AS resting_hr,
            hrv,
            spo2_avg,
            steps,
            active_energy_kcal,
            skin_temp_c
          FROM analytics.v_daily_metrics AS daily_metrics
          WHERE daily_metrics.user_id = {userId:UUID}
            AND daily_metrics.date > toDate({windowStart:String})
          ORDER BY daily_metrics.date ASC`,
          {
            userId: this.#userId,
            windowStart: dateWindowStartString(endDate, days),
          },
        ),
        fetchRestingHeartRateRows({
          sensorStore: this.#sensorStore,
          userId: this.#userId,
          timezone: this.#timezone,
          endDate,
          days,
        }),
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
        fetchBodyCompRows(this.#sensorStore, this.#userId, endDate, days),
      ]);

    const restingHeartRateByDate = new Map(
      restingHeartRateRows.map((row) => [row.date, row.resting_hr]),
    );
    const metrics = metricRows.map((row) => ({
      ...row,
      resting_hr: restingHeartRateByDate.get(row.date) ?? null,
    }));

    return computeInsights(metrics, sleep, activities, nutrition, bodyComp);
  }
}
