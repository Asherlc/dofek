import type { OAuthConfig } from "../auth/oauth.ts";
import { exchangeCodeForTokens, getOAuthRedirectUri, refreshAccessToken } from "../auth/oauth.ts";
import type { SyncDatabase } from "../db/index.ts";
import { activity, dailyMetrics, healthEvent, metricStream, sleepSession } from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import type { Provider, ProviderAuthSetup, SyncError, SyncResult } from "./types.ts";

// ============================================================
// Oura API v2 types
// ============================================================

export interface OuraSleepDocument {
  id: string;
  day: string; // "YYYY-MM-DD"
  bedtime_start: string; // ISO datetime
  bedtime_end: string; // ISO datetime
  total_sleep_duration: number | null; // seconds
  deep_sleep_duration: number | null; // seconds
  rem_sleep_duration: number | null; // seconds
  light_sleep_duration: number | null; // seconds
  awake_time: number | null; // seconds
  efficiency: number; // 0-100
  type: "long_sleep" | "rest" | "sleep" | "late_nap";
  average_heart_rate: number | null;
  lowest_heart_rate: number | null;
  average_hrv: number | null;
  time_in_bed: number; // seconds
  readiness_score_delta: number | null;
  latency: number | null; // seconds
}

export interface OuraDailyReadiness {
  id: string;
  day: string;
  score: number | null;
  temperature_deviation: number | null; // celsius deviation from baseline
  temperature_trend_deviation: number | null;
  contributors: {
    resting_heart_rate: number | null;
    hrv_balance: number | null;
    body_temperature: number | null;
    recovery_index: number | null;
    sleep_balance: number | null;
    previous_night: number | null;
    previous_day_activity: number | null;
    activity_balance: number | null;
  };
}

export interface OuraDailyActivity {
  id: string;
  day: string;
  steps: number;
  active_calories: number;
  equivalent_walking_distance: number; // meters
  high_activity_time: number; // seconds
  medium_activity_time: number; // seconds
  low_activity_time: number; // seconds
  resting_time: number; // seconds
  sedentary_time: number; // seconds
  total_calories: number;
}

export interface OuraDailySpO2 {
  id: string;
  day: string;
  spo2_percentage: { average: number } | null;
  breathing_disturbance_index: number | null;
}

export interface OuraVO2Max {
  id: string;
  day: string;
  timestamp: string;
  vo2_max: number | null;
}

export interface OuraWorkout {
  id: string;
  activity: string;
  calories: number | null;
  day: string;
  distance: number | null; // meters
  end_datetime: string;
  intensity: "easy" | "moderate" | "hard";
  label: string | null;
  source: "manual" | "autodetected" | "confirmed" | "workout_heart_rate";
  start_datetime: string;
}

export interface OuraHeartRate {
  bpm: number;
  source: "awake" | "rest" | "sleep" | "session" | "live" | "workout";
  timestamp: string;
}

export interface OuraSession {
  id: string;
  day: string;
  start_datetime: string;
  end_datetime: string;
  type: "breathing" | "meditation" | "nap" | "relaxation" | "rest" | "body_status";
  mood: "bad" | "worse" | "same" | "good" | "great" | null;
}

export interface OuraDailyStress {
  id: string;
  day: string;
  stress_high: number | null; // seconds
  recovery_high: number | null; // seconds
  day_summary: "restored" | "normal" | "stressful" | null;
}

export interface OuraDailyResilience {
  id: string;
  day: string;
  contributors: {
    sleep_recovery: number;
    daytime_recovery: number;
    stress: number;
  };
  level: "limited" | "adequate" | "solid" | "strong" | "exceptional";
}

export interface OuraDailyCardiovascularAge {
  day: string;
  vascular_age: number | null;
}

export interface OuraTag {
  id: string;
  day: string;
  text: string | null;
  timestamp: string;
  tags: string[];
}

export interface OuraEnhancedTag {
  id: string;
  tag_type_code: string | null;
  start_time: string;
  end_time: string | null;
  start_day: string;
  end_day: string | null;
  comment: string | null;
  custom_name: string | null;
}

