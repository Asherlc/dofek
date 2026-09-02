import { z } from "zod";
import { dateStringSchema, timestampStringSchema } from "../lib/typed-sql.ts";

/** Zod schema for rows from fitness.v_daily_metrics used by insights/correlation queries. */
export const dailyRowSchema = z.object({
  date: dateStringSchema,
  resting_hr: z.number().nullable(),
  hrv: z.number().nullable(),
  spo2_avg: z.number().nullable(),
  steps: z.number().nullable(),
  skin_temp_c: z.number().nullable(),
});

/** Zod schema for sleep rows used by insights/correlation queries. */
export const sleepRowSchema = z.object({
  started_at: timestampStringSchema,
  duration_minutes: z.number().nullable(),
  deep_minutes: z.number().nullable(),
  rem_minutes: z.number().nullable(),
  light_minutes: z.number().nullable(),
  awake_minutes: z.number().nullable(),
  efficiency_pct: z.number().nullable(),
  is_nap: z.boolean(),
});

/** Zod schema for activity rows used by insights/correlation queries. */
export const activityRowSchema = z.object({
  date: dateStringSchema.optional(),
  started_at: timestampStringSchema,
  ended_at: timestampStringSchema.nullable(),
  canonical_type: z.string(),
});

/** Zod schema for rows from fitness.v_nutrition_daily used by insights/correlation queries. */
export const nutritionRowSchema = z.object({
  date: dateStringSchema,
  calories: z.number().nullable(),
  protein_g: z.number().nullable(),
  carbs_g: z.number().nullable(),
  fat_g: z.number().nullable(),
  fiber_g: z.number().nullable(),
  water_ml: z.number().nullable(),
});
