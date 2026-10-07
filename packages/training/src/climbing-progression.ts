import { z } from "zod";
import {
  CLIMBING_GRADE_SYSTEMS,
  gradeSystemLabel,
  isGradeSystemForClimbType,
} from "./climbing-grades.ts";

export const climbingProgressionStyles = [
  "boulder",
  "top-rope",
  "lead",
  "follow",
  "solo",
  "aid",
  "unknown",
] as const;
export const climbingProgressionSettings = ["indoor", "outdoor", "unknown"] as const;

export const climbingProgressionStyleLabels = {
  boulder: "Bouldering",
  "top-rope": "Top rope",
  lead: "Lead",
  follow: "Follow",
  solo: "Solo",
  aid: "Aid",
  unknown: "Unknown style",
} as const;
export const climbingProgressionSettingLabels = {
  indoor: "Indoor",
  outdoor: "Outdoor",
  unknown: "Unknown setting",
} as const;

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

/** Server-computed grade stacks; clients format and position these values. */
export const climbingGradeProgressionSchema = z
  .object({
    style: z.enum(climbingProgressionStyles),
    climbType: z.enum(["boulder", "route"]),
    gradeSystem: z.enum(CLIMBING_GRADE_SYSTEMS),
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
  .refine((lane) => isGradeSystemForClimbType(lane.gradeSystem, lane.climbType), {
    path: ["gradeSystem"],
    message: "Grade system must match the climb type",
  });

export type ClimbingGradeProgressionLane = z.infer<typeof climbingGradeProgressionSchema>;
export type ClimbingProgressionPeriod = ClimbingGradeProgressionLane["periods"][number];
export type ClimbingProgressionSetting = ClimbingProgressionPeriod["settings"][number];

export function climbingProgressionLaneLabel(
  lane: ClimbingGradeProgressionLane,
  lanes: ClimbingGradeProgressionLane[],
): string {
  const style = climbingProgressionStyleLabels[lane.style];
  return lanes.some((other) => other.style === lane.style && other.gradeSystem !== lane.gradeSystem)
    ? `${style} · ${gradeSystemLabel(lane.gradeSystem)}`
    : style;
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
  setting: ClimbingProgressionSetting,
  segment?: ClimbingProgressionSetting["segments"][number],
): string {
  const rate = segment ? segment.sendsPerDay : setting.sendsPerDay;
  if (rate === null) return "No recorded days";
  const sends = segment ? segment.sends : setting.sends;
  const formattedRate = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(rate);
  const unknown =
    setting.unknownOutcomes > 0
      ? ` · ${setting.unknownOutcomes} outcome${setting.unknownOutcomes === 1 ? "" : "s"} unrecorded`
      : "";
  return `${formattedRate} sends/day · ${sends} send${sends === 1 ? "" : "s"} · ${setting.climbingDays} recorded day${setting.climbingDays === 1 ? "" : "s"}${unknown}`;
}
