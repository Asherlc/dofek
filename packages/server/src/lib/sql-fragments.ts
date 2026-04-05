import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { dateWindowEnd, dateWindowStart, timestampWindowStart } from "./date-window.ts";

// ---------------------------------------------------------------------------
// Sleep night date
// ---------------------------------------------------------------------------

/**
 * SQL expression for the calendar "night" a sleep session belongs to.
 *
 * Sleep that starts after midnight but before 6 AM is attributed to the
 * previous calendar day by subtracting 6 hours before casting to date:
 *
 *   10:00 PM → (−6 h = 4 PM same day)  → same date ✓
 *   12:30 AM → (−6 h = 6:30 PM prior)  → previous date ✓
 *    5:00 AM → (−6 h = 11 PM prior)    → previous date ✓
 *    7:00 AM → (−6 h = 1 AM same day)  → same date ✓
 *
 * @param timezone - IANA timezone string for the user (e.g., `"America/New_York"`)
 * @param column - Qualified or unqualified column expression
 *                 (default: `started_at`)
 */
export function sleepNightDate(timezone: string, column?: SQL): SQL {
  const col = column ?? sql`started_at`;
  return sql`((${col} AT TIME ZONE ${timezone}) - INTERVAL '6 hours')::date`;
}

// ---------------------------------------------------------------------------
// Sleep dedup CTE
// ---------------------------------------------------------------------------

/**
 * Reusable CTE that deduplicates sleep sessions to one per calendar night.
 *
 * Picks the longest non-nap session per calendar night (using `sleepNightDate`
 * to attribute pre-6 AM sessions to the previous day). Returns two named CTEs:
 * `sleep_raw` (all non-nap sessions with night date) and `sleep_deduped`
 * (one row per night, longest duration wins).
 *
 * Columns available from `sleep_deduped`:
 *   sleep_date, duration_minutes, deep_minutes, rem_minutes,
 *   light_minutes, awake_minutes, efficiency_pct, started_at, ended_at
 *
 * @example
 * ```ts
 * sql`WITH ${sleepDedupCte(userId, tz, endDate, 90)}
 *      SELECT sleep_date, duration_minutes FROM sleep_deduped`
 * ```
 */
export function sleepDedupCte(
  userId: string,
  timezone: string,
  endDate: string,
  days: number,
): SQL {
  return sql`sleep_raw AS (
    SELECT
      ${sleepNightDate(timezone)} AS sleep_date,
      duration_minutes,
      deep_minutes,
      rem_minutes,
      light_minutes,
      awake_minutes,
      efficiency_pct,
      started_at,
      ended_at,
      provider_id
    FROM fitness.v_sleep
    WHERE user_id = ${userId}
      AND is_nap = false
      AND started_at > ${timestampWindowStart(endDate, days)}
  ),
  sleep_deduped AS (
    SELECT DISTINCT ON (sleep_date)
      sleep_date,
      duration_minutes,
      deep_minutes,
      rem_minutes,
      light_minutes,
      awake_minutes,
      efficiency_pct,
      started_at,
      ended_at,
      provider_id
    FROM sleep_raw
    ORDER BY sleep_date, duration_minutes DESC NULLS LAST
  )`;
}

// ---------------------------------------------------------------------------
// Body weight dedup CTE
// ---------------------------------------------------------------------------

/**
 * Reusable CTE that deduplicates body measurements to one per calendar day.
 *
 * Picks the most recent measurement per local date from `v_body_measurement`.
 * Returns a single CTE named `weight_deduped`.
 *
 * Columns: date (text), weight_kg, body_fat_pct, recorded_at
 *
 * @param additionalFilter - Extra WHERE clause, e.g., `sql\`AND body_fat_pct IS NOT NULL\``
 */
export function bodyWeightDedupCte(
  userId: string,
  timezone: string,
  endDate: string,
  days: number,
  additionalFilter?: SQL,
): SQL {
  return sql`weight_deduped AS (
    SELECT DISTINCT ON (local_date)
      local_date::text AS date,
      weight_kg,
      body_fat_pct,
      recorded_at
    FROM (
      SELECT
        (recorded_at AT TIME ZONE ${timezone})::date AS local_date,
        weight_kg,
        body_fat_pct,
        recorded_at
      FROM fitness.v_body_measurement
      WHERE user_id = ${userId}
        AND weight_kg IS NOT NULL
        AND recorded_at > ${timestampWindowStart(endDate, days)}
        ${additionalFilter ?? sql``}
    ) weight_sub
    ORDER BY local_date, recorded_at DESC
  )`;
}

