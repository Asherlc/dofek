import type { OAuthConfig } from "../auth/oauth.ts";
import { exchangeCodeForTokens, refreshAccessToken } from "../auth/oauth.ts";
import type { Database } from "../db/index.ts";
import { dailyMetrics, sleepSession } from "../db/schema.ts";
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

interface OuraListResponse<T> {
  data: T[];
  next_token: string | null;
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
): ParsedOuraDailyMetrics {
  const day = readiness?.day ?? activity?.day ?? spo2?.day ?? vo2max?.day ?? "";

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
  };
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

    return response.json() as Promise<T>;
  }

  async getSleep(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraSleepDocument>> {
    let path = `/v2/usercollection/sleep?start_date=${startDate}&end_date=${endDate}`;
    if (nextToken) path += `&next_token=${nextToken}`;
    return this.get(path);
  }

  async getDailyReadiness(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraDailyReadiness>> {
    let path = `/v2/usercollection/daily_readiness?start_date=${startDate}&end_date=${endDate}`;
    if (nextToken) path += `&next_token=${nextToken}`;
    return this.get(path);
  }

  async getDailyActivity(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraDailyActivity>> {
    let path = `/v2/usercollection/daily_activity?start_date=${startDate}&end_date=${endDate}`;
    if (nextToken) path += `&next_token=${nextToken}`;
    return this.get(path);
  }

  async getDailySpO2(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraDailySpO2>> {
    let path = `/v2/usercollection/daily_spo2?start_date=${startDate}&end_date=${endDate}`;
    if (nextToken) path += `&next_token=${nextToken}`;
    return this.get(path);
  }

  async getVO2Max(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraVO2Max>> {
    let path = `/v2/usercollection/vO2_max?start_date=${startDate}&end_date=${endDate}`;
    if (nextToken) path += `&next_token=${nextToken}`;
    return this.get(path);
  }
}

// ============================================================
// OAuth configuration
// ============================================================

const DEFAULT_REDIRECT_URI = "https://localhost:9876/callback";

export function ouraOAuthConfig(): OAuthConfig | null {
  const clientId = process.env.OURA_CLIENT_ID;
  const clientSecret = process.env.OURA_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  return {
    clientId,
    clientSecret,
    authorizeUrl: "https://cloud.ouraring.com/oauth/authorize",
    tokenUrl: `${OURA_API_BASE}/oauth/token`,
    redirectUri: process.env.OAUTH_REDIRECT_URI ?? DEFAULT_REDIRECT_URI,
    scopes: ["daily", "heartrate", "personal", "session", "spo2"],
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

  private async resolveAccessToken(db: Database): Promise<string> {
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

  async sync(db: Database, since: Date): Promise<SyncResult> {
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

    // 2. Sync daily metrics (readiness + activity + SpO2 + VO2 max merged by day)
    try {
      const dailyCount = await withSyncLog(db, this.id, "daily_metrics", async () => {
        let count = 0;

        const [allReadiness, allActivity, allSpO2, allVO2Max] = await Promise.all([
          fetchAllPages((nextToken) => client.getDailyReadiness(sinceDate, todayDate, nextToken)),
          fetchAllPages((nextToken) => client.getDailyActivity(sinceDate, todayDate, nextToken)),
          fetchAllPages((nextToken) => client.getDailySpO2(sinceDate, todayDate, nextToken)),
          fetchAllPages((nextToken) => client.getVO2Max(sinceDate, todayDate, nextToken)),
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

        // Union of all days
        const allDays = new Set([
          ...readinessByDay.keys(),
          ...activityByDay.keys(),
          ...spo2ByDay.keys(),
          ...vo2maxByDay.keys(),
        ]);

        for (const day of allDays) {
          const readiness = readinessByDay.get(day) ?? null;
          const activity = activityByDay.get(day) ?? null;
          const spo2 = spo2ByDay.get(day) ?? null;
          const vo2max = vo2maxByDay.get(day) ?? null;
          const parsed = parseOuraDailyMetrics(readiness, activity, spo2, vo2max);

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
