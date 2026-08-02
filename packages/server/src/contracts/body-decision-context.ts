import { z } from "zod";

export const bodyDecisionContextOutputSchema = z.object({
  latestMeasurement: z
    .object({
      date: z.string(),
      recordedAt: z.string(),
      recordedAtLocal: z.string(),
      weightKg: z.number(),
      providerId: z.string(),
      sourceName: z.string().nullable(),
    })
    .nullable(),
  trendWeight: z.object({
    smoothing: z.literal("ewma"),
    alpha: z.number(),
    gapHandling: z.literal("linear_interpolation"),
    invalidWeightHandling: z.literal("exclude_non_positive"),
    outlierHandling: z.literal("retain"),
  }),
  variation: z.object({
    status: z.enum(["available", "insufficient_data"]),
    observations: z.number().int().nonnegative(),
    minimumObservations: z.number().int().positive(),
    maximumObservations: z.number().int().positive(),
    method: z.literal("tukey_inner_fence"),
    lowerResidualKg: z.number().nullable(),
    upperResidualKg: z.number().nullable(),
    outliersIncluded: z.literal(true),
  }),
});

export type BodyDecisionContextOutput = z.infer<typeof bodyDecisionContextOutputSchema>;