export interface OuraRestModePeriod {
  id: string;
  end_day: string | null;
  end_time: string | null;
  start_day: string;
  start_time: string | null;
}

export interface OuraSleepTime {
  id: string;
  day: string;
  optimal_bedtime: {
    day_tz: number;
    end_offset: number;
    start_offset: number;
  } | null;
  recommendation:
    | "improve_efficiency"
    | "earlier_bedtime"
    | "later_bedtime"
    | "earlier_wake_up_time"
    | "later_wake_up_time"
    | "follow_optimal_bedtime"
    | null;
  status:
    | "not_enough_nights"
    | "not_enough_recent_nights"
    | "bad_sleep_quality"
    | "only_recommended_found"
    | "optimal_found"
    | null;
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

const OURA_ACTIVITY_TYPE_MAP: Record<string, string> = {
  walking: "walking",
  running: "running",
  cycling: "cycling",
  swimming: "swimming",
  hiking: "hiking",
  yoga: "yoga",
  elliptical: "elliptical",
  rowing: "rowing",
  strength_training: "strength",
  weight_training: "strength",
  dancing: "dancing",
  pilates: "pilates",
  indoor_cycling: "cycling",
  stairmaster: "stairmaster",
  other: "other",
};

export function mapOuraActivityType(ouraActivity: string): string {
  return OURA_ACTIVITY_TYPE_MAP[ouraActivity.toLowerCase()] ?? ouraActivity.toLowerCase();
}

// ============================================================
// Oura API client
// ============================================================

const OURA_API_BASE = "https://api.ouraring.com";

export class OuraClient {
  private accessToken: string;
  private fetchFn: typeof globalThis.fetch;

  constructor(accessToken: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.accessToken = accessToken;
    this.fetchFn = fetchFn;
  }