// ---------------------------------------------------------------------------
// ACWR (Acute:Chronic Workload Ratio) CTE
// ---------------------------------------------------------------------------

/**
 * Reusable CTE pipeline for Acute:Chronic Workload Ratio.
 *
 * Produces five CTEs: `acwr_date_series`, `acwr_per_activity`,
 * `acwr_activity_load`, `acwr_daily`, `acwr_with_windows`.
 *
 * The final CTE `acwr_with_windows` has columns:
 *   date, daily_load, acute_load, chronic_load_avg, chronic_count
 *
 * @param days - The output display window; internally adds 28 days for the
 *   chronic window warm-up.
 */
export function acwrCte(userId: string, timezone: string, endDate: string, days: number): SQL {
  const totalDays = days + 28;
  return sql`acwr_date_series AS (
    SELECT generate_series(
      ${dateWindowStart(endDate, totalDays)},
      ${dateWindowEnd(endDate)},
      '1 day'::interval
    )::date AS date
  ),
  acwr_per_activity AS (
    SELECT
      (asum.started_at AT TIME ZONE ${timezone})::date AS date,
      EXTRACT(EPOCH FROM (asum.ended_at - asum.started_at)) / 60.0
        * asum.avg_hr
        / NULLIF(asum.max_hr, 0) AS load
    FROM fitness.activity_summary asum
    WHERE asum.user_id = ${userId}
      AND (asum.started_at AT TIME ZONE ${timezone})::date >= ${dateWindowStart(endDate, totalDays)}
      AND asum.ended_at IS NOT NULL
      AND asum.avg_hr IS NOT NULL
  ),
  acwr_activity_load AS (
    SELECT date, SUM(load) AS daily_load
    FROM acwr_per_activity
    GROUP BY date
  ),
  acwr_daily AS (
    SELECT
      ds.date,
      COALESCE(al.daily_load, 0) AS daily_load
    FROM acwr_date_series ds
    LEFT JOIN acwr_activity_load al ON al.date = ds.date
  ),
  acwr_with_windows AS (
    SELECT
      date,
      daily_load,
      SUM(daily_load) OVER (ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS acute_load,
      AVG(daily_load) OVER (ORDER BY date ROWS BETWEEN 27 PRECEDING AND CURRENT ROW) AS chronic_load_avg,
      COUNT(*) OVER (ORDER BY date ROWS BETWEEN 27 PRECEDING AND CURRENT ROW) AS chronic_count
    FROM acwr_daily
  )`;
}

// ---------------------------------------------------------------------------
// Vitals baseline window CTE
// ---------------------------------------------------------------------------

/**
 * Reusable CTE that computes rolling AVG and STDDEV_POP window statistics
 * for daily vitals (HRV, resting HR, respiratory rate) from `v_daily_metrics`.
 *
 * Returns a single CTE named `vitals_baseline` with the raw metrics plus
 * rolling statistics columns named `{metric}_mean_{windowSize}d` and
 * `{metric}_stddev_{windowSize}d`.
 *
 * Always includes: date, hrv, resting_hr, respiratory_rate_avg.
 * Rolling stats columns depend on `windowSize`:
 *   hrv_mean_{N}d, hrv_stddev_{N}d,
 *   resting_hr_mean_{N}d, resting_hr_stddev_{N}d,
 *   respiratory_rate_mean_{N}d, respiratory_rate_stddev_{N}d
 *
 * @param windowSize - Number of preceding rows for the rolling window (e.g., 30 or 60).
 */
export function vitalsBaselineCte(
  userId: string,
  endDate: string,
  days: number,
  windowSize: number,
): SQL {
  const queryDays = days + windowSize;
  const preceding = windowSize - 1;
  return sql`vitals_baseline AS (
    SELECT
      date,
      hrv,
      resting_hr,
      respiratory_rate_avg,
      AVG(hrv) OVER (ORDER BY date ROWS BETWEEN ${sql.raw(String(preceding))} PRECEDING AND CURRENT ROW) AS ${sql.raw(`hrv_mean_${windowSize}d`)},
      STDDEV_POP(hrv) OVER (ORDER BY date ROWS BETWEEN ${sql.raw(String(preceding))} PRECEDING AND CURRENT ROW) AS ${sql.raw(`hrv_stddev_${windowSize}d`)},
      AVG(resting_hr) OVER (ORDER BY date ROWS BETWEEN ${sql.raw(String(preceding))} PRECEDING AND CURRENT ROW) AS ${sql.raw(`resting_hr_mean_${windowSize}d`)},
      STDDEV_POP(resting_hr) OVER (ORDER BY date ROWS BETWEEN ${sql.raw(String(preceding))} PRECEDING AND CURRENT ROW) AS ${sql.raw(`resting_hr_stddev_${windowSize}d`)},
      AVG(respiratory_rate_avg) OVER (ORDER BY date ROWS BETWEEN ${sql.raw(String(preceding))} PRECEDING AND CURRENT ROW) AS ${sql.raw(`respiratory_rate_mean_${windowSize}d`)},
      STDDEV_POP(respiratory_rate_avg) OVER (ORDER BY date ROWS BETWEEN ${sql.raw(String(preceding))} PRECEDING AND CURRENT ROW) AS ${sql.raw(`respiratory_rate_stddev_${windowSize}d`)}
    FROM fitness.v_daily_metrics
    WHERE user_id = ${userId}
      AND date > ${dateWindowStart(endDate, queryDays)}
    ORDER BY date ASC
  )`;
}

