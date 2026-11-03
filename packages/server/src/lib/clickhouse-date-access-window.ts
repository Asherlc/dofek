import type { AccessWindow } from "../billing/entitlement.ts";

/**
 * Shared ClickHouse date access-window clause for analytics read models.
 */
export function clickHouseDateAccessWindowClause(
  accessWindow: AccessWindow | undefined,
  alias: string,
): string {
  return accessWindow?.kind === "limited"
    ? `AND ${alias}.date >= toDate({accessStartDate:String})
       AND ${alias}.date < toDate({accessEndDateExclusive:String})`
    : "";
}

/**
 * Shared ClickHouse date access-window query params for analytics read models.
 */
export function clickHouseDateAccessWindowParams(
  accessWindow: AccessWindow | undefined,
): Record<string, string> {
  return accessWindow?.kind === "limited"
    ? {
        accessStartDate: accessWindow.startDate,
        accessEndDateExclusive: accessWindow.endDateExclusive,
      }
    : {};
}
