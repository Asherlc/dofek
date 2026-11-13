import { MAXIMUM_EXPANDED_ACTIVITY_IDS } from "./activity-data-integrity-scope-policy.ts";

/** The dbt transport stores each UUID as 16 bytes in textual/network order. */
export function encodeActivityRefreshScope(activityIds: readonly string[]): string {
  if (activityIds.length === 0 || activityIds.length > MAXIMUM_EXPANDED_ACTIVITY_IDS) {
    throw new Error(`activity refresh scope requires 1 to ${MAXIMUM_EXPANDED_ACTIVITY_IDS} UUIDs`);
  }
  const bytes = activityIds.map((id) => {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
      id.length !== 36
    ) {
      throw new Error("activity refresh scope requires a valid UUID for every activity");
    }
    return Buffer.from(id.replaceAll("-", ""), "hex");
  });
  return Buffer.concat(bytes).toString("base64");
}
