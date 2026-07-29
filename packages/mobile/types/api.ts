import { activityDataStateSchema } from "@dofek/format/activity-data-state";
import {
  nutritionSourceResolutionSchema,
  selectedDateNutritionIntakeContextSchema,
  selectedDateNutritionSummarySchema,
} from "@dofek/nutrition/selected-date-summary";
import { z } from "zod";

// ── Re-export server types used by iOS screens ──

export type {
  HrvVariabilityRow as HeartRateVariabilityRow,
  ReadinessComponents,
  ReadinessRow,
  SleepAnalyticsDataState,
  SleepAnalyticsResult,
  SleepConsistencyRow,
  SleepNightlyRow,
  StressResult,
  WorkloadRatioResult,
  WorkloadRatioRow,
} from "dofek-server/types";

// ── Zod schemas for untyped tRPC endpoints (raw SQL results) ──

const ActivityRowBaseSchema = z.object({
  id: z.union([z.string(), z.number()]),
  name: z.string().nullable().optional(),
  canonical_type: z.string().nullable().optional(),
  started_at: z.string(),
  ended_at: z.string().nullable().optional(),
  avg_hr: z.number().nullable().optional(),
  max_hr: z.number().nullable().optional(),
  avg_power: z.number().nullable().optional(),
  distance_meters: z.number().nullable().optional(),
  distance_state: activityDataStateSchema.optional(),
});

export const ActivityRowSchema = ActivityRowBaseSchema.transform((row) => ({
  ...row,
  distance_state:
    row.distance_state ??
    (row.distance_meters == null
      ? { status: "missing" as const, reason: "Distance not recorded" }
      : { status: "available" as const }),
}));

export type ActivityRow = z.infer<typeof ActivityRowSchema>;

export const WeeklyVolumeRowSchema = z.object({
  week: z.string(),
  canonical_type: z.string(),
  count: z.number(),
  hours: z.coerce.number(),
});

export type WeeklyVolumeRow = z.infer<typeof WeeklyVolumeRowSchema>;

export const FoodEntrySchema = z
  .object({
    id: z.string(),
    food_name: z.string().nullable(),
    food_description: z.string().nullable(),
    meal: z.string().nullable(),
    calories: z.number().nullable(),
    protein_g: z.number().nullable(),
    carbs_g: z.number().nullable(),
    fat_g: z.number().nullable(),
  })
  .passthrough();

export type FoodEntryRow = z.infer<typeof FoodEntrySchema>;

export const FoodByDateSchema = z.object({
  entries: z.array(FoodEntrySchema),
  summary: selectedDateNutritionSummarySchema,
});

export const FoodByDateV2Schema = z.object({
  entries: z.array(FoodEntrySchema),
  summary: selectedDateNutritionSummarySchema.nullable(),
  resolution: nutritionSourceResolutionSchema,
  intakeContext: selectedDateNutritionIntakeContextSchema.nullable(),
});
