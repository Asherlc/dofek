import { z } from "zod";

/** Recording origin is independent of all field and sensor priorities. */
export const activityOriginSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("resolved"),
    memberActivityId: z.string().uuid(),
    providerId: z.string().min(1),
    sourceName: z.string().nullable(),
  }),
  z.object({
    status: z.literal("unresolved"),
    candidateMemberActivityIds: z.array(z.string().uuid()),
  }),
]);

export type ActivityOrigin = z.infer<typeof activityOriginSchema>;

export interface ActivityOriginEvidence {
  upstreamMemberActivityId: string;
  downstreamMemberActivityId: string;
  field: string;
  value: string;
}
