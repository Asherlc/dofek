import { z } from "zod";

const uncertaintyMetadataSchema = z.object({
  level: z.literal(0.95),
  method: z.literal("residual_circular_moving_block_bootstrap"),
  methodLabel: z.literal("95% moving-block interval"),
  statement: z.string(),
});

export const progressiveOverloadUncertaintySchema = z.discriminatedUnion("availability", [
  uncertaintyMetadataSchema.extend({
    availability: z.literal("available"),
    lowerKgPerWeek: z.number(),
    upperKgPerWeek: z.number(),
  }),
  uncertaintyMetadataSchema.extend({
    availability: z.literal("unavailable"),
    reason: z.enum([
      "insufficient_observations",
      "no_residual_variation",
      "insufficient_valid_replicates",
    ]),
  }),
]);

export const progressiveOverloadRowSchema = z.object({
  exerciseName: z.string(),
  observations: z.array(
    z.object({
      week: z.iso.date(),
      totalVolumeKg: z.number().nonnegative(),
    }),
  ),
  period: z.object({
    startWeek: z.iso.date(),
    endWeek: z.iso.date(),
    observationCount: z.number().int().positive(),
    elapsedWeekCount: z.number().int().positive(),
  }),
  slopeKgPerWeek: z.number(),
  trend: z.enum(["increasing", "decreasing", "stable"]),
  uncertainty: progressiveOverloadUncertaintySchema,
  interpretation: z.string(),
  deloadContext: z.string(),
});

export type ProgressiveOverloadRow = z.infer<typeof progressiveOverloadRowSchema>;
export type ProgressiveOverloadTrend = ProgressiveOverloadRow["trend"];
export type ProgressiveOverloadUncertainty = ProgressiveOverloadRow["uncertainty"];
