import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateWindowEnd } from "../lib/date-window.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { fetchDailySleepPerformanceNights } from "./clickhouse-sleep-repository.ts";
import { fetchRestingHeartRateValuesCte } from "./resting-heart-rate-query.ts";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface AnomalyRow {
  date: string;
  metric: string;
  value: number;
  baselineMean: number;
  baselineStddev: number;
  zScore: number;
  severity: "warning" | "alert";
}

export interface AnomalyCheckResult {
  anomalies: AnomalyRow[];
  checkedMetrics: string[];
}

// ---------------------------------------------------------------------------
// Zod schemas for raw DB rows
// ---------------------------------------------------------------------------

const anomalyCheckRowSchema = z.object({
  date: dateStringSchema.nullable(),
  resting_hr: z.coerce.number().nullable(),
  rhr_mean: z.coerce.number().nullable(),
  rhr_sd: z.coerce.number().nullable(),
  rhr_count: z.coerce.number().nullable(),
  hrv: z.coerce.number().nullable(),
  hrv_mean: z.coerce.number().nullable(),
  hrv_sd: z.coerce.number().nullable(),
  hrv_count: z.coerce.number().nullable(),
  duration_minutes: z.coerce.number().nullable(),
  sleep_mean: z.coerce.number().nullable(),
  sleep_sd: z.coerce.number().nullable(),
  sleep_count: z.coerce.number().nullable(),
});

