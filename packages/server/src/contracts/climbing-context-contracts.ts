import { climbingContextSchema } from "@dofek/training/climbing-context";
import { CLIMBING_GRADE_SYSTEMS } from "@dofek/training/climbing-grades";
import { z } from "zod";

const entryFields = {
  id: z.string(),
  climbType: z.enum(["boulder", "route"]),
  gradeSystem: z.enum(CLIMBING_GRADE_SYSTEMS),
  grade: z.string(),
  sent: z.boolean().nullable(),
  attemptCount: z.number().int().positive().nullable(),
  ascentType: z.enum(["Flash", "Onsight", "Redpoint", "Pinkpoint", "Repeat"]).nullable(),
  routeName: z.string().nullable(),
  locationName: z.string().nullable(),
  lead: z.boolean().nullable(),
  sourceName: z.string().nullable(),
  context: climbingContextSchema,
};

export const climbingActivityEntryDetailSchema = z.object({
  ...entryFields,
  attempts: z.array(
    z.object({
      attemptIndex: z.number().int().positive(),
      failureReason: z.enum(["fell", "pumped", "skin", "technique", "fear"]).nullable(),
      notes: z.string().nullable(),
      outcome: z.enum(["sent", "failed"]),
    }),
  ),
  holdType: z.enum(["crimp", "sloper", "pinch", "pocket", "jug"]).nullable(),
  wallAngleDegrees: z.number().nullable(),
});
export const climbingEntrySuggestionSchema = z.object({
  ...entryFields,
  id: z.guid(),
  providerId: z.string(),
  gradeSystem: z.string(),
});
export type ClimbingActivityEntryRow = z.infer<typeof climbingActivityEntryDetailSchema>;
export type ClimbingEntrySuggestion = z.infer<typeof climbingEntrySuggestionSchema>;
