import { climbingSourceLinkSchema } from "@dofek/training/climbing-context";
import {
  areaSchema,
  attemptOutcomeSchema,
  climbingAttemptSchema,
  climbingLogEntrySchema,
  climbSchema,
  pitchSchema,
} from "@dofek/training/climbing-log";
import {
  type ClimbingResponseVersion,
  climbingLogTraitsV1Schema,
  toClimbingLogTraitsV1,
} from "@dofek/training/climbing-log-response";
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
  photoLogEntryId: z.guid().nullable(),
  climb: climbingLogClimbDetailSchema.nullable(),
  mapLocation: climbingMapLocationSchema.nullable(),
  attempts: z.array(climbingLogAttemptDetailSchema),
  recordedClimbAttemptCount: z.number().int().nonnegative().nullable(),
  recordedPitchAttemptCount: z.number().int().nonnegative(),
  recordedClimbOutcome: attemptOutcomeSchema.nullable(),
  freeSend: z.boolean().nullable(),
  pitchResults: z.array(climbingPitchResultSchema),
  displayGrade: z.string().nullable(),
  sourceLinks: z.array(climbingSourceLinkSchema),
});
export type ClimbingLogEntryDetail = z.infer<typeof climbingLogEntryDetailSchema>;
export type ClimbingPitchResult = z.infer<typeof climbingPitchResultSchema>;

export const legacyClimbingLogEntryDetailSchema = climbingLogEntryDetailSchema
  .omit({ holdTypes: true })
  .extend(climbingLogTraitsV1Schema.shape);
export const climbingLogEntryDetailResponseSchema = z.union([
  climbingLogEntryDetailSchema,
  legacyClimbingLogEntryDetailSchema,
]);
const climbingLogEntriesResponseSchema = z.array(climbingLogEntryDetailResponseSchema);

export function serializeClimbingLogEntryDetailResponse(
  entry: ClimbingLogEntryDetail,
  version: ClimbingResponseVersion,
): z.infer<typeof climbingLogEntryDetailResponseSchema> {
  if (version === 2) return entry;
  const { holdTypes: _holdTypes, ...rest } = entry;
  return { ...rest, ...toClimbingLogTraitsV1(entry) };
}

function canonicalLogEntry(
  entry: z.infer<typeof climbingLogEntryDetailResponseSchema>,
): ClimbingLogEntryDetail {
  if ("holdTypes" in entry) return entry;
  const { holdType, ...rest } = entry;
  return { ...rest, holdTypes: holdType === null ? null : [holdType] };
}

/** Accept either supported wire contract during independent server/client releases. */
export function decodeClimbingLogEntryDetailResponse(value: unknown): ClimbingLogEntryDetail {
  return canonicalLogEntry(climbingLogEntryDetailResponseSchema.parse(value));
}

export function decodeClimbingLogEntriesResponse(value: unknown): ClimbingLogEntryDetail[] {
  return climbingLogEntriesResponseSchema.parse(value).map(canonicalLogEntry);
}

export const climbingAttachmentActivitySchema = z.object({
  id: z.guid(),
  name: z.string().nullable(),
  activityType: z.enum(["climbing", "hiking"]),
  providerId: z.string(),
  startTime: z.string(),
});
export type ClimbingAttachmentActivity = z.infer<typeof climbingAttachmentActivitySchema>;
