import { z } from "zod";
import { climbingTypeOptions } from "./climbing-filters.ts";
import { FREE_ROCK_GRADE_SYSTEMS } from "./climbing-grades.ts";

const CLIMBING_BEST_ONSIGHT_TYPES = climbingTypeOptions.map(([value]) => value);

const climbingBestOnsightTypeSchema = z.enum(CLIMBING_BEST_ONSIGHT_TYPES);
export type ClimbingBestOnsightType = z.infer<typeof climbingBestOnsightTypeSchema>;

const climbingBestOnsightCellSchema = z.object({
  grade: z.string().min(1),
  gradeSystem: z.enum(FREE_ROCK_GRADE_SYSTEMS),
  providerId: z.string().min(1),
  recordId: z.uuid(),
});
export type ClimbingBestOnsightCell = z.infer<typeof climbingBestOnsightCellSchema>;

const climbingBestOnsightRowSchema = z.object({
  type: climbingBestOnsightTypeSchema,
  gym: climbingBestOnsightCellSchema.nullable(),
  outdoor: climbingBestOnsightCellSchema.nullable(),
});

export const climbingBestOnsightSchema = z.object({
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  rows: z.array(climbingBestOnsightRowSchema).length(CLIMBING_BEST_ONSIGHT_TYPES.length),
});
export type ClimbingBestOnsight = z.infer<typeof climbingBestOnsightSchema>;
