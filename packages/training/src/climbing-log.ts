import { z } from "zod";
import { climbingBoardSchema, climbingWallAngleSchema } from "./climbing-experience.ts";
import { CLIMBING_GRADE_SYSTEMS, isValidClimbingGrade } from "./climbing-grades.ts";
import { gpsCoordinatesSchema } from "./gps-coordinates.ts";

export const CLIMB_KINDS = ["boulder", "route", "summit"] as const;
export const CLIMB_SETTINGS = ["indoor", "outdoor"] as const;
export const CLIMBING_DISCIPLINES = [
  "rock_climbing",
  "hiking",
  "scrambling",
  "mountaineering",
] as const;
export const CLIMBING_METHODS = ["lead", "top-rope", "follow", "solo", "aid"] as const;
export const ATTEMPT_OUTCOMES = ["completed", "failed"] as const;

export const climbKindSchema = z.enum(CLIMB_KINDS);
export const climbSettingSchema = z.enum(CLIMB_SETTINGS);
export const climbingDisciplineSchema = z.enum(CLIMBING_DISCIPLINES);
export const climbingMethodSchema = z.enum(CLIMBING_METHODS);
export const attemptOutcomeSchema = z.enum(ATTEMPT_OUTCOMES);

const recordedTextSchema = z.string().trim().min(1);
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

export const climbSchema = z
  .strictObject({
    ...sourceObjectFields,
    name: recordedTextSchema.nullable(),
    kind: climbKindSchema.nullable(),
    areaId: z.guid().nullable(),
    grade: recordedTextSchema.nullable(),
    gradeSystem: z.enum(CLIMBING_GRADE_SYSTEMS).nullable(),
    setting: climbSettingSchema.nullable(),
    coordinates: gpsCoordinatesSchema.nullable(),
  })
  .refine(
    (climb) =>
      climb.gradeSystem === null ||
      (climb.grade !== null && isValidClimbingGrade(climb.grade, climb.gradeSystem)),
    { message: "A recognized grade system requires a valid recorded grade.", path: ["grade"] },
  );

export const climbingLogEntrySchema = z.strictObject({
  ...sourceObjectFields,
  climbId: z.guid().nullable(),
  activityId: z.guid().nullable(),
  climbedOn: z.iso.date().nullable(),
  discipline: climbingDisciplineSchema.nullable(),
  climbStyle: climbingMethodSchema.nullable(),
  title: recordedTextSchema.nullable(),
  notes: recordedTextSchema.nullable(),
  board: climbingBoardSchema.nullable(),
  wallAngle: climbingWallAngleSchema.nullable(),
  routeProtection: z.array(z.enum(["sport", "trad"])).nullable(),
  holdType: z.enum(["crimp", "sloper", "pinch", "pocket", "jug"]).nullable(),
  sourceName: recordedTextSchema.nullable(),
  raw: z.json().nullable(),
  providerAbsentAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const climbingAttemptSchema = z.strictObject({
  id: z.guid(),
  climbingLogEntryId: z.guid(),
  attemptIndex: z.number().int().positive().nullable(),
  outcome: attemptOutcomeSchema.nullable(),
  clean: z.boolean().nullable(),
  receivedBeta: z.boolean().nullable(),
  notes: recordedTextSchema.nullable(),
  createdAt: z.iso.datetime(),
});

export type Area = z.infer<typeof areaSchema>;
export type Climb = z.infer<typeof climbSchema>;
export type ClimbingLogEntry = z.infer<typeof climbingLogEntrySchema>;
export type ClimbingAttempt = z.infer<typeof climbingAttemptSchema>;
export type ClimbKind = z.infer<typeof climbKindSchema>;
export type ClimbSetting = z.infer<typeof climbSettingSchema>;
export type ClimbingDiscipline = z.infer<typeof climbingDisciplineSchema>;
export type ClimbingMethod = z.infer<typeof climbingMethodSchema>;
export type AttemptOutcome = z.infer<typeof attemptOutcomeSchema>;
