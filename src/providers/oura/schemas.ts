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

export const ouraDailyReadinessSchema = z.object({
  id: z.string(),
  day: z.string(),
  score: z.number().nullable(),
  temperature_deviation: z.number().nullable(),
  temperature_trend_deviation: z.number().nullable(),
  contributors: z.object({
    resting_heart_rate: z.number().nullable(),
    hrv_balance: z.number().nullable(),
    body_temperature: z.number().nullable(),
    recovery_index: z.number().nullable(),
    sleep_balance: z.number().nullable(),
    previous_night: z.number().nullable(),
    previous_day_activity: z.number().nullable(),
    activity_balance: z.number().nullable(),
  }),
});

export type OuraDailyReadiness = z.infer<typeof ouraDailyReadinessSchema>;

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

export const ouraVO2MaxSchema = z.object({
  id: z.string(),
  day: z.string(),
  timestamp: z.string(),
  vo2_max: z.number().nullable(),
});

export type OuraVO2Max = z.infer<typeof ouraVO2MaxSchema>;

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

export const ouraDailyStressSchema = z.object({
  id: z.string(),
  day: z.string(),
  stress_high: z.number().nullable(),
  recovery_high: z.number().nullable(),
  day_summary: z.enum(["restored", "normal", "stressful"]).nullable(),
});

export type OuraDailyStress = z.infer<typeof ouraDailyStressSchema>;

export const ouraDailyResilienceSchema = z.object({
  id: z.string(),
  day: z.string(),
  contributors: z.object({
    sleep_recovery: z.number(),
    daytime_recovery: z.number(),
    stress: z.number(),
  }),
  level: z.enum(["limited", "adequate", "solid", "strong", "exceptional"]),
});

export type OuraDailyResilience = z.infer<typeof ouraDailyResilienceSchema>;

export const ouraDailyCardiovascularAgeSchema = z.object({
  day: z.string(),
  vascular_age: z.number().nullable(),
});

export type OuraDailyCardiovascularAge = z.infer<typeof ouraDailyCardiovascularAgeSchema>;

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

export const ouraSleepTimeSchema = z.object({
  id: z.string(),
  day: z.string(),
  optimal_bedtime: z
    .object({
      day_tz: z.number(),
      end_offset: z.number(),
      start_offset: z.number(),
    })
    .nullable(),
  recommendation: z
    .enum([
      "improve_efficiency",
      "earlier_bedtime",
      "later_bedtime",
      "earlier_wake_up_time",
      "later_wake_up_time",
      "follow_optimal_bedtime",
    ])
    .nullable(),
  status: z
    .enum([
      "not_enough_nights",
      "not_enough_recent_nights",
      "bad_sleep_quality",
      "only_recommended_found",
      "optimal_found",
    ])
    .nullable(),
});

export type OuraSleepTime = z.infer<typeof ouraSleepTimeSchema>;

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
