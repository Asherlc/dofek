import {
  type CanonicalActivityType,
  createActivityTypeMapper,
  OURA_ACTIVITY_TYPE_MAP,
} from "@dofek/training/training";
import { z } from "zod";
import type { OAuthConfig } from "../auth/oauth.ts";
import { exchangeCodeForTokens, getOAuthRedirectUri } from "../auth/oauth.ts";
import { resolveOAuthTokens } from "../auth/resolve-tokens.ts";
import type { SyncDatabase } from "../db/index.ts";
import { activity, dailyMetrics, healthEvent, metricStream, sleepSession } from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider } from "../db/tokens.ts";
import { logger } from "../logger.ts";
import { ProviderHttpClient } from "./http-client.ts";
import type {
  ProviderAuthSetup,
  ProviderIdentity,
  SyncError,
  SyncOptions,
  SyncResult,
  WebhookEvent,
  WebhookProvider,
} from "./types.ts";

// ============================================================
// Oura API v2 Zod schemas
// ============================================================

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

function ouraListResponseSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    data: z.array(itemSchema),
    next_token: z.string().nullish(),
  });
}

interface OuraListResponse<T> {
  data: T[];
  next_token?: string | null;
}

// ============================================================
// Parsed types
// ============================================================

export interface ParsedOuraSleep {
  externalId: string;
  startedAt: Date;
  endedAt: Date;
  durationMinutes?: number;
  deepMinutes?: number;
  remMinutes?: number;
  lightMinutes?: number;
  awakeMinutes?: number;
  efficiencyPct: number;
  sleepType: OuraSleepDocument["type"];
  isNap: boolean;
}

export interface ParsedOuraDailyMetrics {
  date: string;
  steps?: number;
  activeEnergyKcal?: number;
  hrv?: number;
  restingHr?: number;
  exerciseMinutes?: number;
  skinTempC?: number;
  spo2Avg?: number;
  vo2max?: number;
  stressHighMinutes?: number;
  recoveryHighMinutes?: number;
  resilienceLevel?: string;
}

// ============================================================
// Parsing — pure functions
// ============================================================

function secondsToMinutes(seconds: number | null): number | undefined {
  if (seconds === null) return undefined;
  return Math.round(seconds / 60);
}

export function parseOuraSleep(sleep: OuraSleepDocument): ParsedOuraSleep {
  return {
    externalId: sleep.id,
    startedAt: new Date(sleep.bedtime_start),
    endedAt: new Date(sleep.bedtime_end),
    durationMinutes: secondsToMinutes(sleep.total_sleep_duration),
    deepMinutes: secondsToMinutes(sleep.deep_sleep_duration),
    remMinutes: secondsToMinutes(sleep.rem_sleep_duration),
    lightMinutes: secondsToMinutes(sleep.light_sleep_duration),
    awakeMinutes: secondsToMinutes(sleep.awake_time),
    efficiencyPct: sleep.efficiency,
    sleepType: sleep.type,
    isNap: sleep.type !== "long_sleep" && sleep.type !== "sleep",
  };
}

export function parseOuraDailyMetrics(
  readiness: OuraDailyReadiness | null,
  activity: OuraDailyActivity | null,
  spo2: OuraDailySpO2 | null,
  vo2max: OuraVO2Max | null,
  stress: OuraDailyStress | null,
  resilience: OuraDailyResilience | null,
): ParsedOuraDailyMetrics {
  const day =
    readiness?.day ??
    activity?.day ??
    spo2?.day ??
    vo2max?.day ??
    stress?.day ??
    resilience?.day ??
    "";

  let exerciseMinutes: number | undefined;
  if (activity) {
    exerciseMinutes = Math.round(
      (activity.high_activity_time + activity.medium_activity_time) / 60,
    );
  }

  return {
    date: day,
    steps: activity?.steps,
    activeEnergyKcal: activity?.active_calories,
    hrv: readiness?.contributors.hrv_balance ?? undefined,
    restingHr: readiness?.contributors.resting_heart_rate ?? undefined,
    exerciseMinutes,
    skinTempC: readiness?.temperature_deviation ?? undefined,
    spo2Avg: spo2?.spo2_percentage?.average ?? undefined,
    vo2max: vo2max?.vo2_max ?? undefined,
    stressHighMinutes: secondsToMinutes(stress?.stress_high ?? null),
    recoveryHighMinutes: secondsToMinutes(stress?.recovery_high ?? null),
    resilienceLevel: resilience?.level ?? undefined,
  };
}

const mapOuraType = createActivityTypeMapper(OURA_ACTIVITY_TYPE_MAP);

export function mapOuraActivityType(ouraActivity: string): CanonicalActivityType {
  const key = ouraActivity.toLowerCase();
  return mapOuraType(key);
}

const OURA_SESSION_TYPE_MAP: Record<string, CanonicalActivityType> = {
  meditation: "meditation",
  breathing: "breathwork",
  nap: "other",
  relaxation: "other",
  rest: "other",
  body_status: "other",
};

function mapOuraSessionType(sessionType: string): CanonicalActivityType {
  return OURA_SESSION_TYPE_MAP[sessionType] ?? "other";
}

// ============================================================
// Oura API client
// ============================================================

const OURA_API_BASE = "https://api.ouraring.com";

export class OuraClient extends ProviderHttpClient {
  constructor(accessToken: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    super(accessToken, OURA_API_BASE, fetchFn);
  }

