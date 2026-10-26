import { z } from "zod";

const count = z.number().int().nonnegative();
const rate = z.number().min(0).max(100).nullable();
const example = z.object({
  logEntryId: z.string(),
  activityId: z.string().nullable(),
  name: z.string(),
  grade: z.string(),
  date: z.string(),
  providerId: z.string(),
  sourceName: z.string(),
  sourceUrl: z.string().nullable(),
  outcome: z.enum(["sent", "not_sent"]),
});
const cell = z.object({
  grade: z.string(),
  sends: count,
  climbs: count,
  successRate: rate,
  differencePercentagePoints: z.number().min(-100).max(100).nullable(),
  sampleStatus: z.enum(["no_data", "limited", "available"]),
  examples: z.array(example),
});
const profile = z.object({
  grades: z.array(
    z.object({
      grade: z.string(),
      gradeSortValue: z.number(),
      sends: count,
      climbs: count,
      successRate: rate,
    }),
  ),
  rows: z.array(z.object({ key: z.string(), label: z.string(), cells: z.array(cell) })),
  progress: z.array(
    z.object({
      startDate: z.iso.date(),
      endDate: z.iso.date(),
      rows: z.array(
        z.object({
          key: z.string(),
          cells: z.array(
            cell.pick({
              grade: true,
              sends: true,
              climbs: true,
              successRate: true,
              sampleStatus: true,
            }),
          ),
        }),
      ),
    }),
  ),
});
const panel = profile.extend({
  key: z.string(),
  contextKey: z.string(),
  contextLabel: z.string(),
  dimension: z.enum(["wall_angle", "hold_type", "setting"]),
  setting: z.enum(["indoor", "outdoor"]).nullable(),
  allGrades: profile,
  coverage: z.object({ missingTraits: count, unknownOutcomes: count }),
});
export const climbingStrengthsSchema = z.object({
  panels: z.array(panel),
  coverage: z.object({ unknownOutcomes: count, missingGrades: count, missingIdentity: count }),
});
export type ClimbingStrengths = z.infer<typeof climbingStrengthsSchema>;
export type ClimbingStrengthsPanel = ClimbingStrengths["panels"][number];
export type ClimbingStrengthsCell = ClimbingStrengthsPanel["rows"][number]["cells"][number];
export type ClimbingStrengthsExample = ClimbingStrengthsCell["examples"][number];

export const ALL_CLIMBING_GRADES = "All grades";

/** Select server-computed values for rendering, without aggregating client-side. */
export function climbingStrengthsGradePanel(
  panel: ClimbingStrengthsPanel,
  grade: string,
): ClimbingStrengthsPanel {
  return grade === ALL_CLIMBING_GRADES ? { ...panel, ...panel.allGrades } : panel;
}
