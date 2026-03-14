import { sql } from "drizzle-orm";

/**
 * Activity types considered "endurance" for training analysis.
 * Used to filter endurance-tab queries (HR zones, polarization, ramp rate, etc.)
 * so that strength training, yoga, etc. don't skew intensity metrics.
 */
const ENDURANCE_ACTIVITY_TYPES = ["cycling", "running", "swimming", "walking", "hiking"] as const;

/**
 * SQL fragment: AND <alias>.activity_type IN ('cycling', 'running', ...)
 * Pass the table alias used in the query (e.g. 'a', 'asum').
 */
export function enduranceTypeFilter(alias: string) {
  const list = ENDURANCE_ACTIVITY_TYPES.map((t) => `'${t}'`).join(", ");
  return sql.raw(`${alias}.activity_type IN (${list})`);
}
