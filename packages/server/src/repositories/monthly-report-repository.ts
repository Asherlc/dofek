import { z } from "zod";
import {
  createReportEmptyState,
  type MonthlyReportEmptyState,
} from "../contracts/report-empty-state.ts";
import { monthlyReportRecovery } from "../contracts/report-recovery.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import {
  buildMonthlyDecisionSynthesis,
  type ReportDecisionSynthesis,
} from "./report-decision-synthesis.ts";
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MonthSummary {
  monthStart: string;
  trainingHours: number;
  activityCount: number;
  avgDailyStrain: number;
  avgSleepMinutes: number;
  avgRestingHr: number | null;
  avgHrv: number | null;
  /** Month-over-month % change in training hours (null for first month) */
  trainingHoursTrend: number | null;
  /** Month-over-month % change in avg sleep (null for first month) */
  avgSleepTrend: number | null;
}

export interface MonthlyReportResult {
  current: MonthSummary | null;
  history: MonthSummary[];
  /** Server-owned interpretation rendered identically by every client. */
  decisionSupport: ReportDecisionSynthesis | null;
  /** Canonical readiness and value-free preview when no report exists. */
  emptyState: MonthlyReportEmptyState;
}

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
  readonly #userId: string;
  readonly #sensorStore: ActivitySensorStore;

  constructor(userId: string, sensorStore: ActivitySensorStore) {
    this.#userId = userId;
    this.#sensorStore = sensorStore;
  }

  async getReport(months: number, endDate: string): Promise<MonthlyReportResult> {
    const recovery = monthlyReportRecovery(months, endDate);
    const { startDate } = recovery.range;
    const rows = await this.#sensorStore.query(
      monthRowSchema,
      `WITH per_activity AS (
        SELECT
          toDate(asum.started_at) AS date,
          dateDiff('second', asum.started_at, asum.ended_at) / 3600.0 AS hours,
          dateDiff('second', asum.started_at, asum.ended_at) / 60.0
            * asum.avg_hr / nullIf(toFloat64(asum.max_hr), 0) AS load
          FROM analytics.activity_summary asum
          WHERE asum.user_id = {userId:UUID}
            AND asum.started_at >= toDate({startDate:String})
            AND asum.started_at < toDate({endDate:String}) + INTERVAL 1 DAY
            AND asum.ended_at IS NOT NULL
            AND asum.avg_hr IS NOT NULL
      ),
      daily_training AS (
        SELECT date, sum(hours) AS hours, toInt32(count()) AS count, sum(load) AS load
        FROM per_activity
        GROUP BY date
      ),
      sleep_raw AS (
        SELECT date, duration_minutes
        FROM analytics.daily_sleep FINAL
        WHERE user_id = {userId:UUID}
          AND is_deleted = 0
          AND date >= toDate({startDate:String})
          AND date <= toDate({endDate:String})
      ),
      sleep_daily AS (
        SELECT date, max(duration_minutes) AS duration_minutes
        FROM sleep_raw
        GROUP BY date
      ),
      metrics_daily AS (
        SELECT
          recovery.date AS date,
          recovery.resting_hr AS resting_hr,
          recovery.hrv AS hrv
        FROM analytics.daily_recovery AS recovery FINAL
        WHERE recovery.user_id = {userId:UUID}
          AND recovery.is_deleted = 0
          AND recovery.date >= toDate({startDate:String})
          AND recovery.date <= toDate({endDate:String})
      ),
      date_series AS (
        SELECT toDate({startDate:String}) + INTERVAL number DAY AS date
        FROM numbers(toUInt64(dateDiff('day', toDate({startDate:String}), toDate({endDate:String})) + 1))
      ),
      monthly AS (
        SELECT
          toStartOfMonth(d.date) AS month_start,
          coalesce(sum(dt.hours), 0) AS training_hours,
          toInt32(coalesce(sum(dt.count), 0)) AS activity_count,
          coalesce(avg(dt.load), 0) AS avg_daily_strain,
          coalesce(avg(sl.duration_minutes), 0) AS avg_sleep_minutes,
          avg(m.resting_hr) AS avg_resting_hr,
          avg(m.hrv) AS avg_hrv,
          countIf(dt.date = d.date OR sl.date = d.date OR m.date = d.date) > 0 AS has_data
        FROM date_series AS d
        LEFT JOIN daily_training dt ON dt.date = d.date
        LEFT JOIN sleep_daily sl ON sl.date = d.date
        LEFT JOIN metrics_daily m ON m.date = d.date
        GROUP BY toStartOfMonth(d.date)
      ),
      monthly_with_report_presence AS (
        SELECT
          *,
          max(has_data) OVER () AS report_has_data
        FROM monthly
      )
      SELECT
        toString(month_start) AS month_start,
        training_hours,
        activity_count,
        avg_daily_strain,
        avg_sleep_minutes,
        avg_resting_hr,
        avg_hrv
      FROM monthly_with_report_presence
      WHERE report_has_data
      ORDER BY month_start ASC`,
      { userId: this.#userId, startDate, endDate },
    );

    const monthRows = rows.map((row) => new MonthRow(row));
    const summaries = monthRows.map((monthRow, index) => {
      const prev = index > 0 ? monthRows[index - 1] : undefined;
      return monthRow.toSummary(prev);
    });

    const current = summaries.length > 0 ? (summaries[summaries.length - 1] ?? null) : null;
    const history = summaries.slice(0, -1);

    const emptyState = createReportEmptyState("monthly");
    const decisionSupport = current ? buildMonthlyDecisionSynthesis(current, history) : null;
    return { current, history, decisionSupport, emptyState };
  }
}
