import { ENDURANCE_ACTIVITY_TYPES } from "@dofek/training/training";
import { sql } from "drizzle-orm";

// Re-export so existing imports continue to work
export { ENDURANCE_ACTIVITY_TYPES };

/**
 * SQL fragment: AND <alias>.activity_type IN ('cycling', 'running', ...)
 * Pass the table alias used in the query (e.g. 'a', 'asum').
 */
export function enduranceTypeFilter(alias: string) {
  const list = ENDURANCE_ACTIVITY_TYPES.map((t) => `'${t}'`).join(", ");
  return sql.raw(`${alias}.activity_type IN (${list})`);
}
