import { z } from "zod";

/** States for a server-authored value that is not currently displayable. */
export const activityDataStateUnavailableStatusSchema = z.enum([
  "missing",
  "stale",
  "failed",
  "processing",
  "conflicting",
]);

export const activityDataStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available") }),
  z.object({
    status: activityDataStateUnavailableStatusSchema,
    reason: z.string().min(1),
  }),
]);

export type ActivityDataState = z.infer<typeof activityDataStateSchema>;
export type ActivityDataStateUnavailableStatus = z.infer<
  typeof activityDataStateUnavailableStatusSchema
>;
