import { sql } from "drizzle-orm";
import type { SyncDatabase } from "../../db/index.ts";
import {
  type ProviderActivityInsert,
  upsertProviderActivity,
} from "../../db/provider-activity-sync.ts";
import { activity } from "../../db/schema/activity.ts";
import type { StravaActivity, StravaDetailedActivity } from "./api-types.ts";

type ActivityFields = Pick<
  ProviderActivityInsert,
  "externalId" | "activityType" | "startedAt" | "endedAt" | "name"
>;

/** Fresh list metadata must preserve detail-only provenance on checkpoint resumes. */
export function upsertStravaActivity(
  db: SyncDatabase,
  fields: ActivityFields,
  summary: StravaActivity | undefined,
  detail: StravaDetailedActivity | undefined,
  sourceName: string | undefined,
) {
  return upsertProviderActivity(
    db,
    { ...fields, providerId: "strava", sourceName, raw: detail ?? summary },
    {
      activityType: fields.activityType,
      startedAt: fields.startedAt,
      endedAt: fields.endedAt,
      name: fields.name,
      sourceName: sql`coalesce(excluded.source_name, ${activity.sourceName})`,
      raw: detail ?? sql`${activity.raw} || ${JSON.stringify(summary ?? {})}::jsonb`,
    },
  );
}
