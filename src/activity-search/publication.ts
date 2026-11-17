import { sql } from "drizzle-orm";
import type { Database } from "../db/index.ts";

export const ACTIVITY_SEARCH_PUBLICATION_OWNER = {
  resourceId: "activity-search-index",
  intentId: "activity-search",
} as const;

export async function activitySearchPublicationExists(database: Pick<Database, "execute">) {
  const rows = await database.execute(sql`
    SELECT 1 FROM fitness.analytics_query_owner
    WHERE resource_id = ${ACTIVITY_SEARCH_PUBLICATION_OWNER.resourceId}
  `);
  return rows.length > 0;
}
