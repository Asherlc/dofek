import { z } from "zod";
import { ProviderHttpClient } from "../http-client.ts";

export const WAHOO_API_BASE = "https://api.wahooligan.com";

// ── Schemas ──

/**
 * Wahoo's API returns numeric fields as strings or null — coerce to number
 * or undefined so downstream code always sees `number | undefined`.
 */
export function createWahooNumeric() {
  return z.preprocess(
    (val) => (val === null || val === undefined ? undefined : Number(val)),
    z.number().optional(),
  );
}

export const wahooNumeric = createWahooNumeric();

export function createWahooWorkoutSummarySchema() {
  return z.object({
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
}

export const wahooWorkoutSummarySchema = createWahooWorkoutSummarySchema();

export type WahooWorkoutSummary = z.infer<typeof wahooWorkoutSummarySchema>;

export function createWahooWorkoutSchema() {
  return z.object({
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
}

export const wahooWorkoutSchema = createWahooWorkoutSchema();

export type WahooWorkout = z.infer<typeof wahooWorkoutSchema>;

export function createWahooWorkoutListResponseSchema() {
  return z.object({
    workouts: z.array(wahooWorkoutSchema),
    total: z.number(),
    page: z.number(),
    per_page: z.number(),
    order: z.string(),
    sort: z.string(),
  });
}

export const wahooWorkoutListResponseSchema = createWahooWorkoutListResponseSchema();

export type WahooWorkoutListResponse = z.infer<typeof wahooWorkoutListResponseSchema>;

export function createWahooSingleWorkoutResponseSchema() {
  return z.object({
    workout: wahooWorkoutSchema,
  });
}

export const wahooSingleWorkoutResponseSchema = createWahooSingleWorkoutResponseSchema();

export function createWahooWebhookPayloadSchema() {
  return z.object({
    event_type: z.string().optional(),
    webhook_token: z.string().optional(),
    user: z.object({ id: z.number() }),
    workout_summary: wahooWorkoutSummarySchema.optional(),
    workout: wahooWorkoutSchema.optional(),
  });
}

/**
 * Wahoo webhook payload schema. The payload contains the full workout and
 * workout_summary data inline, so we can upsert directly without API calls.
 */
export const wahooWebhookPayloadSchema = createWahooWebhookPayloadSchema();

// ── Client ──

export class WahooClient extends ProviderHttpClient {
  constructor(accessToken: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    super(accessToken, WAHOO_API_BASE, fetchFn);
  }

  async getWorkouts(page = 1, perPage = 30): Promise<WahooWorkoutListResponse> {
    return this.get("/v1/workouts", wahooWorkoutListResponseSchema, {
      page: String(page),
      per_page: String(perPage),
    });
  }

  async getWorkout(id: number): Promise<z.infer<typeof wahooSingleWorkoutResponseSchema>> {
    return this.get(`/v1/workouts/${id}`, wahooSingleWorkoutResponseSchema);
  }

  async downloadFitFile(url: string): Promise<Buffer> {
    // FIT file URLs are pre-signed CDN/S3 URLs — do not send auth headers,
    // as it causes 403 errors and leaks the OAuth token to a third party.
    const response = await this.fetchFn(url);
    if (!response.ok) {
      throw new Error(`Failed to download FIT file (${response.status})`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