const anomalyHistoryRowSchema = z.object({
  date: dateStringSchema.nullable(),
  resting_hr: z.coerce.number().nullable(),
  rhr_mean: z.coerce.number().nullable(),
  rhr_sd: z.coerce.number().nullable(),
  rhr_count: z.coerce.number().nullable(),
  hrv: z.coerce.number().nullable(),
  hrv_mean: z.coerce.number().nullable(),
  hrv_sd: z.coerce.number().nullable(),
  hrv_count: z.coerce.number().nullable(),
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_BASELINE_DAYS = 14;
const WARNING_THRESHOLD = 2;
const ALERT_THRESHOLD = 3;
const BASELINE_LOOKBACK_DAYS = 35;
const BASELINE_WINDOW_DAYS = 30;

function sleepStatsForDate(
  rows: { date: string; duration_minutes: number | null }[],
  targetDate: string,
) {
  const targetIndex = rows.findIndex((row) => row.date === targetDate);
  if (targetIndex < 0) {
    return {
      durationMinutes: null,
      mean: null,
      stddev: null,
      count: 0,
    };
  }
  const targetDuration = rows[targetIndex]?.duration_minutes ?? null;
  const baselineDurations = rows
    .slice(Math.max(0, targetIndex - BASELINE_WINDOW_DAYS), targetIndex)
    .map((row) => row.duration_minutes)
    .filter((duration): duration is number => duration != null);
  if (baselineDurations.length === 0) {
    return {
      durationMinutes: targetDuration,
      mean: null,
      stddev: null,
      count: 0,
    };
  }
  const mean =
    baselineDurations.reduce((sum, duration) => sum + duration, 0) / baselineDurations.length;
  const variance =
    baselineDurations.reduce((sum, duration) => sum + (duration - mean) ** 2, 0) /
    baselineDurations.length;
  return {
    durationMinutes: targetDuration,
    mean,
    stddev: Math.sqrt(variance),
    count: baselineDurations.length,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRestingHrAnomaly(
  date: string,
  restingHr: number,
  mean: number,
  stddev: number,
  zScore: number,
): AnomalyRow {
  return {
    date,
    metric: "Resting Heart Rate",
    value: restingHr,
    baselineMean: Math.round(mean * 10) / 10,
    baselineStddev: Math.round(stddev * 10) / 10,
    zScore: Math.round(zScore * 100) / 100,
    severity: zScore > ALERT_THRESHOLD ? "alert" : "warning",
  };
}

function buildHrvAnomaly(
  date: string,
  hrv: number,
  mean: number,
  stddev: number,
  zScore: number,
): AnomalyRow {
  return {
    date,
    metric: "Heart Rate Variability",
    value: hrv,
    baselineMean: Math.round(mean * 10) / 10,
    baselineStddev: Math.round(stddev * 10) / 10,
    zScore: Math.round(zScore * 100) / 100,
    severity: zScore < -ALERT_THRESHOLD ? "alert" : "warning",
  };
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for anomaly detection on daily health metrics. */
export class AnomalyDetectionRepository {
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

  /**
   * Check a single day's health metrics for anomalies by comparing against
   * a rolling 30-day baseline. Flags deviations beyond 2 standard deviations.
   */
  async check(endDate: string): Promise<AnomalyCheckResult> {
    const restingHeartRateCte = await fetchRestingHeartRateValuesCte({
      sensorStore: this.#sensorStore,
      userId: this.#userId,
      timezone: this.#timezone,
      endDate,
      days: BASELINE_LOOKBACK_DAYS,
    });
    const [rows, sleepRows] = await Promise.all([
      executeWithSchema(
        this.#db,
        anomalyCheckRowSchema,
        sql`WITH target_date AS (
	          SELECT ${dateWindowEnd(endDate)}::date AS date
	        ),
          ${restingHeartRateCte},
	        baseline AS (
	          SELECT
	            date,
	            resting_hr,
            AVG(resting_hr) OVER (ORDER BY date ROWS BETWEEN ${BASELINE_WINDOW_DAYS} PRECEDING AND 1 PRECEDING) AS rhr_mean,
            STDDEV_POP(resting_hr) OVER (ORDER BY date ROWS BETWEEN ${BASELINE_WINDOW_DAYS} PRECEDING AND 1 PRECEDING) AS rhr_sd,
            COUNT(resting_hr) OVER (ORDER BY date ROWS BETWEEN ${BASELINE_WINDOW_DAYS} PRECEDING AND 1 PRECEDING) AS rhr_count
	            FROM resting_heart_rate
	            ORDER BY date ASC
	          ),
          ranked_daily AS (
            SELECT
              d.*,
              COALESCE(dp.recovery_priority, pp.recovery_priority, dp.priority, pp.priority, 100) AS recovery_prio
            FROM fitness.daily_metrics d
            LEFT JOIN fitness.provider_priority pp ON pp.provider_id = d.provider_id
            LEFT JOIN LATERAL (
              SELECT dp2.recovery_priority, dp2.priority
              FROM fitness.device_priority dp2
              WHERE dp2.provider_id = d.provider_id
                AND d.source_name LIKE dp2.source_name_pattern
              ORDER BY length(dp2.source_name_pattern) DESC
              LIMIT 1
            ) dp ON true
            WHERE d.user_id = ${this.#userId}
              AND d.hrv IS NOT NULL
              AND d.date = ${dateWindowEnd(endDate)}
          ),
          target_hrv AS (
            SELECT date, user_id, provider_id, source_name, hrv
            FROM ranked_daily
            ORDER BY recovery_prio ASC, provider_id ASC, source_name ASC NULLS LAST
            LIMIT 1
          ),
          hrv_baseline AS (
            SELECT
              target.date,
              target.hrv,
              history.hrv_mean,
              history.hrv_sd,
              history.hrv_count
            FROM target_hrv target
            LEFT JOIN LATERAL (
              SELECT
                AVG(history_rows.hrv) AS hrv_mean,
                STDDEV_POP(history_rows.hrv) AS hrv_sd,
                COUNT(history_rows.hrv) AS hrv_count
              FROM (
                SELECT hrv
                FROM fitness.daily_metrics history
                WHERE history.user_id = target.user_id
                  AND history.provider_id = target.provider_id
                  AND history.source_name IS NOT DISTINCT FROM target.source_name
                  AND history.hrv IS NOT NULL
                  AND history.date < target.date
                  AND history.date > target.date - ${BASELINE_LOOKBACK_DAYS}::int
                ORDER BY history.date DESC
                LIMIT ${BASELINE_WINDOW_DAYS}
              ) history_rows
            ) history ON true
          )
          SELECT
            target_date.date::text,
            b.resting_hr, b.rhr_mean, b.rhr_sd, b.rhr_count,
            h.hrv, h.hrv_mean, h.hrv_sd, h.hrv_count,
            NULL::real AS duration_minutes,
            NULL::real AS sleep_mean,
            NULL::real AS sleep_sd,
            0::int AS sleep_count
          FROM target_date
          LEFT JOIN baseline b ON b.date = target_date.date
          LEFT JOIN hrv_baseline h ON h.date = target_date.date
          LIMIT 1`,
      ),
      fetchDailySleepPerformanceNights({
        sensorStore: this.#sensorStore,
        userId: this.#userId,
        endDate,
        days: BASELINE_LOOKBACK_DAYS,
      }),
    ]);

    const anomalies: AnomalyRow[] = [];
    const checkedMetrics: string[] = [];

    const row = rows[0];
    if (!row?.date) return { anomalies, checkedMetrics };

    const date = String(row.date);
    const sleepStats =
      sleepRows.length > 0
        ? sleepStatsForDate(sleepRows, date)
        : {
            durationMinutes: null,
            mean: null,
            stddev: null,
            count: 0,
          };

    // Check resting HR (higher = worse)
    if (
      row.resting_hr != null &&
      row.rhr_mean != null &&
      row.rhr_sd != null &&
      Number(row.rhr_sd) > 0 &&
      Number(row.rhr_count) >= MIN_BASELINE_DAYS
    ) {
      checkedMetrics.push("resting_hr");
      const zScore = (Number(row.resting_hr) - Number(row.rhr_mean)) / Number(row.rhr_sd);
      if (zScore > WARNING_THRESHOLD) {
        anomalies.push(
          buildRestingHrAnomaly(
            date,
            Number(row.resting_hr),
            Number(row.rhr_mean),
            Number(row.rhr_sd),
            zScore,
          ),
        );
      }
    }

    // Check HRV (lower = worse, so we check negative z-score)
    if (
      row.hrv != null &&
      row.hrv_mean != null &&
      row.hrv_sd != null &&
      Number(row.hrv_sd) > 0 &&
      Number(row.hrv_count) >= MIN_BASELINE_DAYS
    ) {
      checkedMetrics.push("hrv");
      const zScore = (Number(row.hrv) - Number(row.hrv_mean)) / Number(row.hrv_sd);
      if (zScore < -WARNING_THRESHOLD) {
        anomalies.push(
          buildHrvAnomaly(date, Number(row.hrv), Number(row.hrv_mean), Number(row.hrv_sd), zScore),
        );
      }
    }

    // Check sleep duration (shorter = worse)
    if (
      sleepStats.durationMinutes != null &&
      sleepStats.mean != null &&
      sleepStats.stddev != null &&
      sleepStats.stddev > 0 &&
      sleepStats.count >= MIN_BASELINE_DAYS
    ) {
      checkedMetrics.push("sleep_duration");
      const zScore = (sleepStats.durationMinutes - sleepStats.mean) / sleepStats.stddev;
      if (zScore < -WARNING_THRESHOLD) {
        anomalies.push({
          date,
          metric: "Sleep Duration",
          value: Math.round(sleepStats.durationMinutes),
          baselineMean: Math.round(sleepStats.mean),
          baselineStddev: Math.round(sleepStats.stddev),
          zScore: Math.round(zScore * 100) / 100,
          severity: zScore < -ALERT_THRESHOLD ? "alert" : "warning",
        });
      }
    }

    return { anomalies, checkedMetrics };
  }

  /**
   * Historical anomalies: check each day over a period for deviations.
   * Returns resting HR and HRV anomalies (no sleep) for dashboard markers.
   */
  async getHistory(days: number, endDate: string): Promise<AnomalyRow[]> {
    const queryDays = days + BASELINE_WINDOW_DAYS;
    const effectiveEndDate = endDate || new Date().toISOString().slice(0, 10);
    const restingHeartRateCte = await fetchRestingHeartRateValuesCte({
      sensorStore: this.#sensorStore,
      userId: this.#userId,
      timezone: this.#timezone,
      endDate: effectiveEndDate,
      days: queryDays,
    });
    const rows = await executeWithSchema(
      this.#db,
      anomalyHistoryRowSchema,
      sql`WITH ${restingHeartRateCte},
          baseline AS (
	          SELECT
	            date,
	            resting_hr,
            AVG(resting_hr) OVER (ORDER BY date ROWS BETWEEN ${BASELINE_WINDOW_DAYS} PRECEDING AND 1 PRECEDING) AS rhr_mean,
            STDDEV_POP(resting_hr) OVER (ORDER BY date ROWS BETWEEN ${BASELINE_WINDOW_DAYS} PRECEDING AND 1 PRECEDING) AS rhr_sd,
            COUNT(resting_hr) OVER (ORDER BY date ROWS BETWEEN ${BASELINE_WINDOW_DAYS} PRECEDING AND 1 PRECEDING) AS rhr_count
	            FROM resting_heart_rate
	            ORDER BY date ASC
	          ),
          ranked_daily AS (
            SELECT
              d.*,
              COALESCE(dp.recovery_priority, pp.recovery_priority, dp.priority, pp.priority, 100) AS recovery_prio,
              ROW_NUMBER() OVER (
                PARTITION BY d.date, d.user_id
                ORDER BY COALESCE(dp.recovery_priority, pp.recovery_priority, dp.priority, pp.priority, 100) ASC,
                         d.provider_id ASC,
                         d.source_name ASC NULLS LAST
              ) AS source_rank
            FROM fitness.daily_metrics d
            LEFT JOIN fitness.provider_priority pp ON pp.provider_id = d.provider_id
            LEFT JOIN LATERAL (
              SELECT dp2.recovery_priority, dp2.priority
              FROM fitness.device_priority dp2
              WHERE dp2.provider_id = d.provider_id
                AND d.source_name LIKE dp2.source_name_pattern
              ORDER BY length(dp2.source_name_pattern) DESC
              LIMIT 1
            ) dp ON true
            WHERE d.user_id = ${this.#userId}
              AND d.hrv IS NOT NULL
              AND d.date > ${dateWindowEnd(effectiveEndDate)}::date - ${queryDays}::int
          ),
          hrv_baseline AS (
            SELECT
              target.date,
              target.hrv,
              history.hrv_mean,
              history.hrv_sd,
              history.hrv_count
            FROM ranked_daily target
            LEFT JOIN LATERAL (
              SELECT
                AVG(history_rows.hrv) AS hrv_mean,
                STDDEV_POP(history_rows.hrv) AS hrv_sd,
                COUNT(history_rows.hrv) AS hrv_count
              FROM (
                SELECT hrv
                FROM fitness.daily_metrics history
                WHERE history.user_id = target.user_id
                  AND history.provider_id = target.provider_id
                  AND history.source_name IS NOT DISTINCT FROM target.source_name
                  AND history.hrv IS NOT NULL
                  AND history.date < target.date
                  AND history.date > target.date - ${BASELINE_LOOKBACK_DAYS}::int
                ORDER BY history.date DESC
                LIMIT ${BASELINE_WINDOW_DAYS}
              ) history_rows
            ) history ON true
            WHERE target.source_rank = 1
          ),
          dates AS (
            SELECT date FROM baseline
            UNION
            SELECT date FROM hrv_baseline
          )
          SELECT
            dates.date::text,
            b.resting_hr, b.rhr_mean, b.rhr_sd, b.rhr_count,
            h.hrv, h.hrv_mean, h.hrv_sd, h.hrv_count
          FROM dates
          LEFT JOIN baseline b ON b.date = dates.date
          LEFT JOIN hrv_baseline h ON h.date = dates.date
          WHERE dates.date > ${dateWindowEnd(effectiveEndDate)}::date - ${days}::int
          ORDER BY dates.date ASC`,
    );

    const anomalies: AnomalyRow[] = [];

    for (const row of rows) {
      if (!row.date) continue;
      const date = String(row.date);

      // Resting HR
      if (
        row.resting_hr != null &&
        row.rhr_mean != null &&
        row.rhr_sd != null &&
        Number(row.rhr_sd) > 0 &&
        Number(row.rhr_count) >= MIN_BASELINE_DAYS
      ) {
        const restingHrZScore =
          (Number(row.resting_hr) - Number(row.rhr_mean)) / Number(row.rhr_sd);
        if (restingHrZScore > WARNING_THRESHOLD) {
          anomalies.push(
            buildRestingHrAnomaly(
              date,
              Number(row.resting_hr),
              Number(row.rhr_mean),
              Number(row.rhr_sd),
              restingHrZScore,
            ),
          );
        }
      }

      // HRV
      if (
        row.hrv != null &&
        row.hrv_mean != null &&
        row.hrv_sd != null &&
        Number(row.hrv_sd) > 0 &&
        Number(row.hrv_count) >= MIN_BASELINE_DAYS
      ) {
        const hrvZScore = (Number(row.hrv) - Number(row.hrv_mean)) / Number(row.hrv_sd);
        if (hrvZScore < -WARNING_THRESHOLD) {
          anomalies.push(
            buildHrvAnomaly(
              date,
              Number(row.hrv),
              Number(row.hrv_mean),
              Number(row.hrv_sd),
              hrvZScore,
            ),
          );
        }
      }
    }

    return anomalies;
  }
}

// ---------------------------------------------------------------------------
// Standalone helpers (re-exported for use outside tRPC context)
// ---------------------------------------------------------------------------

/**
 * Check for anomalies in daily health metrics. Convenience wrapper around
 * the repository for callers that have a full Database handle.
 */
export async function checkAnomalies(
  db: Database,
  userId: string,
  timezone: string,
  endDate: string,
  sensorStore: Pick<ActivitySensorStore, "query">,
): Promise<AnomalyCheckResult> {
  const repo = new AnomalyDetectionRepository(db, userId, timezone, sensorStore);
  return repo.check(endDate);
}
