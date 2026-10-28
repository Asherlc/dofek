import { z } from "zod";
import {
  FREE_ROCK_GRADE_SYSTEMS,
  gradeSystemLabel,
  isGradeSystemForClimbKind,
  type RockClimbKind,
} from "./climbing-grades.ts";
import type { AttemptScope, RopeMethod } from "./climbing-log.ts";

export const climbingProgressionSettings = ["indoor", "outdoor", "unknown"] as const;
const countSchema = z.number().int().nonnegative();
const rateSchema = z.number().nonnegative().nullable();
const gradeSchema = z
  .object({
    key: z.string(),
    climbKind: z.enum(["boulder", "route"]),
    gradeSystem: z.enum(FREE_ROCK_GRADE_SYSTEMS),
    grade: z.string(),
    gradeSortValue: z.number(),
  })
  .refine((grade) => isGradeSystemForClimbKind(grade.gradeSystem, grade.climbKind), {
    path: ["gradeSystem"],
    message: "Grade system must match the climb kind",
  });
const segmentSchema = z.object({
  gradeKey: z.string(),
  sends: countSchema,
  sendsPerDay: rateSchema,
  stackStart: rateSchema,
  stackEnd: rateSchema,
});

/** One server-computed stack across every record selected by the page filters. */
export const climbingGradeProgressionSchema = z.object({
  grades: z.array(gradeSchema),
  axisMax: z.number().positive(),
  axisInterval: z.number().positive(),
  axisTicks: z.array(z.number().nonnegative()),
  periods: z.array(
    z.object({
      startDate: z.iso.date(),
      endDate: z.iso.date(),
      climbingDays: countSchema,
      sends: countSchema,
      unknownOutcomes: countSchema,
      sendsPerDay: rateSchema,
      segments: z.array(segmentSchema),
    }),
  ),
});

export type ClimbingGradeProgressionData = z.infer<typeof climbingGradeProgressionSchema>;
export type ClimbingProgressionGrade = ClimbingGradeProgressionData["grades"][number];
export type ClimbingProgressionPeriod = ClimbingGradeProgressionData["periods"][number];

export interface ClimbingProgressionLaneFacts {
  climbKind: RockClimbKind;
  attemptScope: AttemptScope;
  ropeMethod: RopeMethod | null;
  solo: boolean | null;
  usedAid: boolean | null;
}

export function climbingProgressionLaneKey(lane: ClimbingProgressionLaneFacts): string {
  return JSON.stringify([
    lane.climbKind,
    lane.attemptScope,
    lane.ropeMethod,
    lane.solo,
    lane.usedAid,
  ]);
}

export function climbingProgressionGradeLabel(
  grade: ClimbingProgressionGrade,
  grades: ClimbingProgressionGrade[],
): string {
  return grades.some(
    (other) => other.grade === grade.grade && other.gradeSystem !== grade.gradeSystem,
  )
    ? `${grade.grade} · ${gradeSystemLabel(grade.gradeSystem)}`
    : grade.grade;
}

export function climbingProgressionPeriodLabel(
  period: Pick<ClimbingProgressionPeriod, "startDate" | "endDate">,
  includeYear = false,
  locale?: string,
): string {
  const month = new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" });
  const start = month.format(new Date(`${period.startDate}T00:00:00Z`));
  const end = month.format(new Date(`${period.endDate}T00:00:00Z`));
  const startYear = period.startDate.slice(0, 4);
  const endYear = period.endDate.slice(0, 4);
  if (startYear !== endYear)
    return includeYear ? `${start} ${startYear}–${end} ${endYear}` : `${start}–${end}`;
  const months =
    period.startDate.slice(0, 7) === period.endDate.slice(0, 7) ? start : `${start}–${end}`;
  return includeYear ? `${months} ${startYear}` : months;
}

export function climbingProgressionGradeColor(index: number, gradeCount: number): string {
  const position = gradeCount <= 1 ? 1 : index / (gradeCount - 1);
  return `hsl(${Math.round(215 - position * 55)}, ${Math.round(16 + position * 49)}%, ${Math.round(65 - position * 13)}%)`;
}

export function climbingProgressionValueLabel(
  period: ClimbingProgressionPeriod,
  segment?: ClimbingProgressionPeriod["segments"][number],
): string {
  const rate = segment ? segment.sendsPerDay : period.sendsPerDay;
  if (rate === null) return "No recorded days";
  const sends = segment ? segment.sends : period.sends;
  const formattedRate = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(rate);
  const unknown =
    segment === undefined && period.unknownOutcomes > 0
      ? ` · ${period.unknownOutcomes} outcome${period.unknownOutcomes === 1 ? "" : "s"} unrecorded`
      : "";
  return `${formattedRate} sends/day · ${sends} send${sends === 1 ? "" : "s"} · ${period.climbingDays} recorded day${period.climbingDays === 1 ? "" : "s"}${unknown}`;
}
