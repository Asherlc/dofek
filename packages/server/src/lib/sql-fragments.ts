import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { timestampWindowStart } from "./date-window.ts";

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
