import { ENDURANCE_ACTIVITY_TYPES } from "@dofek/training/endurance-types";
import { sql } from "drizzle-orm";

// Re-export for shared package consumers
export { ENDURANCE_ACTIVITY_TYPES, isEnduranceActivity } from "@dofek/training/endurance-types";

/**
 * SQL fragment: AND <alias>.activity_type IN ('cycling', 'running', ...)
 * Pass the table alias used in the query (e.g. 'a', 'asum').
 * This stays on the server because it generates SQL.
 */
export function enduranceTypeFilter(alias: string) {
  const list = ENDURANCE_ACTIVITY_TYPES.map((t) => `'${t}'`).join(", ");
  return sql.raw(`${alias}.activity_type IN (${list})`);
}