// ---------------------------------------------------------------------------
// Heart rate zone classification
// ---------------------------------------------------------------------------

/**
 * Build five `COUNT(*) FILTER (WHERE ...)` SQL expressions that classify
 * heart-rate samples into Karvonen zones.
 *
 * Each returned expression is a standalone SQL fragment you can embed in a
 * SELECT clause. Use `sql.raw()` aliases are NOT included — the caller
 * adds `AS zone1`, etc.
 *
 * @param heartRate   - SQL expression for the HR column (e.g., `sql\`ms.heart_rate\``)
 * @param maxHr       - SQL expression for the user's max HR
 * @param restingHr   - SQL expression for the user's resting HR
 * @param boundaries  - The 4-element HRR boundary array (e.g., [0.5, 0.6, 0.7, 0.8, 0.9] → 5 zones)
 */
export function heartRateZoneColumns(
  heartRate: SQL,
  maxHr: SQL,
  restingHr: SQL,
  boundaries: readonly number[],
): { zone1: SQL; zone2: SQL; zone3: SQL; zone4: SQL; zone5: SQL } {
  // Zone 1: below boundary[0]
  const zone1 = sql`COUNT(*) FILTER (WHERE ${heartRate} < ${restingHr} + (${maxHr} - ${restingHr}) * ${boundaries[0]}::numeric)::int`;

  // Zones 2-4: between consecutive boundaries
  const zone2 = sql`COUNT(*) FILTER (WHERE ${heartRate} >= ${restingHr} + (${maxHr} - ${restingHr}) * ${boundaries[0]}::numeric AND ${heartRate} < ${restingHr} + (${maxHr} - ${restingHr}) * ${boundaries[1]}::numeric)::int`;
  const zone3 = sql`COUNT(*) FILTER (WHERE ${heartRate} >= ${restingHr} + (${maxHr} - ${restingHr}) * ${boundaries[1]}::numeric AND ${heartRate} < ${restingHr} + (${maxHr} - ${restingHr}) * ${boundaries[2]}::numeric)::int`;
  const zone4 = sql`COUNT(*) FILTER (WHERE ${heartRate} >= ${restingHr} + (${maxHr} - ${restingHr}) * ${boundaries[2]}::numeric AND ${heartRate} < ${restingHr} + (${maxHr} - ${restingHr}) * ${boundaries[3]}::numeric)::int`;

  // Zone 5: above boundary[3]
  const zone5 = sql`COUNT(*) FILTER (WHERE ${heartRate} >= ${restingHr} + (${maxHr} - ${restingHr}) * ${boundaries[3]}::numeric)::int`;

  return { zone1, zone2, zone3, zone4, zone5 };
}

// ---------------------------------------------------------------------------
// Resting HR lateral join
// ---------------------------------------------------------------------------

/**
 * Reusable LATERAL subquery to find the most recent resting heart rate
 * for a given user on or before a given date expression.
 *
 * Returns a SQL fragment suitable for use in a `JOIN LATERAL (...) rhr ON true`.
 * The result has a single column: `resting_hr`.
 *
 * @param userIdExpression - SQL expression for the user ID (e.g., `sql\`up.id\``)
 * @param dateExpression   - SQL expression for the date upper bound
 */
export function restingHeartRateLateral(userIdExpression: SQL, dateExpression: SQL): SQL {
  return sql`LATERAL (
    SELECT dm.resting_hr
    FROM fitness.v_daily_metrics dm
    WHERE dm.user_id = ${userIdExpression}
      AND dm.date <= ${dateExpression}
      AND dm.resting_hr IS NOT NULL
    ORDER BY dm.date DESC
    LIMIT 1
  ) rhr ON true`;
}
