import { sql } from "drizzle-orm";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import { dateWindowEnd, dateWindowStartPredicate, type RangeDays } from "../lib/date-window.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";

export const recordedDailyMetricSchema = z.object({
  date: dateStringSchema,
  metric: z.enum(["weight", "resting_heart_rate", "sleep_duration_reported"]),
  value: z.number(),
  unit: z.string().nullable(),
  providerId: z.string(),
  sourceName: z.string().nullable(),
});
export type RecordedDailyMetric = z.infer<typeof recordedDailyMetricSchema>;

const GROUP_METRICS = {
  body: ["weight", "resting_heart_rate"],
  sleep: ["sleep_duration_reported"],
} as const;

const recordedRowSchema = z.object({
  date: dateStringSchema,
  metric: recordedDailyMetricSchema.shape.metric,
  value: z.number(),
  unit: z.string().nullable(),
  provider_id: z.string(),
  source_name: z.string().nullable(),
});

/**
 * Date-only observations from the daily metric catalog. Each exact local day and metric is resolved
 * independently by the metric's priority category, so no timestamp or episode is implied.
 */
export class DailyMetricsRecordedRepository extends BaseRepository {
  async listRecorded(
    group: "body" | "sleep",
    days: RangeDays,
    endDate: string,
  ): Promise<RecordedDailyMetric[]> {
    const rows = await this.query(
      recordedRowSchema,
      sql`WITH candidates AS (
            SELECT dm.date, dm.provider_id, dm.source_name, type.id AS metric, type.unit,
                   type.priority_category, value.value
            FROM fitness.daily_metric_value value
            JOIN fitness.daily_metrics dm ON dm.id = value.daily_metrics_id
            JOIN fitness.daily_metric_type type ON type.id = value.metric_type_id
            WHERE dm.user_id = ${this.userId}
              AND type.id IN (${sql.join(
                GROUP_METRICS[group].map((metric) => sql`${metric}`),
                sql`, `,
              )})
              ${dateWindowStartPredicate(sql`dm.date`, endDate, days)}
              AND dm.date <= ${dateWindowEnd(endDate)}
              ${this.dateAccessPredicate(sql`dm.date`)}
          ), ranked AS (
            SELECT candidate.*, row_number() OVER (
              PARTITION BY candidate.date, candidate.metric
              ORDER BY COALESCE(
                  CASE candidate.priority_category
                    WHEN 'body' THEN device.body_priority
                    WHEN 'sleep' THEN device.sleep_priority
                    ELSE device.recovery_priority END,
                  CASE candidate.priority_category
                    WHEN 'body' THEN provider.body_priority
                    WHEN 'sleep' THEN provider.sleep_priority
                    ELSE provider.recovery_priority END,
                  device.priority, provider.priority, 100),
                candidate.provider_id, COALESCE(candidate.source_name, '')
            ) AS rank
            FROM candidates candidate
            LEFT JOIN fitness.provider_priority provider ON provider.provider_id = candidate.provider_id
            LEFT JOIN LATERAL (
              SELECT body_priority, sleep_priority, recovery_priority, priority
              FROM fitness.device_priority
              WHERE provider_id = candidate.provider_id
                AND candidate.source_name LIKE source_name_pattern
              ORDER BY length(source_name_pattern) DESC LIMIT 1
            ) device ON true
          )
          SELECT date, metric, value, unit, provider_id, source_name
          FROM ranked WHERE rank = 1
          ORDER BY date, metric`,
    );
    return rows.map((row) => ({
      date: row.date,
      metric: row.metric,
      value: row.value,
      unit: row.unit,
      providerId: row.provider_id,
      sourceName: row.source_name,
    }));
  }
}
