import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

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
