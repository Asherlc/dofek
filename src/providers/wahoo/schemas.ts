import { z } from "zod";

/**
 * Wahoo's API returns numeric fields as strings or null — coerce to number
 * or undefined so downstream code always sees `number | undefined`.
 */
export const wahooNumeric = z.preprocess(
  (val) => (val === null || val === undefined ? undefined : Number(val)),
  z.number().optional(),
);

export const wahooWorkoutSummarySchema = z.object({
  id: z.number(),
  ascent_accum: wahooNumeric,
  cadence_avg: wahooNumeric,
  calories_accum: wahooNumeric,
  distance_accum: wahooNumeric,
  duration_active_accum: wahooNumeric,
  duration_paused_accum: wahooNumeric,
  duration_total_accum: wahooNumeric,
  heart_rate_avg: wahooNumeric,
  power_bike_np_last: wahooNumeric,
  power_bike_tss_last: wahooNumeric,
  power_avg: wahooNumeric,
  speed_avg: wahooNumeric,
  work_accum: wahooNumeric,
  created_at: z.string(),
  updated_at: z.string(),
  file: z.object({ url: z.string() }).optional(),
});

export type WahooWorkoutSummary = z.infer<typeof wahooWorkoutSummarySchema>;

export const wahooWorkoutSchema = z.object({
  id: z.number(),
  name: z.string().optional(),
  workout_token: z.string().optional(),
  workout_type_id: z.number(),
  starts: z.string(),
  minutes: z.number().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  workout_summary: wahooWorkoutSummarySchema.optional(),
});

export type WahooWorkout = z.infer<typeof wahooWorkoutSchema>;

export const wahooWorkoutListResponseSchema = z.object({
  workouts: z.array(wahooWorkoutSchema),
  total: z.number(),
  page: z.number(),
  per_page: z.number(),
  order: z.string(),
  sort: z.string(),
});

export type WahooWorkoutListResponse = z.infer<typeof wahooWorkoutListResponseSchema>;

export const wahooSingleWorkoutResponseSchema = z.object({
  workout: wahooWorkoutSchema,
});

/**
 * Wahoo webhook payload schema. The payload contains the full workout and
 * workout_summary data inline, so we can upsert directly without API calls.
 */
export const wahooWebhookPayloadSchema = z.object({
  event_type: z.string().optional(),
  webhook_token: z.string().optional(),
  user: z.object({ id: z.number() }),
  workout_summary: wahooWorkoutSummarySchema.optional(),
  workout: wahooWorkoutSchema.optional(),
});
