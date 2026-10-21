import { type ActivityOrigin, activityOriginSchema } from "@dofek/providers/activity-origin";
import { z } from "zod";

export const activityOriginColumnsSchema = z.object({
  primary_activity_id: z.string().nullable(),
  primary_provider_id: z.string().nullable(),
  primary_source_name: z.string().nullable(),
  origin_candidate_member_ids: z.array(z.string()),
});
export type ActivityOriginColumns = z.infer<typeof activityOriginColumnsSchema>;

export function activityOriginFromColumns(row: ActivityOriginColumns): ActivityOrigin {
  return activityOriginSchema.parse(
    row.primary_activity_id !== null && row.primary_provider_id !== null
      ? {
          status: "resolved",
          memberActivityId: row.primary_activity_id,
          providerId: row.primary_provider_id,
          sourceName: row.primary_source_name,
        }
      : { status: "unresolved", candidateMemberActivityIds: row.origin_candidate_member_ids },
  );
}