  #dateQuery(startDate: string, endDate: string, nextToken?: string): string {
    let qs = `start_date=${startDate}&end_date=${endDate}`;
    if (nextToken) qs += `&next_token=${nextToken}`;
    return qs;
  }

  async getSleep(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraSleepDocument>> {
    return this.get(
      `/v2/usercollection/sleep?${this.#dateQuery(startDate, endDate, nextToken)}`,
      ouraListResponseSchema(ouraSleepDocumentSchema),
    );
  }

  async getDailyReadiness(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraDailyReadiness>> {
    return this.get(
      `/v2/usercollection/daily_readiness?${this.#dateQuery(startDate, endDate, nextToken)}`,
      ouraListResponseSchema(ouraDailyReadinessSchema),
    );
  }

  async getDailyActivity(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraDailyActivity>> {
    return this.get(
      `/v2/usercollection/daily_activity?${this.#dateQuery(startDate, endDate, nextToken)}`,
      ouraListResponseSchema(ouraDailyActivitySchema),
    );
  }

  async getDailySpO2(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraDailySpO2>> {
    return this.get(
      `/v2/usercollection/daily_spo2?${this.#dateQuery(startDate, endDate, nextToken)}`,
      ouraListResponseSchema(ouraDailySpO2Schema),
    );
  }

  async getVO2Max(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraVO2Max>> {
    return this.get(
      `/v2/usercollection/vO2_max?${this.#dateQuery(startDate, endDate, nextToken)}`,
      ouraListResponseSchema(ouraVO2MaxSchema),
    );
  }

  async getWorkouts(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraWorkout>> {
    return this.get(
      `/v2/usercollection/workout?${this.#dateQuery(startDate, endDate, nextToken)}`,
      ouraListResponseSchema(ouraWorkoutSchema),
    );
  }

  async getHeartRate(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraHeartRate>> {
    let qs = `start_datetime=${startDate}T00:00:00&end_datetime=${endDate}T23:59:59`;
    if (nextToken) qs += `&next_token=${nextToken}`;
    return this.get(
      `/v2/usercollection/heartrate?${qs}`,
      ouraListResponseSchema(ouraHeartRateSchema),
    );
  }

  async getSessions(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraSession>> {
    return this.get(
      `/v2/usercollection/session?${this.#dateQuery(startDate, endDate, nextToken)}`,
      ouraListResponseSchema(ouraSessionSchema),
    );
  }

  async getDailyStress(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraDailyStress>> {
    return this.get(
      `/v2/usercollection/daily_stress?${this.#dateQuery(startDate, endDate, nextToken)}`,
      ouraListResponseSchema(ouraDailyStressSchema),
    );
  }

  async getDailyResilience(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraDailyResilience>> {
    return this.get(
      `/v2/usercollection/daily_resilience?${this.#dateQuery(startDate, endDate, nextToken)}`,
      ouraListResponseSchema(ouraDailyResilienceSchema),
    );
  }

  async getDailyCardiovascularAge(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraDailyCardiovascularAge>> {
    return this.get(
      `/v2/usercollection/daily_cardiovascular_age?${this.#dateQuery(startDate, endDate, nextToken)}`,
      ouraListResponseSchema(ouraDailyCardiovascularAgeSchema),
    );
  }

  async getTags(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraTag>> {
    return this.get(
      `/v2/usercollection/tag?${this.#dateQuery(startDate, endDate, nextToken)}`,
      ouraListResponseSchema(ouraTagSchema),
    );
  }

  async getEnhancedTags(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraEnhancedTag>> {
    return this.get(
      `/v2/usercollection/enhanced_tag?${this.#dateQuery(startDate, endDate, nextToken)}`,
      ouraListResponseSchema(ouraEnhancedTagSchema),
    );
  }

  async getRestModePeriods(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraRestModePeriod>> {
    return this.get(
      `/v2/usercollection/rest_mode_period?${this.#dateQuery(startDate, endDate, nextToken)}`,
      ouraListResponseSchema(ouraRestModePeriodSchema),
    );
  }

  async getSleepTime(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraSleepTime>> {
    return this.get(
      `/v2/usercollection/sleep_time?${this.#dateQuery(startDate, endDate, nextToken)}`,
      ouraListResponseSchema(ouraSleepTimeSchema),
    );
  }
}

// ============================================================
// OAuth configuration
// ============================================================

export function ouraOAuthConfig(): OAuthConfig | null {
  const clientId = process.env.OURA_CLIENT_ID;
  const clientSecret = process.env.OURA_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  return {
    clientId,
    clientSecret,
    authorizeUrl: "https://cloud.ouraring.com/oauth/authorize",
    tokenUrl: `${OURA_API_BASE}/oauth/token`,
    redirectUri: getOAuthRedirectUri(),
    scopes: [
      "daily",
      "email",
      "heartrate",
      "heart_health",
      "personal",
      "session",
      "spo2",
      "stress",
      "workout",
      "tag",
    ],
  };
}

// ============================================================
// Helper: format date as YYYY-MM-DD
// ============================================================

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ============================================================
// Helper: paginate through all results
// ============================================================

async function fetchAllPages<T>(
  fetchPage: (nextToken?: string) => Promise<OuraListResponse<T>>,
): Promise<T[]> {
  const allData: T[] = [];
  let nextToken: string | undefined;

  do {
    const response = await fetchPage(nextToken);
    allData.push(...response.data);
    nextToken = response.next_token ?? undefined;
  } while (nextToken);

  return allData;
}

/**
 * Like fetchAllPages, but returns an empty array on 401 (missing OAuth scope).
 * Use for endpoints that require optional OAuth scopes (stress, heart_health).
 */
export async function fetchAllPagesOptional<T>(
  fetchPage: (nextToken?: string) => Promise<OuraListResponse<T>>,
  endpointName: string,
): Promise<T[]> {
  try {
    return await fetchAllPages(fetchPage);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("API error 401")) {
      logger.warn(`[oura] Skipping ${endpointName}: missing required OAuth scope`);
      return [];
    }
    throw err;
  }
}

// ============================================================
// Batch size for metric stream inserts
// ============================================================

const METRIC_STREAM_BATCH_SIZE = 500;
const HEALTH_EVENT_BATCH_SIZE = 1000;

// ============================================================
// Provider implementation
// ============================================================

export class OuraProvider implements WebhookProvider {
  readonly id = "oura";
  readonly name = "Oura";
  readonly webhookScope = "app" as const;
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = fetchFn;
  }

  validate(): string | null {
    if (!process.env.OURA_CLIENT_ID) return "OURA_CLIENT_ID is not set";
    if (!process.env.OURA_CLIENT_SECRET) return "OURA_CLIENT_SECRET is not set";
    return null;
  }

  // ── Webhook implementation ──

  async registerWebhook(
    callbackUrl: string,
    verifyToken: string,
  ): Promise<{ subscriptionId: string; signingSecret?: string; expiresAt?: Date }> {
    const clientId = process.env.OURA_CLIENT_ID;
    const clientSecret = process.env.OURA_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("OURA_CLIENT_ID and OURA_CLIENT_SECRET are required");
    }

    // Oura requires one subscription per data type. We register for all supported types.
    const dataTypes = [
      "daily_activity",
      "daily_readiness",
      "daily_sleep",
      "workout",
      "session",
      "daily_spo2",
      "daily_stress",
      "daily_resilience",
    ];

    let subscriptionId = "";
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // ~30 days

    for (const dataType of dataTypes) {
      const response = await this.#fetchFn("https://api.ouraring.com/v2/webhook/subscription", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-client-id": clientId,
          "x-client-secret": clientSecret,
        },
        body: JSON.stringify({
          callback_url: callbackUrl,
          verification_token: verifyToken,
          event_type: `create.${dataType}`,
          data_type: dataType,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        // 409 means subscription already exists — continue
        if (response.status !== 409) {
          throw new Error(
            `Oura webhook registration for ${dataType} failed (${response.status}): ${text}`,
          );
        }
      } else {
        const data: { id?: string } = await response.json();
        if (data.id && !subscriptionId) subscriptionId = data.id;
      }
    }

    return { subscriptionId: subscriptionId || "oura-multi-subscription", expiresAt };
  }

  async unregisterWebhook(subscriptionId: string): Promise<void> {
    const clientId = process.env.OURA_CLIENT_ID;
    const clientSecret = process.env.OURA_CLIENT_SECRET;
    if (!clientId || !clientSecret) return;

    await this.#fetchFn(`https://api.ouraring.com/v2/webhook/subscription/${subscriptionId}`, {
      method: "DELETE",
      headers: {
        "x-client-id": clientId,
        "x-client-secret": clientSecret,
      },
    });
  }

  verifyWebhookSignature(
    _rawBody: Buffer,
    _headers: Record<string, string | string[] | undefined>,
    _signingSecret: string,
  ): boolean {
    // Oura verifies via the verification_token challenge at registration time.
    // Incoming events are trusted after successful registration.
    return true;
  }

  parseWebhookPayload(body: unknown): WebhookEvent[] {
    // Oura sends a single event or a verification challenge
    const verificationCheck = z.object({ verification_token: z.string() }).safeParse(body);

    // Verification challenge — not a real event
    if (verificationCheck.success) return [];

    const parsed = z
      .object({
        event_type: z.string().optional(),
        data_type: z.string(),
        user_id: z.string(),
      })
      .safeParse(body);

    if (!parsed.success) return [];
    const event = parsed.data;

    return [
      {
        ownerExternalId: event.user_id,
        eventType: "create",
        objectType: event.data_type,
      },
    ];
  }

  handleValidationChallenge(_query: Record<string, string>, _verifyToken: string): unknown | null {
    // Oura uses POST for verification (sends verification_token in body).
    // This is handled in the POST path — parseWebhookPayload returns empty for verification.
    return null;
  }

  authSetup(): ProviderAuthSetup {
    const config = ouraOAuthConfig();
    if (!config) throw new Error("OURA_CLIENT_ID and OURA_CLIENT_SECRET are required");
    const fetchFn = this.#fetchFn;

    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeCodeForTokens(config, code, fetchFn),
      apiBaseUrl: OURA_API_BASE,
      getUserIdentity: async (accessToken: string): Promise<ProviderIdentity> => {
        const response = await fetchFn(`${OURA_API_BASE}/v2/usercollection/personal_info`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Oura personal info API error (${response.status}): ${text}`);
        }
        const ouraPersonalInfoSchema = z.object({
          id: z.string(),
          email: z.string().nullish(),
        });
        const data = ouraPersonalInfoSchema.parse(await response.json());
        return {
          providerAccountId: data.id,
          email: data.email ?? null,
          name: null,
        };
      },
    };
  }

  async #resolveAccessToken(db: SyncDatabase): Promise<string> {
    const tokens = await resolveOAuthTokens({
      db,
      providerId: this.id,
      providerName: this.name,
      getOAuthConfig: () => ouraOAuthConfig(),
      fetchFn: this.#fetchFn,
    });
    return tokens.accessToken;
  }

  async sync(db: SyncDatabase, since: Date, options?: SyncOptions): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, OURA_API_BASE);

    let accessToken: string;
    try {
      accessToken = await this.#resolveAccessToken(db);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const client = new OuraClient(accessToken, this.#fetchFn);
    const sinceDate = formatDate(since);
    const todayDate = formatDate(new Date());

    // 1. Sync sleep sessions
    try {
      const sleepCount = await withSyncLog(
        db,
        this.id,
        "sleep",
        async () => {
          let count = 0;
          const allSleep = await fetchAllPages((nextToken) =>
            client.getSleep(sinceDate, todayDate, nextToken),
          );

          for (const raw of allSleep) {
            const parsed = parseOuraSleep(raw);
            try {
              await db
                .insert(sleepSession)
                .values({
                  providerId: this.id,
                  externalId: parsed.externalId,
                  startedAt: parsed.startedAt,
                  endedAt: parsed.endedAt,
                  durationMinutes: parsed.durationMinutes,
                  deepMinutes: parsed.deepMinutes,
                  remMinutes: parsed.remMinutes,
                  lightMinutes: parsed.lightMinutes,
                  awakeMinutes: parsed.awakeMinutes,
                  efficiencyPct: parsed.efficiencyPct,
                  sleepType: parsed.sleepType,
                })
                .onConflictDoUpdate({
                  target: [sleepSession.providerId, sleepSession.externalId],
                  set: {
                    startedAt: parsed.startedAt,
                    endedAt: parsed.endedAt,
                    durationMinutes: parsed.durationMinutes,
                    deepMinutes: parsed.deepMinutes,
                    remMinutes: parsed.remMinutes,
                    lightMinutes: parsed.lightMinutes,
                    awakeMinutes: parsed.awakeMinutes,
                    efficiencyPct: parsed.efficiencyPct,
                    sleepType: parsed.sleepType,
                  },
                });
              count++;
            } catch (err) {
              errors.push({
                message: err instanceof Error ? err.message : String(err),
                externalId: parsed.externalId,
                cause: err,
              });
            }
          }

          return { recordCount: count, result: count };
        },
        options?.userId,
      );
      recordsSynced += sleepCount;
    } catch (err) {
      errors.push({
        message: `sleep: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 2. Sync workouts → activity table
    try {
      const workoutCount = await withSyncLog(
        db,
        this.id,
        "workouts",
        async () => {
          let count = 0;
          const allWorkouts = await fetchAllPages((nextToken) =>
            client.getWorkouts(sinceDate, todayDate, nextToken),
          );

          for (const w of allWorkouts) {
            try {
              await db
                .insert(activity)
                .values({
                  providerId: this.id,
                  externalId: w.id,
                  activityType: mapOuraActivityType(w.activity),
                  startedAt: new Date(w.start_datetime),
                  endedAt: new Date(w.end_datetime),
                  name: w.label,
                  raw: w,
                })
                .onConflictDoUpdate({
                  target: [activity.providerId, activity.externalId],
                  set: {
                    activityType: mapOuraActivityType(w.activity),
                    startedAt: new Date(w.start_datetime),
                    endedAt: new Date(w.end_datetime),
                    name: w.label,
                    raw: w,
                  },
                });
              count++;
            } catch (err) {
              errors.push({
                message: `workout ${w.id}: ${err instanceof Error ? err.message : String(err)}`,
                externalId: w.id,
                cause: err,
              });
            }
          }

          return { recordCount: count, result: count };
        },
        options?.userId,
      );
      recordsSynced += workoutCount;
    } catch (err) {
      errors.push({
        message: `workouts: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 3. Sync sessions (meditation, breathing, etc.) → activity table
    try {
      const sessionCount = await withSyncLog(
        db,
        this.id,
        "sessions",
        async () => {
          let count = 0;
          const allSessions = await fetchAllPages((nextToken) =>
            client.getSessions(sinceDate, todayDate, nextToken),
          );

          for (const s of allSessions) {
            try {
              const sessionActivityType = mapOuraSessionType(s.type);
              await db
                .insert(activity)
                .values({
                  providerId: this.id,
                  externalId: s.id,
                  activityType: sessionActivityType,
                  startedAt: new Date(s.start_datetime),
                  endedAt: new Date(s.end_datetime),
                  name: s.type,
                  raw: s,
                })
                .onConflictDoUpdate({
                  target: [activity.providerId, activity.externalId],
                  set: {
                    activityType: sessionActivityType,
                    startedAt: new Date(s.start_datetime),
                    endedAt: new Date(s.end_datetime),
                    name: s.type,
                    raw: s,
                  },
                });
              count++;
            } catch (err) {
              errors.push({
                message: `session ${s.id}: ${err instanceof Error ? err.message : String(err)}`,
                externalId: s.id,
                cause: err,
              });
            }
          }

          return { recordCount: count, result: count };
        },
        options?.userId,
      );
      recordsSynced += sessionCount;
    } catch (err) {
      errors.push({
        message: `sessions: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 4. Sync heart rate → metricStream table (batched)
    // Oura heart rate API enforces a max 30-day window per request
    try {
      const hrCount = await withSyncLog(
        db,
        this.id,
        "heart_rate",
        async () => {
          const allHr: OuraHeartRate[] = [];
          const windowMs = 30 * 24 * 60 * 60 * 1000;
          let windowStart = since.getTime();
          const end = Date.now();

          while (windowStart < end) {
            const windowEnd = Math.min(windowStart + windowMs, end);
            const startStr = formatDate(new Date(windowStart));
            const endStr = formatDate(new Date(windowEnd));
            const chunk = await fetchAllPages((nextToken) =>
              client.getHeartRate(startStr, endStr, nextToken),
            );
            allHr.push(...chunk);
            windowStart = windowEnd;
          }

          const rows = allHr.map((hr) => ({
            providerId: this.id,
            recordedAt: new Date(hr.timestamp),
            heartRate: hr.bpm,
          }));

          for (let i = 0; i < rows.length; i += METRIC_STREAM_BATCH_SIZE) {
            await db
              .insert(metricStream)
              .values(rows.slice(i, i + METRIC_STREAM_BATCH_SIZE))
              .onConflictDoNothing();
          }

          return { recordCount: rows.length, result: rows.length };
        },
        options?.userId,
      );
      recordsSynced += hrCount;
    } catch (err) {
      errors.push({
        message: `heart_rate: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 5. Sync daily stress → healthEvent table
    try {
      const stressCount = await withSyncLog(
        db,
        this.id,
        "daily_stress",
        async () => {
          const allStress = await fetchAllPagesOptional(
            (nextToken) => client.getDailyStress(sinceDate, todayDate, nextToken),
            "daily_stress",
          );

          const rows = allStress.map((s) => ({
            providerId: this.id,
            externalId: s.id,
            type: "oura_daily_stress",
            value: s.stress_high,
            valueText: s.day_summary,
            startDate: new Date(`${s.day}T00:00:00`),
          }));

          for (let i = 0; i < rows.length; i += HEALTH_EVENT_BATCH_SIZE) {
            await db
              .insert(healthEvent)
              .values(rows.slice(i, i + HEALTH_EVENT_BATCH_SIZE))
              .onConflictDoUpdate({
                target: [healthEvent.providerId, healthEvent.externalId],
                set: {
                  value: rows[i]?.value,
                  valueText: rows[i]?.valueText,
                },
              });
          }

          return { recordCount: rows.length, result: rows.length };
        },
        options?.userId,
      );
      recordsSynced += stressCount;
    } catch (err) {
      errors.push({
        message: `daily_stress: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 6. Sync daily resilience → healthEvent table
    try {
      const resilienceCount = await withSyncLog(
        db,
        this.id,
        "daily_resilience",
        async () => {
          const allResilience = await fetchAllPagesOptional(
            (nextToken) => client.getDailyResilience(sinceDate, todayDate, nextToken),
            "daily_resilience",
          );

          let count = 0;
          for (const r of allResilience) {
            await db
              .insert(healthEvent)
              .values({
                providerId: this.id,
                externalId: r.id,
                type: "oura_daily_resilience",
                valueText: r.level,
                startDate: new Date(`${r.day}T00:00:00`),
              })
              .onConflictDoUpdate({
                target: [healthEvent.providerId, healthEvent.externalId],
                set: {
                  valueText: r.level,
                },
              });
            count++;
          }

          return { recordCount: count, result: count };
        },
        options?.userId,
      );
      recordsSynced += resilienceCount;
    } catch (err) {
      errors.push({
        message: `daily_resilience: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 7. Sync daily cardiovascular age → healthEvent table
    try {
      const cvAgeCount = await withSyncLog(
        db,
        this.id,
        "cardiovascular_age",
        async () => {
          const allCvAge = await fetchAllPagesOptional(
            (nextToken) => client.getDailyCardiovascularAge(sinceDate, todayDate, nextToken),
            "cardiovascular_age",
          );

          let count = 0;
          for (const cv of allCvAge) {
            if (cv.vascular_age === null) continue;
            await db
              .insert(healthEvent)
              .values({
                providerId: this.id,
                externalId: `oura_cv_age:${cv.day}`,
                type: "oura_cardiovascular_age",
                value: cv.vascular_age,
                startDate: new Date(`${cv.day}T00:00:00`),
              })
              .onConflictDoUpdate({
                target: [healthEvent.providerId, healthEvent.externalId],
                set: { value: cv.vascular_age },
              });
            count++;
          }

          return { recordCount: count, result: count };
        },
        options?.userId,
      );
      recordsSynced += cvAgeCount;
    } catch (err) {
      errors.push({
        message: `cardiovascular_age: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 8. Sync tags → healthEvent table
    try {
      const tagCount = await withSyncLog(
        db,
        this.id,
        "tags",
        async () => {
          const allTags = await fetchAllPages((nextToken) =>
            client.getTags(sinceDate, todayDate, nextToken),
          );

          let count = 0;
          for (const t of allTags) {
            await db
              .insert(healthEvent)
              .values({
                providerId: this.id,
                externalId: t.id,
                type: "oura_tag",
                valueText: t.tags.join(", "),
                startDate: new Date(t.timestamp),
              })
              .onConflictDoUpdate({
                target: [healthEvent.providerId, healthEvent.externalId],
                set: { valueText: t.tags.join(", ") },
              });
            count++;
          }

          return { recordCount: count, result: count };
        },
        options?.userId,
      );
      recordsSynced += tagCount;
    } catch (err) {
      errors.push({
        message: `tags: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 9. Sync enhanced tags → healthEvent table
    try {
      const enhancedTagCount = await withSyncLog(
        db,
        this.id,
        "enhanced_tags",
        async () => {
          const allEnhancedTags = await fetchAllPages((nextToken) =>
            client.getEnhancedTags(sinceDate, todayDate, nextToken),
          );

          let count = 0;
          for (const et of allEnhancedTags) {
            const tagName = et.custom_name ?? et.tag_type_code ?? "unknown";
            await db
              .insert(healthEvent)
              .values({
                providerId: this.id,
                externalId: et.id,
                type: "oura_enhanced_tag",
                valueText: tagName,
                startDate: new Date(et.start_time),
                endDate: et.end_time ? new Date(et.end_time) : undefined,
              })
              .onConflictDoUpdate({
                target: [healthEvent.providerId, healthEvent.externalId],
                set: {
                  valueText: tagName,
                  endDate: et.end_time ? new Date(et.end_time) : undefined,
                },
              });
            count++;
          }

          return { recordCount: count, result: count };
        },
        options?.userId,
      );
      recordsSynced += enhancedTagCount;
    } catch (err) {
      errors.push({
        message: `enhanced_tags: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 10. Sync rest mode periods → healthEvent table
    try {
      const restModeCount = await withSyncLog(
        db,
        this.id,
        "rest_mode",
        async () => {
          const allRestMode = await fetchAllPages((nextToken) =>
            client.getRestModePeriods(sinceDate, todayDate, nextToken),
          );

          let count = 0;
          for (const rm of allRestMode) {
            const startDate = rm.start_time
              ? new Date(rm.start_time)
              : new Date(`${rm.start_day}T00:00:00`);
            const endDate = rm.end_time
              ? new Date(rm.end_time)
              : rm.end_day
                ? new Date(`${rm.end_day}T23:59:59`)
                : undefined;

            await db
              .insert(healthEvent)
              .values({
                providerId: this.id,
                externalId: rm.id,
                type: "oura_rest_mode",
                startDate,
                endDate,
              })
              .onConflictDoUpdate({
                target: [healthEvent.providerId, healthEvent.externalId],
                set: { endDate },
              });
            count++;
          }

          return { recordCount: count, result: count };
        },
        options?.userId,
      );
      recordsSynced += restModeCount;
    } catch (err) {
      errors.push({
        message: `rest_mode: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 11. Sync sleep time recommendations → healthEvent table
    try {
      const sleepTimeCount = await withSyncLog(
        db,
        this.id,
        "sleep_time",
        async () => {
          const allSleepTime = await fetchAllPages((nextToken) =>
            client.getSleepTime(sinceDate, todayDate, nextToken),
          );

          let count = 0;
          for (const st of allSleepTime) {
            await db
              .insert(healthEvent)
              .values({
                providerId: this.id,
                externalId: st.id,
                type: "oura_sleep_time",
                valueText: st.recommendation,
                startDate: new Date(`${st.day}T00:00:00`),
              })
              .onConflictDoUpdate({
                target: [healthEvent.providerId, healthEvent.externalId],
                set: { valueText: st.recommendation },
              });
            count++;
          }

          return { recordCount: count, result: count };
        },
        options?.userId,
      );
      recordsSynced += sleepTimeCount;
    } catch (err) {
      errors.push({
        message: `sleep_time: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 12. Sync daily metrics (readiness + activity + SpO2 + VO2 max + stress + resilience merged by day)
    try {
      const dailyCount = await withSyncLog(
        db,
        this.id,
        "daily_metrics",
        async () => {
          let count = 0;

          const [allReadiness, allActivity, allSpO2, allVO2Max, allStress, allResilience] =
            await Promise.all([
              fetchAllPages((nextToken) =>
                client.getDailyReadiness(sinceDate, todayDate, nextToken),
              ),
              fetchAllPages((nextToken) =>
                client.getDailyActivity(sinceDate, todayDate, nextToken),
              ),
              fetchAllPages((nextToken) => client.getDailySpO2(sinceDate, todayDate, nextToken)),
              fetchAllPagesOptional(
                (nextToken) => client.getVO2Max(sinceDate, todayDate, nextToken),
                "vO2_max",
              ),
              fetchAllPagesOptional(
                (nextToken) => client.getDailyStress(sinceDate, todayDate, nextToken),
                "daily_stress",
              ),
              fetchAllPagesOptional(
                (nextToken) => client.getDailyResilience(sinceDate, todayDate, nextToken),
                "daily_resilience",
              ),
            ]);

          // Index by day for merging
          const readinessByDay = new Map<string, OuraDailyReadiness>();
          for (const r of allReadiness) readinessByDay.set(r.day, r);

          const activityByDay = new Map<string, OuraDailyActivity>();
          for (const a of allActivity) activityByDay.set(a.day, a);

          const spo2ByDay = new Map<string, OuraDailySpO2>();
          for (const s of allSpO2) spo2ByDay.set(s.day, s);

          const vo2maxByDay = new Map<string, OuraVO2Max>();
          for (const v of allVO2Max) vo2maxByDay.set(v.day, v);

          const stressByDay = new Map<string, OuraDailyStress>();
          for (const s of allStress) stressByDay.set(s.day, s);

          const resilienceByDay = new Map<string, OuraDailyResilience>();
          for (const r of allResilience) resilienceByDay.set(r.day, r);

          // Union of all days
          const allDays = new Set([
            ...readinessByDay.keys(),
            ...activityByDay.keys(),
            ...spo2ByDay.keys(),
            ...vo2maxByDay.keys(),
            ...stressByDay.keys(),
            ...resilienceByDay.keys(),
          ]);

          for (const day of allDays) {
            const readiness = readinessByDay.get(day) ?? null;
            const activityDoc = activityByDay.get(day) ?? null;
            const spo2 = spo2ByDay.get(day) ?? null;
            const vo2max = vo2maxByDay.get(day) ?? null;
            const stress = stressByDay.get(day) ?? null;
            const resilience = resilienceByDay.get(day) ?? null;
            const parsed = parseOuraDailyMetrics(
              readiness,
              activityDoc,
              spo2,
              vo2max,
              stress,
              resilience,
            );

            try {
              await db
                .insert(dailyMetrics)
                .values({
                  date: parsed.date,
                  providerId: this.id,
                  steps: parsed.steps,
                  restingHr: parsed.restingHr,
                  hrv: parsed.hrv,
                  activeEnergyKcal: parsed.activeEnergyKcal,
                  exerciseMinutes: parsed.exerciseMinutes,
                  skinTempC: parsed.skinTempC,
                  spo2Avg: parsed.spo2Avg,
                  vo2max: parsed.vo2max,
                  stressHighMinutes: parsed.stressHighMinutes,
                  recoveryHighMinutes: parsed.recoveryHighMinutes,
                  resilienceLevel: parsed.resilienceLevel,
                })
                .onConflictDoUpdate({
                  target: [dailyMetrics.date, dailyMetrics.providerId, dailyMetrics.sourceName],
                  set: {
                    steps: parsed.steps,
                    restingHr: parsed.restingHr,
                    hrv: parsed.hrv,
                    activeEnergyKcal: parsed.activeEnergyKcal,
                    exerciseMinutes: parsed.exerciseMinutes,
                    skinTempC: parsed.skinTempC,
                    spo2Avg: parsed.spo2Avg,
                    vo2max: parsed.vo2max,
                    stressHighMinutes: parsed.stressHighMinutes,
                    recoveryHighMinutes: parsed.recoveryHighMinutes,
                    resilienceLevel: parsed.resilienceLevel,
                  },
                });
              count++;
            } catch (err) {
              errors.push({
                message: `daily_metrics ${day}: ${err instanceof Error ? err.message : String(err)}`,
                cause: err,
              });
            }
          }

          return { recordCount: count, result: count };
        },
        options?.userId,
      );
      recordsSynced += dailyCount;
    } catch (err) {
      errors.push({
        message: `daily_metrics: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    return {
      provider: this.id,
      recordsSynced,
      errors,
      duration: Date.now() - start,
    };
  }

  // ── Webhook-triggered targeted sync ──

  async syncWebhookEvent(
    db: SyncDatabase,
    event: WebhookEvent,
    options?: SyncOptions,
  ): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, OURA_API_BASE);

    let accessToken: string;
    try {
      accessToken = await this.#resolveAccessToken(db);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const client = new OuraClient(accessToken, this.#fetchFn);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const sinceDate = formatDate(yesterday);
    const todayDate = formatDate(new Date());
    const dataType = event.objectType;

    // Sync the specific data type that the webhook reported
    switch (dataType) {
      case "workout": {
        try {
          const count = await withSyncLog(
            db,
            this.id,
            "workouts",
            async () => {
              let count = 0;
              const allWorkouts = await fetchAllPages((nextToken) =>
                client.getWorkouts(sinceDate, todayDate, nextToken),
              );

              for (const w of allWorkouts) {
                try {
                  await db
                    .insert(activity)
                    .values({
                      providerId: this.id,
                      externalId: w.id,
                      activityType: mapOuraActivityType(w.activity),
                      startedAt: new Date(w.start_datetime),
                      endedAt: new Date(w.end_datetime),
                      name: w.label,
                      raw: w,
                    })
                    .onConflictDoUpdate({
                      target: [activity.providerId, activity.externalId],
                      set: {
                        activityType: mapOuraActivityType(w.activity),
                        startedAt: new Date(w.start_datetime),
                        endedAt: new Date(w.end_datetime),
                        name: w.label,
                        raw: w,
                      },
                    });
                  count++;
                } catch (err) {
                  errors.push({
                    message: `workout ${w.id}: ${err instanceof Error ? err.message : String(err)}`,
                    externalId: w.id,
                    cause: err,
                  });
                }
              }

              return { recordCount: count, result: count };
            },
            options?.userId,
          );
          recordsSynced += count;
        } catch (err) {
          errors.push({
            message: `workouts: ${err instanceof Error ? err.message : String(err)}`,
            cause: err,
          });
        }
        break;
      }

      case "session": {
        try {
          const count = await withSyncLog(
            db,
            this.id,
            "sessions",
            async () => {
              let count = 0;
              const allSessions = await fetchAllPages((nextToken) =>
                client.getSessions(sinceDate, todayDate, nextToken),
              );

              for (const s of allSessions) {
                try {
                  const sessionActivityType = mapOuraSessionType(s.type);
                  await db
                    .insert(activity)
                    .values({
                      providerId: this.id,
                      externalId: s.id,
                      activityType: sessionActivityType,
                      startedAt: new Date(s.start_datetime),
                      endedAt: new Date(s.end_datetime),
                      name: s.type,
                      raw: s,
                    })
                    .onConflictDoUpdate({
                      target: [activity.providerId, activity.externalId],
                      set: {
                        activityType: sessionActivityType,
                        startedAt: new Date(s.start_datetime),
                        endedAt: new Date(s.end_datetime),
                        name: s.type,
                        raw: s,
                      },
                    });
                  count++;
                } catch (err) {
                  errors.push({
                    message: `session ${s.id}: ${err instanceof Error ? err.message : String(err)}`,
                    externalId: s.id,
                    cause: err,
                  });
                }
              }

              return { recordCount: count, result: count };
            },
            options?.userId,
          );
          recordsSynced += count;
        } catch (err) {
          errors.push({
            message: `sessions: ${err instanceof Error ? err.message : String(err)}`,
            cause: err,
          });
        }
        break;
      }

      case "sleep":
      case "daily_sleep": {
        try {
          const count = await withSyncLog(
            db,
            this.id,
            "sleep",
            async () => {
              let count = 0;
              const allSleep = await fetchAllPages((nextToken) =>
                client.getSleep(sinceDate, todayDate, nextToken),
              );

              for (const raw of allSleep) {
                const parsed = parseOuraSleep(raw);
                try {
                  await db
                    .insert(sleepSession)
                    .values({
                      providerId: this.id,
                      externalId: parsed.externalId,
                      startedAt: parsed.startedAt,
                      endedAt: parsed.endedAt,
                      durationMinutes: parsed.durationMinutes,
                      deepMinutes: parsed.deepMinutes,
                      remMinutes: parsed.remMinutes,
                      lightMinutes: parsed.lightMinutes,
                      awakeMinutes: parsed.awakeMinutes,
                      efficiencyPct: parsed.efficiencyPct,
                      sleepType: parsed.sleepType,
                    })
                    .onConflictDoUpdate({
                      target: [sleepSession.providerId, sleepSession.externalId],
                      set: {
                        startedAt: parsed.startedAt,
                        endedAt: parsed.endedAt,
                        durationMinutes: parsed.durationMinutes,
                        deepMinutes: parsed.deepMinutes,
                        remMinutes: parsed.remMinutes,
                        lightMinutes: parsed.lightMinutes,
                        awakeMinutes: parsed.awakeMinutes,
                        efficiencyPct: parsed.efficiencyPct,
                        sleepType: parsed.sleepType,
                      },
                    });
                  count++;
                } catch (err) {
                  errors.push({
                    message: err instanceof Error ? err.message : String(err),
                    externalId: parsed.externalId,
                    cause: err,
                  });
                }
              }

              return { recordCount: count, result: count };
            },
            options?.userId,
          );
          recordsSynced += count;
        } catch (err) {
          errors.push({
            message: `sleep: ${err instanceof Error ? err.message : String(err)}`,
            cause: err,
          });
        }
        break;
      }

      case "daily_stress": {
        // Sync stress healthEvents
        try {
          const stressCount = await withSyncLog(
            db,
            this.id,
            "daily_stress",
            async () => {
              const allStress = await fetchAllPages((nextToken) =>
                client.getDailyStress(sinceDate, todayDate, nextToken),
              );

              const rows = allStress.map((s) => ({
                providerId: this.id,
                externalId: s.id,
                type: "oura_daily_stress",
                value: s.stress_high,
                valueText: s.day_summary,
                startDate: new Date(`${s.day}T00:00:00`),
              }));

              for (let i = 0; i < rows.length; i += HEALTH_EVENT_BATCH_SIZE) {
                await db
                  .insert(healthEvent)
                  .values(rows.slice(i, i + HEALTH_EVENT_BATCH_SIZE))
                  .onConflictDoUpdate({
                    target: [healthEvent.providerId, healthEvent.externalId],
                    set: {
                      value: rows[i]?.value,
                      valueText: rows[i]?.valueText,
                    },
                  });
              }

              return { recordCount: rows.length, result: rows.length };
            },
            options?.userId,
          );
          recordsSynced += stressCount;
        } catch (err) {
          errors.push({
            message: `daily_stress: ${err instanceof Error ? err.message : String(err)}`,
            cause: err,
          });
        }

        // Also refresh daily metrics composite (stress columns merge into daily_metrics row)
        recordsSynced += await this.#syncDailyMetrics(
          db,
          client,
          sinceDate,
          todayDate,
          errors,
          options,
        );
        break;
      }

      case "daily_resilience": {
        // Sync resilience healthEvents
        try {
          const resilienceCount = await withSyncLog(
            db,
            this.id,
            "daily_resilience",
            async () => {
              const allResilience = await fetchAllPages((nextToken) =>
                client.getDailyResilience(sinceDate, todayDate, nextToken),
              );

              let count = 0;
              for (const r of allResilience) {
                await db
                  .insert(healthEvent)
                  .values({
                    providerId: this.id,
                    externalId: r.id,
                    type: "oura_daily_resilience",
                    valueText: r.level,
                    startDate: new Date(`${r.day}T00:00:00`),
                  })
                  .onConflictDoUpdate({
                    target: [healthEvent.providerId, healthEvent.externalId],
                    set: {
                      valueText: r.level,
                    },
                  });
                count++;
              }

              return { recordCount: count, result: count };
            },
            options?.userId,
          );
          recordsSynced += resilienceCount;
        } catch (err) {
          errors.push({
            message: `daily_resilience: ${err instanceof Error ? err.message : String(err)}`,
            cause: err,
          });
        }

        // Also refresh daily metrics composite (resilience columns merge into daily_metrics row)
        recordsSynced += await this.#syncDailyMetrics(
          db,
          client,
          sinceDate,
          todayDate,
          errors,
          options,
        );
        break;
      }

      case "daily_activity":
      case "daily_readiness":
      case "daily_spo2": {
        // These types only contribute to the daily_metrics composite row
        recordsSynced += await this.#syncDailyMetrics(
          db,
          client,
          sinceDate,
          todayDate,
          errors,
          options,
        );
        break;
      }

      default: {
        // Unknown data type — no-op, return empty result
        break;
      }
    }

    return {
      provider: this.id,
      recordsSynced,
      errors,
      duration: Date.now() - start,
    };
  }

  /**
   * Sync the composite daily metrics row (readiness + activity + SpO2 + VO2 max + stress + resilience merged by day).
   * Extracted as a shared helper because multiple webhook data_types need to refresh this composite.
   */
  async #syncDailyMetrics(
    db: SyncDatabase,
    client: OuraClient,
    sinceDate: string,
    todayDate: string,
    errors: SyncError[],
    options?: SyncOptions,
  ): Promise<number> {
    try {
      return await withSyncLog(
        db,
        this.id,
        "daily_metrics",
        async () => {
          let count = 0;

          const [allReadiness, allActivity, allSpO2, allVO2Max, allStress, allResilience] =
            await Promise.all([
              fetchAllPages((nextToken) =>
                client.getDailyReadiness(sinceDate, todayDate, nextToken),
              ),
              fetchAllPages((nextToken) =>
                client.getDailyActivity(sinceDate, todayDate, nextToken),
              ),
              fetchAllPages((nextToken) => client.getDailySpO2(sinceDate, todayDate, nextToken)),
              fetchAllPages((nextToken) => client.getVO2Max(sinceDate, todayDate, nextToken)),
              fetchAllPages((nextToken) => client.getDailyStress(sinceDate, todayDate, nextToken)),
              fetchAllPages((nextToken) =>
                client.getDailyResilience(sinceDate, todayDate, nextToken),
              ),
            ]);

          // Index by day for merging
          const readinessByDay = new Map<string, OuraDailyReadiness>();
          for (const r of allReadiness) readinessByDay.set(r.day, r);

          const activityByDay = new Map<string, OuraDailyActivity>();
          for (const a of allActivity) activityByDay.set(a.day, a);

          const spo2ByDay = new Map<string, OuraDailySpO2>();
          for (const s of allSpO2) spo2ByDay.set(s.day, s);

          const vo2maxByDay = new Map<string, OuraVO2Max>();
          for (const v of allVO2Max) vo2maxByDay.set(v.day, v);

          const stressByDay = new Map<string, OuraDailyStress>();
          for (const s of allStress) stressByDay.set(s.day, s);

          const resilienceByDay = new Map<string, OuraDailyResilience>();
          for (const r of allResilience) resilienceByDay.set(r.day, r);

          // Union of all days
          const allDays = new Set([
            ...readinessByDay.keys(),
            ...activityByDay.keys(),
            ...spo2ByDay.keys(),
            ...vo2maxByDay.keys(),
            ...stressByDay.keys(),
            ...resilienceByDay.keys(),
          ]);

          for (const day of allDays) {
            const readiness = readinessByDay.get(day) ?? null;
            const activityDoc = activityByDay.get(day) ?? null;
            const spo2 = spo2ByDay.get(day) ?? null;
            const vo2max = vo2maxByDay.get(day) ?? null;
            const stress = stressByDay.get(day) ?? null;
            const resilience = resilienceByDay.get(day) ?? null;
            const parsed = parseOuraDailyMetrics(
              readiness,
              activityDoc,
              spo2,
              vo2max,
              stress,
              resilience,
            );

            try {
              await db
                .insert(dailyMetrics)
                .values({
                  date: parsed.date,
                  providerId: this.id,
                  steps: parsed.steps,
                  restingHr: parsed.restingHr,
                  hrv: parsed.hrv,
                  activeEnergyKcal: parsed.activeEnergyKcal,
                  exerciseMinutes: parsed.exerciseMinutes,
                  skinTempC: parsed.skinTempC,
                  spo2Avg: parsed.spo2Avg,
                  vo2max: parsed.vo2max,
                  stressHighMinutes: parsed.stressHighMinutes,
                  recoveryHighMinutes: parsed.recoveryHighMinutes,
                  resilienceLevel: parsed.resilienceLevel,
                })
                .onConflictDoUpdate({
                  target: [dailyMetrics.date, dailyMetrics.providerId, dailyMetrics.sourceName],
                  set: {
                    steps: parsed.steps,
                    restingHr: parsed.restingHr,
                    hrv: parsed.hrv,
                    activeEnergyKcal: parsed.activeEnergyKcal,
                    exerciseMinutes: parsed.exerciseMinutes,
                    skinTempC: parsed.skinTempC,
                    spo2Avg: parsed.spo2Avg,
                    vo2max: parsed.vo2max,
                    stressHighMinutes: parsed.stressHighMinutes,
                    recoveryHighMinutes: parsed.recoveryHighMinutes,
                    resilienceLevel: parsed.resilienceLevel,
                  },
                });
              count++;
            } catch (err) {
              errors.push({
                message: `daily_metrics ${day}: ${err instanceof Error ? err.message : String(err)}`,
                cause: err,
              });
            }
          }

          return { recordCount: count, result: count };
        },
        options?.userId,
      );
    } catch (err) {
      errors.push({
        message: `daily_metrics: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
      return 0;
    }
  }
}
