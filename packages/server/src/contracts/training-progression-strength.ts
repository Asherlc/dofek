import { z } from "zod";

/** A recorded, source-backed strength set used as evidence for a status. */
export const strengthEvidenceObservationSchema = z.object({
  date: z.iso.date(),
  activityId: z.string().uuid(),
  sourceActivityId: z.string().uuid(),
  sourceSetId: z.string().uuid(),
  provider: z.string(),
  setIndex: z.number().int().positive(),
  weightKg: z.number().positive(),
  reps: z.number().int().positive(),
  rpe: z.number().min(0).max(10).nullable(),
  estimatedMaxKg: z.number().positive().nullable(),
});

export const strengthEvidenceEffortSchema = z.object({
  provider: z.string(),
  rpeSpread: z.number().nonnegative().nullable(),
  comparable: z.boolean(),
});

export const repImprovementEvidenceSchema = z.object({
  kind: z.literal("rep_improvement"),
  slot: z.number().int().positive(),
  weightKg: z.number().positive(),
  effort: strengthEvidenceEffortSchema,
  observations: z.array(strengthEvidenceObservationSchema),
});

export const flatBenchmarkEvidenceSchema = z.object({
  kind: z.literal("flat_benchmark"),
  formula: z.literal("Epley"),
  reps: z.number().int().positive(),
  effort: strengthEvidenceEffortSchema,
  observedDates: z.number().int().positive(),
  spanDays: z.number().int().nonnegative(),
  observedRangeKg: z.object({
    min: z.number().positive(),
    max: z.number().positive(),
    spreadPercent: z.number().nonnegative(),
  }),
  observations: z.array(strengthEvidenceObservationSchema),
});

export const trainingProgressionStrengthRowSchema = z.object({
  identityKey: z.string(),
  exerciseId: z.string().uuid(),
  exerciseName: z.string(),
  equipment: z.string().nullable(),
  status: z.enum(["ready", "stagnating"]).nullable(),
  evidence: z.discriminatedUnion("kind", [
    repImprovementEvidenceSchema,
    flatBenchmarkEvidenceSchema,
  ]),
  latestEvidenceDate: z.iso.date(),
});

export const trainingProgressionStrengthSchema = z.array(trainingProgressionStrengthRowSchema);

export type StrengthEvidenceObservation = z.infer<typeof strengthEvidenceObservationSchema>;
export type StrengthEvidenceEffort = z.infer<typeof strengthEvidenceEffortSchema>;
export type TrainingProgressionStrengthRow = z.infer<typeof trainingProgressionStrengthRowSchema>;
