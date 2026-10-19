import { climbingSourceLinkSchema } from "@dofek/training/climbing-context";
import {
  areaSchema,
  attemptOutcomeSchema,
  climbingAttemptSchema,
  climbingLogEntrySchema,
  climbSchema,
  pitchSchema,
} from "@dofek/training/climbing-log";
import type { ClimbingMapLocation } from "@dofek/training/climbing-map";
import { gpsCoordinatesSchema } from "@dofek/training/gps-coordinates";
import { z } from "zod";

export const climbingMapLocationSchema = z.strictObject({
  coordinates: gpsCoordinatesSchema,
  scope: z.enum(["climb", "area"]),
  objectId: z.guid(),
  providerId: z.string(),
  name: z.string().nullable(),
}) satisfies z.ZodType<ClimbingMapLocation>;
export const climbingLogAttemptDetailSchema = climbingAttemptSchema.safeExtend({
  rockResultLabels: z.array(z.enum(["sent", "Onsight", "Flash", "Pinkpoint"])),
});
export const climbingLogClimbDetailSchema = climbSchema.extend({
  areaPath: z.array(areaSchema),
  pitches: z.array(pitchSchema),
});
export const climbingPitchResultSchema = z.strictObject({
  pitch: pitchSchema.nullable(),
  attemptIds: z.array(z.guid()),
  recordedAttemptCount: z.number().int().positive(),
  recordedOutcome: attemptOutcomeSchema.nullable(),
  displayGrade: z.string().nullable(),
});
export const climbingLogEntryDetailSchema = climbingLogEntrySchema.extend({
  climb: climbingLogClimbDetailSchema.nullable(),
  mapLocation: climbingMapLocationSchema.nullable(),
  attempts: z.array(climbingLogAttemptDetailSchema),
  recordedClimbAttemptCount: z.number().int().nonnegative().nullable(),
  recordedPitchAttemptCount: z.number().int().nonnegative(),
  recordedClimbOutcome: attemptOutcomeSchema.nullable(),
  pitchResults: z.array(climbingPitchResultSchema),
  displayGrade: z.string().nullable(),
  sourceLinks: z.array(climbingSourceLinkSchema),
});
export type ClimbingLogEntryDetail = z.infer<typeof climbingLogEntryDetailSchema>;
export type ClimbingPitchResult = z.infer<typeof climbingPitchResultSchema>;
