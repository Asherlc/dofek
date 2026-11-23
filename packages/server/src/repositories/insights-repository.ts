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
  clickHouseWindowStartPredicate,
  dateWindowEnd,
  dateWindowStartPredicate,
  dateWindowStartStringOrUndefined,
  type RangeDays,
} from "../lib/date-window.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { fetchBodyCompRows } from "./body-clickhouse.ts";
import { fetchSleepNights } from "./clickhouse-sleep-repository.ts";
import {
  dailyMetricsSpo2QueryParams,
  dailyMetricsWithSpo2ClickHouseCte,
} from "./daily-metrics-spo2-query.ts";
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

  async computeInsights(days: RangeDays, endDate: string) {
    const metricWindowStart = dateWindowStartStringOrUndefined(endDate, days);
    const activityDate = sql`(started_at AT TIME ZONE ${this.#timezone})::date`;
    const [metricRows, restingHeartRateRows, sleep, activities, nutrition, bodyComp] =
      await Promise.all([
        this.#sensorStore.query(
          dailyRowSchema,
          `WITH ${dailyMetricsWithSpo2ClickHouseCte(days !== null)} SELECT
            toString(daily_metrics.date) AS date,
            NULL AS resting_hr,
            hrv,
            spo2_avg,
            steps,
            skin_temp_c
          FROM daily_metrics
          WHERE daily_metrics.user_id = {userId:UUID}
            ${clickHouseWindowStartPredicate({ expression: "daily_metrics.date", days })}
          ORDER BY daily_metrics.date ASC`,
          {
            ...dailyMetricsSpo2QueryParams({
              userId: this.#userId,
              timezone: this.#timezone,
              endDate,
              days,
            }),
            userId: this.#userId,
            ...(metricWindowStart !== undefined ? { windowStart: metricWindowStart } : {}),
          },
        ),
        fetchRestingHeartRateRows({
          sensorStore: this.#sensorStore,
          userId: this.#userId,
          timezone: this.#timezone,
          endDate,
          days,
        }),
        fetchSleepNights({
          sensorStore: this.#sensorStore,
          userId: this.#userId,
          timezone: this.#timezone,
          endDate,
          days,
          dateBasis: "wake",
          order: "asc",
        }).then((rows) =>
          rows.map((row) =>
            sleepRowSchema.parse({
              date: row.date,
              started_at: row.started_at,
              duration_minutes: row.duration_minutes,
              deep_minutes: row.deep_minutes,
              rem_minutes: row.rem_minutes,
              light_minutes: row.light_minutes,
              awake_minutes: row.awake_minutes,
              efficiency_pct: row.efficiency_pct,
              is_nap: false,
            }),
          ),
        ),
        executeWithSchema(
          this.#db,
          activityRowSchema,
          sql`SELECT ${activityDate} AS date, started_at, ended_at, canonical_type
            FROM fitness.v_activity
            WHERE user_id = ${this.#userId}
              ${dateWindowStartPredicate(activityDate, endDate, days)}
              AND ${activityDate} <= ${dateWindowEnd(endDate)}
            ORDER BY started_at ASC`,
        ),
        executeWithSchema(
          this.#db,
          nutritionRowSchema,
          sql`SELECT date, calories, protein_g, carbs_g, fat_g, fiber_g, water_ml
            FROM fitness.v_nutrition_daily
            WHERE user_id = ${this.#userId}
              AND resolution_status = 'available'
              ${dateWindowStartPredicate(sql`date`, endDate, days)}
              AND date <= ${dateWindowEnd(endDate)}
            ORDER BY date ASC`,
        ),
        fetchBodyCompRows(this.#sensorStore, this.#userId, this.#timezone, endDate, days),
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
