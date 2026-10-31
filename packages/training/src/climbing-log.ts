import { z } from "zod";
import { climbingBoardSchema, climbingWallAngleSchema } from "./climbing-experience.ts";
import { gradeSystemSchema, isValidClimbingGrade } from "./climbing-grades.ts";
import { gpsCoordinatesSchema } from "./gps-coordinates.ts";

export const CLIMB_KINDS = ["boulder", "route", "summit"] as const;
export const CLIMB_SETTINGS = ["indoor", "outdoor"] as const;
export const CLIMBING_DISCIPLINES = [
  "rock_climbing",
  "ice_climbing",
  "mixed_climbing",
  "snow_climbing",
  "hiking",
  "scrambling",
  "mountaineering",
] as const;
export const ROPE_METHODS = ["lead", "top_rope", "follow", "unroped"] as const;
export const PROTECTION_STYLES = ["sport", "trad"] as const;
export const ATTEMPT_SCOPES = ["climb", "pitch"] as const;
export const ATTEMPT_OUTCOMES = ["completed", "failed"] as const;
export const CLIMBING_HOLD_TYPES = [
  "crimp",
  "sloper",
  "pinch",
  "pocket",
  "jug",
  "volume",
  "jam",
  "no_grips",
] as const;
export const climbingHoldTypesSchema = z.array(z.enum(CLIMBING_HOLD_TYPES)).nonempty();

export const climbKindSchema = z.enum(CLIMB_KINDS);
export const climbSettingSchema = z.enum(CLIMB_SETTINGS);
export const climbingDisciplineSchema = z.enum(CLIMBING_DISCIPLINES);
export const ropeMethodSchema = z.enum(ROPE_METHODS);
export const protectionStyleSchema = z.enum(PROTECTION_STYLES);
export const attemptScopeSchema = z.enum(ATTEMPT_SCOPES);
export const attemptOutcomeSchema = z.enum(ATTEMPT_OUTCOMES);

const recordedTextSchema = z.string().trim().min(1);
export const gradeComponentSchema = z
  .strictObject({
    value: recordedTextSchema,
    system: gradeSystemSchema.nullable(),
  })
  .refine((grade) => grade.system === null || isValidClimbingGrade(grade.value, grade.system), {
    message: "A recognized grade system requires a valid recorded grade.",
    path: ["value"],
  });
const sourceObjectFields = {
  id: z.guid(),
  userId: z.guid(),
  providerId: recordedTextSchema,
  externalId: recordedTextSchema.nullable(),
};

export const areaSchema = z.strictObject({
  ...sourceObjectFields,
  name: recordedTextSchema,
  parentAreaId: z.guid().nullable(),
  coordinates: gpsCoordinatesSchema.nullable(),
});

export const climbSchema = z.strictObject({
  ...sourceObjectFields,
  name: recordedTextSchema.nullable(),
  kind: climbKindSchema.nullable(),
  areaId: z.guid().nullable(),
  publishedGrades: z.array(gradeComponentSchema),
  setting: climbSettingSchema.nullable(),
  routeProtection: z.array(protectionStyleSchema).nullable(),
  coordinates: gpsCoordinatesSchema.nullable(),
});

export const pitchSchema = z.strictObject({
  id: z.guid(),
  climbId: z.guid(),
  externalId: recordedTextSchema.nullable(),
  number: z.number().int().positive().nullable(),
  name: recordedTextSchema.nullable(),
  publishedGrades: z.array(gradeComponentSchema),
});

