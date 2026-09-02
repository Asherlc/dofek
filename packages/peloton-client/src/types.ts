import { z } from "zod";

export const pelotonInstructorSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  image_url: z.string().optional(),
});

export const pelotonRideSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  duration: z.number(),
  difficulty_rating_avg: z.number().optional(),
  overall_rating_avg: z.number().optional(),
  instructor: pelotonInstructorSchema.optional(),
});

export const pelotonWorkoutSchema = z.object({
  id: z.string(),
  status: z.string(),
  fitness_discipline: z.string(),
  name: z.string().optional(),
  title: z.string().nullish(),
  created_at: z.number(),
  start_time: z.number(),
  end_time: z.number().nullable(),
  total_work: z.number().nullish(),
  is_total_work_personal_record: z.boolean(),
  metrics_type: z.string().nullish(),
  device_type: z.string().optional(),
  platform: z.string().optional(),
  peloton_id: z.string().nullish(),
  workout_type: z.string().optional(),
  has_pedaling_metrics: z.boolean().optional(),
  has_leaderboard_metrics: z.boolean().optional(),
  timezone: z.string().optional(),
  strava_id: z.string().nullish(),
  ride: pelotonRideSchema.optional(),
  total_leaderboard_users: z.number().optional(),
  leaderboard_rank: z.number().optional(),
  average_effort_score: z.number().nullable().optional(),
});

export const pelotonWorkoutListResponseSchema = z.object({
  data: z.array(pelotonWorkoutSchema),
  total: z.number(),
  count: z.number(),
  page: z.number(),
  limit: z.number(),
  page_count: z.number(),
  sort_by: z.string(),
  show_next: z.boolean(),
  show_previous: z.boolean(),
});

export const pelotonMetricSchema = z.object({
  display_name: z.string(),
  slug: z.string(),
  values: z.array(z.number()),
  average_value: z.number(),
  max_value: z.number(),
});

const pelotonSummarySchema = z.object({
  display_name: z.string(),
  value: z.number(),
  slug: z.string(),
});

export const pelotonPerformanceGraphSchema = z.object({
  duration: z.number(),
  is_class_plan_shown: z.boolean(),
  segment_list: z.array(z.unknown()),
  average_summaries: z.array(pelotonSummarySchema),
  summaries: z.array(pelotonSummarySchema),
  metrics: z.array(pelotonMetricSchema),
});

export type PelotonInstructor = z.infer<typeof pelotonInstructorSchema>;
export type PelotonRide = z.infer<typeof pelotonRideSchema>;
export type PelotonWorkout = z.infer<typeof pelotonWorkoutSchema>;
export type PelotonWorkoutListResponse = z.infer<typeof pelotonWorkoutListResponseSchema>;
export type PelotonMetric = z.infer<typeof pelotonMetricSchema>;
export type PelotonPerformanceGraph = z.infer<typeof pelotonPerformanceGraphSchema>;

export interface PelotonOAuthConfig {
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
  scopes: string[];
  usePkce: true;
  audience: string;
}

export interface PelotonTokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string | null;
}
