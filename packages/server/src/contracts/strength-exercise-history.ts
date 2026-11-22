import { z } from "zod";
import { dateStringSchema } from "../lib/typed-sql.ts";

export const exerciseOrderWeightUnitSchema = z.enum(["KG", "LBS"]);
export type ExerciseOrderWeightUnit = z.infer<typeof exerciseOrderWeightUnitSchema>;

export const exerciseOrderSetRowSchema = z.object({
  position: z.number().int().positive(),
  resistance: z.number(),
  unit: exerciseOrderWeightUnitSchema,
  reps: z.number().int().positive(),
});
export type ExerciseOrderSetRow = z.infer<typeof exerciseOrderSetRowSchema>;

export const exerciseOrderSessionSchema = z.object({
  activityId: z.string(),
  date: dateStringSchema,
  position: z.number().int().positive(),
  sets: z.array(exerciseOrderSetRowSchema),
});
export type ExerciseOrderSession = z.infer<typeof exerciseOrderSessionSchema>;

export const exerciseOrderEvidenceSchema = z.object({
  source: z.literal("Crimpd"),
  baseline: exerciseOrderSessionSchema,
  earlier: exerciseOrderSessionSchema.nullable(),
});
export type ExerciseOrderEvidence = z.infer<typeof exerciseOrderEvidenceSchema>;

export const estimatedOneRepMaxEntrySchema = z.object({
  date: dateStringSchema,
  estimatedMax: z.number(),
  actualWeight: z.number(),
  actualReps: z.number(),
  sourceSetId: z.string(),
  provider: z.string(),
  fatigueMarker: z.literal("Failure"),
});

export const estimatedMaxTrendEvidenceSchema = z.object({
  direction: z.enum(["increasing", "decreasing", "stable"]),
  summary: z.string(),
  changeMagnitudeKg: z.number(),
  firstDate: dateStringSchema,
  latestDate: dateStringSchema,
});

export const estimatedOneRepMaxRowSchema = z.object({
  exerciseName: z.string(),
  equipment: z.string().nullable(),
  history: z.array(estimatedOneRepMaxEntrySchema),
  trend: estimatedMaxTrendEvidenceSchema,
});

export const strengthExerciseHistoryRowSchema = z.object({
  exerciseName: z.string(),
  equipment: z.string().nullable(),
  estimatedStrength: estimatedOneRepMaxRowSchema.nullable(),
  exerciseOrder: exerciseOrderEvidenceSchema.nullable(),
});
export type StrengthExerciseHistoryRow = z.infer<typeof strengthExerciseHistoryRowSchema>;
