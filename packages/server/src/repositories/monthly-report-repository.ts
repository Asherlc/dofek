import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import type { MonthSummary, MonthlyReportResult } from "../routers/monthly-report.ts";

// ---------------------------------------------------------------------------
// Zod schema for raw DB rows
// ---------------------------------------------------------------------------

const monthRowSchema = z.object({
  month_start: dateStringSchema,
  training_hours: z.coerce.number(),
  activity_count: z.coerce.number(),
  avg_daily_strain: z.coerce.number(),
  avg_sleep_minutes: z.coerce.number(),
  avg_resting_hr: z.coerce.number().nullable(),
  avg_hrv: z.coerce.number().nullable(),
});

type MonthRowData = z.infer<typeof monthRowSchema>;

// ---------------------------------------------------------------------------
// Domain model
// ---------------------------------------------------------------------------

/** A single month's raw aggregated data with computed getters and trend logic. */
export class MonthRow {
  readonly #row: MonthRowData;

  constructor(row: MonthRowData) {
    this.#row = row;
  }

  get monthStart(): string {
    return this.#row.month_start;
  }

  get trainingHours(): number {
    return Math.round(Number(this.#row.training_hours) * 10) / 10;
  }

  get activityCount(): number {
    return Number(this.#row.activity_count);
  }

  get avgDailyStrain(): number {
    return Math.round(Number(this.#row.avg_daily_strain) * 10) / 10;
  }

  get avgSleepMinutes(): number {
    return Math.round(Number(this.#row.avg_sleep_minutes));
  }

  get avgRestingHr(): number | null {
    return this.#row.avg_resting_hr != null
      ? Math.round(Number(this.#row.avg_resting_hr) * 10) / 10
      : null;
  }

  get avgHrv(): number | null {
    return this.#row.avg_hrv != null ? Math.round(Number(this.#row.avg_hrv) * 10) / 10 : null;
  }

  /** Compute month-over-month % change relative to a previous month. */
  toSummary(prev?: MonthRow): MonthSummary {
    const prevTrainingHours = prev ? prev.trainingHours : null;
    const prevAvgSleep = prev ? prev.avgSleepMinutes : null;

    return {
      monthStart: this.monthStart,
      trainingHours: this.trainingHours,
      activityCount: this.activityCount,
      avgDailyStrain: this.avgDailyStrain,
      avgSleepMinutes: this.avgSleepMinutes,
      avgRestingHr: this.avgRestingHr,
      avgHrv: this.avgHrv,
      trainingHoursTrend:
        prevTrainingHours != null && prevTrainingHours > 0
          ? Math.round(((this.trainingHours - prevTrainingHours) / prevTrainingHours) * 1000) / 10
          : null,
      avgSleepTrend:
        prevAvgSleep != null && prevAvgSleep > 0
          ? Math.round(((this.avgSleepMinutes - prevAvgSleep) / prevAvgSleep) * 1000) / 10
          : null,
    };
  }
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class MonthlyReportRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;

  constructor(db: Pick<Database, "execute">, userId: string) {
    this.#db = db;
    this.#userId = userId;
  }

  async getReport(months: number): Promise<MonthlyReportResult> {
    const rows = await executeWithSchema(
      this.#db,
      monthRowSchema,
      sql`WITH per_activity AS (
            SELECT
              a.started_at::date AS date,
              EXTRACT(EPOCH FROM (a.ended_at - a.started_at)) / 3600.0 AS hours,
              EXTRACT(EPOCH FROM (a.ended_at - a.started_at)) / 60.0
                * a.avg_hr / NULLIF(a.max_hr, 0) AS load
            FROM fitness.activity_summary a
            WHERE a.user_id = ${this.#userId}
              AND a.started_at >= date_trunc('month', CURRENT_DATE) - (${months}::int || ' months')::interval
              AND a.ended_at IS NOT NULL
              AND a.avg_hr IS NOT NULL
          ),
          daily_training AS (
            SELECT date, SUM(hours) AS hours, COUNT(*) AS count, SUM(load) AS load
            FROM per_activity
            GROUP BY date
          ),
          sleep_daily AS (
            SELECT
              started_at::date AS date,
              duration_minutes
            FROM fitness.v_sleep
            WHERE user_id = ${this.#userId}
              AND is_nap = false
              AND started_at >= date_trunc('month', CURRENT_DATE) - (${months}::int || ' months')::interval
          ),
          metrics_daily AS (
            SELECT date, resting_hr, hrv
            FROM fitness.v_daily_metrics
            WHERE user_id = ${this.#userId}
              AND date >= date_trunc('month', CURRENT_DATE) - (${months}::int || ' months')::interval
          )
          SELECT
            date_trunc('month', d.date)::date AS month_start,
            COALESCE(SUM(dt.hours), 0) AS training_hours,
            COALESCE(SUM(dt.count), 0)::int AS activity_count,
            COALESCE(AVG(dt.load), 0) AS avg_daily_strain,
            COALESCE(AVG(sl.duration_minutes), 0) AS avg_sleep_minutes,
            AVG(m.resting_hr) AS avg_resting_hr,
            AVG(m.hrv) AS avg_hrv
          FROM generate_series(
            date_trunc('month', CURRENT_DATE) - (${months}::int || ' months')::interval,
            CURRENT_DATE,
            '1 day'::interval
          ) AS d(date)
          LEFT JOIN daily_training dt ON dt.date = d.date::date
          LEFT JOIN sleep_daily sl ON sl.date = d.date::date
          LEFT JOIN metrics_daily m ON m.date = d.date::date
          GROUP BY date_trunc('month', d.date)
          ORDER BY month_start ASC`,
    );

    const monthRows = rows.map((row) => new MonthRow(row));
    const summaries = monthRows.map((monthRow, index) => {
      const prev = index > 0 ? monthRows[index - 1] : undefined;
      return monthRow.toSummary(prev);
    });

    const current = summaries.length > 0 ? (summaries[summaries.length - 1] ?? null) : null;
    const history = summaries.slice(0, -1);

    return { current, history };
  }
}
