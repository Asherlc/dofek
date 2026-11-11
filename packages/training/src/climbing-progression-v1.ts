import { z } from "zod";
import { FREE_ROCK_GRADE_SYSTEMS, isGradeSystemForClimbKind } from "./climbing-grades.ts";
import { attemptScopeSchema, ropeMethodSchema } from "./climbing-log.ts";
import { climbingProgressionSettings } from "./climbing-progression.ts";

const countSchema = z.number().int().nonnegative();
const rateSchema = z.number().nonnegative().nullable();
const segmentSchema = z.object({
  grade: z.string(),
  sends: countSchema,
  sendsPerDay: rateSchema,
  stackStart: rateSchema,
  stackEnd: rateSchema,
});
const settingSchema = z.object({
  setting: z.enum(climbingProgressionSettings),
  climbingDays: countSchema,
  sends: countSchema,
  unknownOutcomes: countSchema,
  sendsPerDay: rateSchema,
  segments: z.array(segmentSchema),
});

/** Version 1 retains separate grade stacks for each lane and setting. */
export const climbingGradeProgressionV1Schema = z
  .object({
    climbKind: z.enum(["boulder", "route"]),
    attemptScope: attemptScopeSchema,
    ropeMethod: ropeMethodSchema.nullable(),
    solo: z.boolean().nullable(),
    usedAid: z.boolean().nullable(),
    gradeSystem: z.enum(FREE_ROCK_GRADE_SYSTEMS),
    grades: z.array(z.object({ grade: z.string(), gradeSortValue: z.number() })),
    settings: z.array(z.enum(climbingProgressionSettings)),
    axisMax: z.number().positive(),
    axisInterval: z.number().positive(),
    axisTicks: z.array(z.number().nonnegative()),
    periods: z.array(
      z.object({
        startDate: z.iso.date(),
        endDate: z.iso.date(),
        settings: z.array(settingSchema),
      }),
    ),
  })
  .refine((lane) => isGradeSystemForClimbKind(lane.gradeSystem, lane.climbKind), {
    path: ["gradeSystem"],
    message: "Grade system must match the climb kind",
  });

export type ClimbingGradeProgressionV1Lane = z.infer<typeof climbingGradeProgressionV1Schema>;