export const climbingLogEntrySchema = z.strictObject({
  ...sourceObjectFields,
  climbId: z.guid().nullable(),
  activityId: z.guid().nullable(),
  climbedOn: z.iso.date().nullable(),
  discipline: climbingDisciplineSchema.nullable(),
  title: recordedTextSchema.nullable(),
  notes: recordedTextSchema.nullable(),
  reportedGrades: z.array(gradeComponentSchema),
  board: climbingBoardSchema.nullable(),
  wallAngle: climbingWallAngleSchema.nullable(),
  holdTypes: climbingHoldTypesSchema.nullable(),
  sourceName: recordedTextSchema.nullable(),
  raw: z.json().nullable(),
  providerAbsentAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

const climbingAttemptFields = {
  id: z.guid(),
  climbingLogEntryId: z.guid(),
  scope: attemptScopeSchema,
  pitchId: z.guid().nullable(),
  parentAttemptId: z.guid().nullable(),
  attemptIndex: z.number().int().positive().nullable(),
  ropeMethod: ropeMethodSchema.nullable(),
  solo: z.boolean().nullable(),
  protectionUsed: z.array(protectionStyleSchema).nullable(),
  usedPreplacedProtection: z.boolean().nullable(),
  usedAid: z.boolean().nullable(),
  fellOrHung: z.boolean().nullable(),
  dabbed: z.boolean().nullable(),
  receivedBeta: z.boolean().nullable(),
  hadCompletedBefore: z.boolean().nullable(),
  priorFailedAttemptsGroundUp: z.boolean().nullable(),
  notes: recordedTextSchema.nullable(),
  createdAt: z.iso.datetime(),
};
const validAttemptScope = (attempt: {
  scope: z.infer<typeof attemptScopeSchema>;
  pitchId: string | null;
  parentAttemptId: string | null;
}) => attempt.scope === "pitch" || (attempt.pitchId === null && attempt.parentAttemptId === null);
const validAttemptScopeMessage = {
  message: "Whole-climb attempts cannot reference a pitch or parent attempt.",
};

export const climbingAttemptSchema = z
  .strictObject({ ...climbingAttemptFields, outcome: attemptOutcomeSchema.nullable() })
  .refine(validAttemptScope, validAttemptScopeMessage);

export const recordedClimbingAttemptSchema = z
  .strictObject({
    ...climbingAttemptFields,
    sourceCompleted: z.boolean().nullable(),
    sourceResult: z
      .string()
      .refine((value) => value.trim().length > 0)
      .nullable(),
  })
  .refine(validAttemptScope, validAttemptScopeMessage);

export type Area = z.infer<typeof areaSchema>;
export type Climb = z.infer<typeof climbSchema>;
export type Pitch = z.infer<typeof pitchSchema>;
export type GradeComponent = z.infer<typeof gradeComponentSchema>;
export type ClimbingLogEntry = z.infer<typeof climbingLogEntrySchema>;
export type ClimbingAttempt = z.infer<typeof climbingAttemptSchema>;
export type RecordedClimbingAttempt = z.infer<typeof recordedClimbingAttemptSchema>;
export type ClimbKind = z.infer<typeof climbKindSchema>;
export type ClimbSetting = z.infer<typeof climbSettingSchema>;
export type ClimbingDiscipline = z.infer<typeof climbingDisciplineSchema>;
export type RopeMethod = z.infer<typeof ropeMethodSchema>;
export type ProtectionStyle = z.infer<typeof protectionStyleSchema>;

export function isClimbingLogActivity(activityType: string): boolean {
  return activityType === "climbing" || activityType === "hiking";
}
export type AttemptScope = z.infer<typeof attemptScopeSchema>;
export type AttemptOutcome = z.infer<typeof attemptOutcomeSchema>;

const kayaColorSchema = z.union([
  recordedTextSchema,
  z.object({ name: recordedTextSchema }).transform((color) => color.name),
]);
const kayaClimbColorSchema = z.object({
  color: kayaColorSchema.nullish(),
  climb: z.object({ color: kayaColorSchema.nullish() }).nullish(),
});

/** Format retained source facts without turning an unnamed climb into a named catalogue entry. */
export function climbingLogEntryName(entry: {
  providerId?: string;
  raw?: unknown;
  title: string | null;
  climb: { name: string | null; kind?: ClimbKind | null } | null;
}): string {
  const name = entry.climb?.name?.trim();
  const title = entry.title?.trim();
  if (name) return name;
  if (title) return title;
  if (entry.providerId === "kaya") {
    const parsed = kayaClimbColorSchema.safeParse(entry.raw);
    if (parsed.success) {
      const color = parsed.data.climb?.color ?? parsed.data.color;
      if (color)
        return `${color.charAt(0).toUpperCase()}${color.slice(1)} ${entry.climb?.kind ?? "climb"}`;
    }
  }
  return "Climbing log";
}
