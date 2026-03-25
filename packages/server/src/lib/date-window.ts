import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";

/**
 * ISO date string (YYYY-MM-DD) provided by the client.
 * Ensures the client controls the date boundary rather than relying on
 * the server's CURRENT_DATE, which can cause stale cached results
 * when the day rolls over (the cache key wouldn't change because
 * `{ days: 30 }` stays the same even after midnight).
 *
 * Optional — falls back to server's current date if omitted.
 * Dashboard clients SHOULD always pass this to ensure cache invalidation.
 */
export const endDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD date")
  .optional()
  .transform((d) => d ?? todayYmd());

/** Standard date-windowed input: `days` lookback from `endDate`. */
export const dateWindowInput = z.object({
  days: z.number().default(30),
  endDate: endDateSchema,
});

/** Current date in YYYY-MM-DD (server-local timezone). */
function todayYmd(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * Build the SQL lower bound for a date window.
 * Replaces `CURRENT_DATE - ${days}::int` with a client-provided anchor.
 *
 * @example
 *   WHERE date > ${dateWindowStart(endDate, days)}
 */
export function dateWindowStart(endDate: string, days: number): SQL {
  return sql`${endDate}::date - ${days}::int`;
}

/**
 * Build the SQL upper bound for a date window (the endDate itself as a date).
 * Replaces `CURRENT_DATE` with the client-provided anchor.
 *
 * @example
 *   WHERE date <= ${dateWindowEnd(endDate)}
 */
export function dateWindowEnd(endDate: string): SQL {
  return sql`${endDate}::date`;
}

/**
 * Build a SQL timestamp lower bound for a date window.
 * Replaces `NOW() - ${days} * INTERVAL '1 day'`.
 * Uses midnight of (endDate - days) as the cutoff.
 *
 * @example
 *   WHERE started_at > ${timestampWindowStart(endDate, days)}
 */
export function timestampWindowStart(endDate: string, days: number): SQL {
  return sql`(${endDate}::date - ${days}::int)::timestamp`;
}