  private async get<T>(path: string): Promise<T> {
    const url = `${OURA_API_BASE}${path}`;

    const response = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Oura API error (${response.status}): ${text}`);
    }

    return response.json();
  }

  private dateQuery(startDate: string, endDate: string, nextToken?: string): string {
    let qs = `start_date=${startDate}&end_date=${endDate}`;
    if (nextToken) qs += `&next_token=${nextToken}`;
    return qs;
  }

  async getSleep(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraSleepDocument>> {
    return this.get(`/v2/usercollection/sleep?${this.dateQuery(startDate, endDate, nextToken)}`);
  }

  async getDailyReadiness(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraDailyReadiness>> {
    return this.get(
      `/v2/usercollection/daily_readiness?${this.dateQuery(startDate, endDate, nextToken)}`,
    );
  }

  async getDailyActivity(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraDailyActivity>> {
    return this.get(
      `/v2/usercollection/daily_activity?${this.dateQuery(startDate, endDate, nextToken)}`,
    );
  }

  async getDailySpO2(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraDailySpO2>> {
    return this.get(
      `/v2/usercollection/daily_spo2?${this.dateQuery(startDate, endDate, nextToken)}`,
    );
  }

  async getVO2Max(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraVO2Max>> {
    return this.get(`/v2/usercollection/vO2_max?${this.dateQuery(startDate, endDate, nextToken)}`);
  }

  async getWorkouts(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraWorkout>> {
    return this.get(`/v2/usercollection/workout?${this.dateQuery(startDate, endDate, nextToken)}`);
  }

  async getHeartRate(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraHeartRate>> {
    let qs = `start_datetime=${startDate}T00:00:00&end_datetime=${endDate}T23:59:59`;
    if (nextToken) qs += `&next_token=${nextToken}`;
    return this.get(`/v2/usercollection/heartrate?${qs}`);
  }

  async getSessions(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraSession>> {
    return this.get(`/v2/usercollection/session?${this.dateQuery(startDate, endDate, nextToken)}`);
  }

  async getDailyStress(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraDailyStress>> {
    return this.get(
      `/v2/usercollection/daily_stress?${this.dateQuery(startDate, endDate, nextToken)}`,
    );
  }

  async getDailyResilience(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraDailyResilience>> {
    return this.get(
      `/v2/usercollection/daily_resilience?${this.dateQuery(startDate, endDate, nextToken)}`,
    );
  }

  async getDailyCardiovascularAge(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraDailyCardiovascularAge>> {
    return this.get(
      `/v2/usercollection/daily_cardiovascular_age?${this.dateQuery(startDate, endDate, nextToken)}`,
    );
  }

  async getTags(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraTag>> {
    return this.get(`/v2/usercollection/tag?${this.dateQuery(startDate, endDate, nextToken)}`);
  }

  async getEnhancedTags(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraEnhancedTag>> {
    return this.get(
      `/v2/usercollection/enhanced_tag?${this.dateQuery(startDate, endDate, nextToken)}`,
    );
  }

  async getRestModePeriods(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraRestModePeriod>> {
    return this.get(
      `/v2/usercollection/rest_mode_period?${this.dateQuery(startDate, endDate, nextToken)}`,
    );
  }

  async getSleepTime(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraSleepTime>> {
    return this.get(
      `/v2/usercollection/sleep_time?${this.dateQuery(startDate, endDate, nextToken)}`,
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
    scopes: ["daily", "heartrate", "personal", "session", "spo2", "workout", "tag"],
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

// ============================================================
// Batch size for metric stream inserts
// ============================================================

const METRIC_STREAM_BATCH_SIZE = 500;
const HEALTH_EVENT_BATCH_SIZE = 1000;

// ============================================================
// Provider implementation
// ============================================================

export class OuraProvider implements Provider {
  readonly id = "oura";
  readonly name = "Oura";
  private fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.fetchFn = fetchFn;
  }

  validate(): string | null {
    if (!process.env.OURA_CLIENT_ID) return "OURA_CLIENT_ID is not set";
    if (!process.env.OURA_CLIENT_SECRET) return "OURA_CLIENT_SECRET is not set";
    return null;
  }

  authSetup(): ProviderAuthSetup {
    const config = ouraOAuthConfig();
    if (!config) throw new Error("OURA_CLIENT_ID and OURA_CLIENT_SECRET are required");
    const fetchFn = this.fetchFn;

    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeCodeForTokens(config, code, fetchFn),
      apiBaseUrl: OURA_API_BASE,
    };
  }

  private async resolveAccessToken(db: SyncDatabase): Promise<string> {
    const tokens = await loadTokens(db, this.id);
    if (!tokens) {
      throw new Error("No OAuth tokens found for Oura. Run: health-data auth oura");
    }

    if (tokens.expiresAt > new Date()) {
      return tokens.accessToken;
    }

    console.log("[oura] Access token expired, refreshing...");
    const config = ouraOAuthConfig();
    if (!config) {
      throw new Error("OURA_CLIENT_ID and OURA_CLIENT_SECRET are required to refresh tokens");
    }
    if (!tokens.refreshToken) {
      throw new Error("No refresh token for Oura");
    }
    const refreshed = await refreshAccessToken(config, tokens.refreshToken, this.fetchFn);
    await saveTokens(db, this.id, refreshed);
    return refreshed.accessToken;
  }

  async sync(db: SyncDatabase, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, OURA_API_BASE);

    let accessToken: string;
    try {
      accessToken = await this.resolveAccessToken(db);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const client = new OuraClient(accessToken, this.fetchFn);
    const sinceDate = formatDate(since);
    const todayDate = formatDate(new Date());

    // 1. Sync sleep sessions
    try {
      const sleepCount = await withSyncLog(db, this.id, "sleep", async () => {
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
                isNap: parsed.isNap,
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
                  isNap: parsed.isNap,
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
      });
      recordsSynced += sleepCount;
    } catch (err) {
      errors.push({
        message: `sleep: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 2. Sync workouts → activity table
    try {
      const workoutCount = await withSyncLog(db, this.id, "workouts", async () => {
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
      });
      recordsSynced += workoutCount;
    } catch (err) {
      errors.push({
        message: `workouts: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 3. Sync sessions (meditation, breathing, etc.) → activity table
    try {
      const sessionCount = await withSyncLog(db, this.id, "sessions", async () => {
        let count = 0;
        const allSessions = await fetchAllPages((nextToken) =>
          client.getSessions(sinceDate, todayDate, nextToken),
        );

        for (const s of allSessions) {
          try {
            await db
              .insert(activity)
              .values({
                providerId: this.id,
                externalId: s.id,
                activityType: s.type,
                startedAt: new Date(s.start_datetime),
                endedAt: new Date(s.end_datetime),
                name: s.type,
                raw: s,
              })
              .onConflictDoUpdate({
                target: [activity.providerId, activity.externalId],
                set: {
                  activityType: s.type,
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
      });
      recordsSynced += sessionCount;
    } catch (err) {
      errors.push({
        message: `sessions: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 4. Sync heart rate → metricStream table (batched)
    try {
      const hrCount = await withSyncLog(db, this.id, "heart_rate", async () => {
        const allHr = await fetchAllPages((nextToken) =>
          client.getHeartRate(sinceDate, todayDate, nextToken),
        );

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
      });
      recordsSynced += hrCount;
    } catch (err) {
      errors.push({
        message: `heart_rate: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 5. Sync daily stress → healthEvent table
    try {
      const stressCount = await withSyncLog(db, this.id, "daily_stress", async () => {
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
      });
      recordsSynced += stressCount;
    } catch (err) {
      errors.push({
        message: `daily_stress: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 6. Sync daily resilience → healthEvent table
    try {
      const resilienceCount = await withSyncLog(db, this.id, "daily_resilience", async () => {
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
      });
      recordsSynced += resilienceCount;
    } catch (err) {
      errors.push({
        message: `daily_resilience: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 7. Sync daily cardiovascular age → healthEvent table
    try {
      const cvAgeCount = await withSyncLog(db, this.id, "cardiovascular_age", async () => {
        const allCvAge = await fetchAllPages((nextToken) =>
          client.getDailyCardiovascularAge(sinceDate, todayDate, nextToken),
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
      });
      recordsSynced += cvAgeCount;
    } catch (err) {
      errors.push({
        message: `cardiovascular_age: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 8. Sync tags → healthEvent table
    try {
      const tagCount = await withSyncLog(db, this.id, "tags", async () => {
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
      });
      recordsSynced += tagCount;
    } catch (err) {
      errors.push({
        message: `tags: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 9. Sync enhanced tags → healthEvent table
    try {
      const enhancedTagCount = await withSyncLog(db, this.id, "enhanced_tags", async () => {
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
      });
      recordsSynced += enhancedTagCount;
    } catch (err) {
      errors.push({
        message: `enhanced_tags: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 10. Sync rest mode periods → healthEvent table
    try {
      const restModeCount = await withSyncLog(db, this.id, "rest_mode", async () => {
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
      });
      recordsSynced += restModeCount;
    } catch (err) {
      errors.push({
        message: `rest_mode: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 11. Sync sleep time recommendations → healthEvent table
    try {
      const sleepTimeCount = await withSyncLog(db, this.id, "sleep_time", async () => {
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
      });
      recordsSynced += sleepTimeCount;
    } catch (err) {
      errors.push({
        message: `sleep_time: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 12. Sync daily metrics (readiness + activity + SpO2 + VO2 max + stress + resilience merged by day)
    try {
      const dailyCount = await withSyncLog(db, this.id, "daily_metrics", async () => {
        let count = 0;

        const [allReadiness, allActivity, allSpO2, allVO2Max, allStress, allResilience] =
          await Promise.all([
            fetchAllPages((nextToken) => client.getDailyReadiness(sinceDate, todayDate, nextToken)),
            fetchAllPages((nextToken) => client.getDailyActivity(sinceDate, todayDate, nextToken)),
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
                target: [dailyMetrics.date, dailyMetrics.providerId],
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
      });
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
}
