import { z } from "zod";

export const ouraSleepDocumentSchema = z.object({
  id: z.string(),
  day: z.string(),
  bedtime_start: z.string(),
  bedtime_end: z.string(),
  total_sleep_duration: z.number().nullable(),
  deep_sleep_duration: z.number().nullable(),
  rem_sleep_duration: z.number().nullable(),
  light_sleep_duration: z.number().nullable(),
  awake_time: z.number().nullable(),
  efficiency: z.number(),
  type: z.enum(["long_sleep", "rest", "sleep", "late_nap"]),
  average_heart_rate: z.number().nullable(),
  lowest_heart_rate: z.number().nullable(),
  average_hrv: z.number().nullable(),
  time_in_bed: z.number(),
  readiness_score_delta: z.number().nullable(),
  latency: z.number().nullable(),
});

export type OuraSleepDocument = z.infer<typeof ouraSleepDocumentSchema>;

export const ouraDailyActivitySchema = z.object({
  id: z.string(),
  day: z.string(),
  steps: z.number(),
  active_calories: z.number(),
  equivalent_walking_distance: z.number(),
  high_activity_time: z.number(),
  medium_activity_time: z.number(),
  low_activity_time: z.number(),
  resting_time: z.number(),
  sedentary_time: z.number(),
  total_calories: z.number(),
});

export type OuraDailyActivity = z.infer<typeof ouraDailyActivitySchema>;

export const ouraDailySpO2Schema = z.object({
  id: z.string(),
  day: z.string(),
  spo2_percentage: z.object({ average: z.number() }).nullable(),
  breathing_disturbance_index: z.number().nullable(),
});

export type OuraDailySpO2 = z.infer<typeof ouraDailySpO2Schema>;

export const ouraWorkoutSchema = z.object({
  id: z.string(),
  activity: z.string(),
  calories: z.number().nullable(),
  day: z.string(),
  distance: z.number().nullable(),
  end_datetime: z.string(),
  intensity: z.enum(["easy", "moderate", "hard"]),
  label: z.string().nullable(),
  source: z.enum(["manual", "autodetected", "confirmed", "workout_heart_rate"]),
  start_datetime: z.string(),
});

export type OuraWorkout = z.infer<typeof ouraWorkoutSchema>;

export const ouraHeartRateSchema = z.object({
  bpm: z.number(),
  source: z.enum(["awake", "rest", "sleep", "session", "live", "workout"]),
  timestamp: z.string(),
});

export type OuraHeartRate = z.infer<typeof ouraHeartRateSchema>;

export const ouraSessionSchema = z.object({
  id: z.string(),
  day: z.string(),
  start_datetime: z.string(),
  end_datetime: z.string(),
  type: z.enum(["breathing", "meditation", "nap", "relaxation", "rest", "body_status"]),
  mood: z.enum(["bad", "worse", "same", "good", "great"]).nullable(),
});

export type OuraSession = z.infer<typeof ouraSessionSchema>;

export const ouraTagSchema = z.object({
  id: z.string(),
  day: z.string(),
  text: z.string().nullable(),
  timestamp: z.string(),
  tags: z.array(z.string()),
});

export type OuraTag = z.infer<typeof ouraTagSchema>;

export const ouraEnhancedTagSchema = z.object({
  id: z.string(),
  tag_type_code: z.string().nullable(),
  start_time: z.string(),
  end_time: z.string().nullable(),
  start_day: z.string(),
  end_day: z.string().nullable(),
  comment: z.string().nullable(),
  custom_name: z.string().nullable(),
});

export type OuraEnhancedTag = z.infer<typeof ouraEnhancedTagSchema>;

export const ouraRestModePeriodSchema = z.object({
  id: z.string(),
  end_day: z.string().nullable(),
  end_time: z.string().nullable(),
  start_day: z.string(),
  start_time: z.string().nullable(),
});

export type OuraRestModePeriod = z.infer<typeof ouraRestModePeriodSchema>;

export function ouraListResponseSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    data: z.array(itemSchema),
    next_token: z.string().nullish(),
  });
}

export interface OuraListResponse<T> {
  data: T[];
  next_token?: string | null;
}
