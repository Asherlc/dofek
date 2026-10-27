import { z } from "zod";
import type { ActivitySensorStore } from "./activity-repository.ts";

const trainingLoadQueryRowSchema = z.object({
  date: z.string(),
  daily_load: z.coerce.number(),
  acute_load_7d: z.coerce.number(),
  chronic_load_28d: z.coerce.number(),
  workload_ratio: z.coerce.number().nullable(),
  acute_coverage_days: z.coerce.number().int().min(1).max(7),
  chronic_coverage_days: z.coerce.number().int().min(1).max(28),
});

export interface TrainingLoadRow {
  date: string;
  daily_load: number;
  acute_load_7d: number;
  chronic_load_28d: number;
  workload_ratio: number | null;
  coverage: {
    acute_window_days: number;
    chronic_window_days: number;
  };
}

const trainingLoadRangeQuery = `
WITH first_date AS (
  SELECT min(date) AS first_observed
  FROM analytics.daily_strain FINAL
  WHERE user_id = {userId:UUID}
    AND is_deleted = 0
)
SELECT
  toString(strain.date) AS date,
  strain.daily_load AS daily_load,
  strain.acute_load_7d AS acute_load_7d,
  strain.chronic_load_28d AS chronic_load_28d,
  strain.workload_ratio AS workload_ratio,
  least(7, dateDiff('day', first_observed, strain.date) + 1) AS acute_coverage_days,
  least(28, dateDiff('day', first_observed, strain.date) + 1) AS chronic_coverage_days
FROM analytics.daily_strain AS strain FINAL
CROSS JOIN first_date
WHERE strain.user_id = {userId:UUID}
  AND strain.is_deleted = 0
  AND strain.date BETWEEN toDate({startDate:String}) AND toDate({endDate:String})
ORDER BY strain.date ASC`;

/** Rolling activity load from the canonical daily-strain read model. */
export class TrainingLoadRepository {
  readonly #store: Pick<ActivitySensorStore, "query">;
  readonly #userId: string;

  constructor(store: Pick<ActivitySensorStore, "query">, userId: string) {
    this.#store = store;
    this.#userId = userId;
  }

  async listRange(startDate: string, endDate: string): Promise<TrainingLoadRow[]> {
    const rows = await this.#store.query(trainingLoadQueryRowSchema, trainingLoadRangeQuery, {
      userId: this.#userId,
      startDate,
      endDate,
    });

    return rows.map((row) => ({
      date: row.date,
      daily_load: row.daily_load,
      acute_load_7d: row.acute_load_7d,
      chronic_load_28d: row.chronic_load_28d,
      workload_ratio: row.workload_ratio,
      coverage: {
        acute_window_days: row.acute_coverage_days,
        chronic_window_days: row.chronic_coverage_days,
      },
    }));
  }
}
