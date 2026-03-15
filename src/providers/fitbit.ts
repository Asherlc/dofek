import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generateCodeChallenge,
  generateCodeVerifier,
  refreshAccessToken,
} from "../auth/oauth.ts";
import type { Database } from "../db/index.ts";
import { activity, bodyMeasurement, dailyMetrics, sleepSession } from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import type { Provider, ProviderAuthSetup, SyncError, SyncResult } from "./types.ts";

// ============================================================
// Fitbit API types
// ============================================================

export interface FitbitActivity {
  logId: number;
  activityName: string;
  activityTypeId: number;
  startTime: string; // "HH:mm"
  activeDuration: number; // ms
  calories: number;
  distance?: number; // km (metric users)
  distanceUnit: string;
  steps?: number;
  averageHeartRate?: number;
  heartRateZones?: Array<{ name: string; min: number; max: number; minutes: number }>;
  logType: string;
  startDate: string; // "YYYY-MM-DD"
  tcxLink?: string;
}

export interface FitbitActivityListResponse {
  activities: FitbitActivity[];
  pagination: {
    next: string;
    previous: string;
    limit: number;
    offset: number;
    sort: string;
  };
}

export interface FitbitSleepLog {
  logId: number;
  dateOfSleep: string; // "YYYY-MM-DD"
  startTime: string; // ISO datetime
  endTime: string; // ISO datetime
  duration: number; // ms
  efficiency: number;
  isMainSleep: boolean;
  type: "stages" | "classic";
  levels: {
    summary: {
      deep?: { count: number; minutes: number; thirtyDayAvgMinutes: number };
      light?: { count: number; minutes: number; thirtyDayAvgMinutes: number };
      rem?: { count: number; minutes: number; thirtyDayAvgMinutes: number };
      wake?: { count: number; minutes: number; thirtyDayAvgMinutes: number };
    };
  };
}

export interface FitbitSleepListResponse {
  sleep: FitbitSleepLog[];
  pagination: {
    next: string;
    previous: string;
    limit: number;
    offset: number;
    sort: string;
  };
}

export interface FitbitDailySummary {
  summary: {
    steps: number;
    caloriesOut: number;
    activeScore: number;
    activityCalories: number;
    restingHeartRate?: number;
    distances: Array<{ activity: string; distance: number }>;
    fairlyActiveMinutes: number;
    veryActiveMinutes: number;
    lightlyActiveMinutes: number;
    sedentaryMinutes: number;
    floors?: number;
  };
}

export interface FitbitWeightLog {
  logId: number;
  weight: number; // kg
  bmi: number;
  fat?: number; // body fat %
  date: string; // "YYYY-MM-DD"
  time: string; // "HH:mm:ss"
}

interface FitbitWeightListResponse {
  weight: FitbitWeightLog[];
}

// ============================================================
// Parsed types
// ============================================================

export interface ParsedFitbitActivity {
  externalId: string;
  activityType: string;
  name: string;
  startedAt: Date;
  endedAt: Date;
  calories: number;
  distanceKm?: number;
  steps?: number;
  averageHeartRate?: number;
  heartRateZones?: Array<{ name: string; min: number; max: number; minutes: number }>;
}

export interface ParsedFitbitSleep {
  externalId: string;
  startedAt: Date;
  endedAt: Date;
  durationMinutes: number;
  deepMinutes?: number;
  lightMinutes?: number;
  remMinutes?: number;
  awakeMinutes?: number;
  efficiencyPct: number;
  isNap: boolean;
}

export interface ParsedFitbitDailyMetrics {
  date: string;
  steps: number;
  restingHr?: number;
  activeEnergyKcal: number;
  exerciseMinutes: number;
  distanceKm?: number;
  flightsClimbed?: number;
}

export interface ParsedFitbitBodyMeasurement {
  externalId: string;
  recordedAt: Date;
  weightKg: number;
  bodyFatPct?: number;
}

// ============================================================
// Activity type mapping
// ============================================================

const ACTIVITY_NAME_PATTERNS: Array<[RegExp, string]> = [
  [/\brun\b|treadmill/i, "running"],
  [/\bbike\b|cycling|spinning/i, "cycling"],
  [/\bwalk\b/i, "walking"],
  [/\bswim/i, "swimming"],
  [/\bhik[ei]/i, "hiking"],
  [/\byoga\b/i, "yoga"],
  [/\bweight|strength/i, "strength"],
  [/\belliptical\b/i, "elliptical"],
  [/\browing\b|row\b/i, "rowing"],
];

export function mapFitbitActivityType(activityName: string, _activityTypeId: number): string {
  for (const [pattern, type] of ACTIVITY_NAME_PATTERNS) {
    if (pattern.test(activityName)) {
      return type;
    }
  }
  return "other";
}

// ============================================================
// Parsing — pure functions
// ============================================================

export function parseFitbitActivity(activity: FitbitActivity): ParsedFitbitActivity {
  const startedAt = new Date(`${activity.startDate}T${activity.startTime}`);
  const endedAt = new Date(startedAt.getTime() + activity.activeDuration);

  return {
    externalId: String(activity.logId),
    activityType: mapFitbitActivityType(activity.activityName, activity.activityTypeId),
    name: activity.activityName,
    startedAt,
    endedAt,
    calories: activity.calories,
    distanceKm: activity.distance,
    steps: activity.steps,
    averageHeartRate: activity.averageHeartRate,
    heartRateZones: activity.heartRateZones,
  };
}

export function parseFitbitSleep(sleep: FitbitSleepLog): ParsedFitbitSleep {
  const summary = sleep.levels.summary;

  return {
    externalId: String(sleep.logId),
    startedAt: new Date(sleep.startTime),
    endedAt: new Date(sleep.endTime),
    durationMinutes: Math.round(sleep.duration / 60000),
    deepMinutes: summary.deep?.minutes,
    lightMinutes: summary.light?.minutes,
    remMinutes: summary.rem?.minutes,
    awakeMinutes: summary.wake?.minutes,
    efficiencyPct: sleep.efficiency,
    isNap: !sleep.isMainSleep,
  };
}

export function parseFitbitDailySummary(
  date: string,
  daily: FitbitDailySummary,
): ParsedFitbitDailyMetrics {
  const totalDistance = daily.summary.distances.find((d) => d.activity === "total");

  return {
    date,
    steps: daily.summary.steps,
    restingHr: daily.summary.restingHeartRate,
    activeEnergyKcal: daily.summary.activityCalories,
    exerciseMinutes: daily.summary.fairlyActiveMinutes + daily.summary.veryActiveMinutes,
    distanceKm: totalDistance?.distance,
    flightsClimbed: daily.summary.floors,
  };
}

export function parseFitbitWeightLog(log: FitbitWeightLog): ParsedFitbitBodyMeasurement {
  return {
    externalId: String(log.logId),
    recordedAt: new Date(`${log.date}T${log.time}`),
    weightKg: log.weight,
    bodyFatPct: log.fat,
  };
}

// ============================================================
// Fitbit API client
// ============================================================

const FITBIT_API_BASE = "https://api.fitbit.com";

export class FitbitClient {
  private accessToken: string;
  private fetchFn: typeof globalThis.fetch;

  constructor(accessToken: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.accessToken = accessToken;
    this.fetchFn = fetchFn;
  }

  private async get<T>(path: string): Promise<T> {
    const url = `${FITBIT_API_BASE}${path}`;

    const response = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Fitbit API error (${response.status}): ${text}`);
    }

    return response.json() as Promise<T>;
  }

  async getActivities(afterDate: string, offset = 0): Promise<FitbitActivityListResponse> {
    return this.get<FitbitActivityListResponse>(
      `/1/user/-/activities/list.json?afterDate=${afterDate}&sort=asc&limit=20&offset=${offset}`,
    );
  }

  async getSleepLogs(afterDate: string, offset = 0): Promise<FitbitSleepListResponse> {
    return this.get<FitbitSleepListResponse>(
      `/1.2/user/-/sleep/list.json?afterDate=${afterDate}&sort=asc&limit=20&offset=${offset}`,
    );
  }

  async getDailySummary(date: string): Promise<FitbitDailySummary> {
    return this.get<FitbitDailySummary>(`/1/user/-/activities/date/${date}.json`);
  }

  async getWeightLogs(startDate: string): Promise<FitbitWeightListResponse> {
    return this.get<FitbitWeightListResponse>(
      `/1/user/-/body/log/weight/date/${startDate}/30d.json`,
    );
  }
}

// ============================================================
// OAuth configuration
// ============================================================

const DEFAULT_REDIRECT_URI = "https://dofek.asherlc.com/callback";

export function fitbitOAuthConfig(): OAuthConfig | null {
  const clientId = process.env.FITBIT_CLIENT_ID;
  const clientSecret = process.env.FITBIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const redirectUri = process.env.OAUTH_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;

  return {
    clientId,
    clientSecret,
    authorizeUrl: "https://www.fitbit.com/oauth2/authorize",
    tokenUrl: `${FITBIT_API_BASE}/oauth2/token`,
    redirectUri,
    scopes: [
      "activity",
      "heartrate",
      "sleep",
      "weight",
      "profile",
      "oxygen_saturation",
      "respiratory_rate",
      "temperature",
    ],
    usePkce: true,
  };
}

// ============================================================
// Helper: format date as YYYY-MM-DD
// ============================================================

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ============================================================
// Provider implementation
// ============================================================

export class FitbitProvider implements Provider {
  readonly id = "fitbit";
  readonly name = "Fitbit";
  private fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.fetchFn = fetchFn;
  }

  validate(): string | null {
    if (!process.env.FITBIT_CLIENT_ID) return "FITBIT_CLIENT_ID is not set";
    if (!process.env.FITBIT_CLIENT_SECRET) return "FITBIT_CLIENT_SECRET is not set";
    return null;
  }

  authSetup(): ProviderAuthSetup {
    const config = fitbitOAuthConfig();
    if (!config) throw new Error("FITBIT_CLIENT_ID and FITBIT_CLIENT_SECRET are required");
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const fetchFn = this.fetchFn;

    return {
      oauthConfig: config,
      authUrl: buildAuthorizationUrl(config, { codeChallenge }),
      exchangeCode: (code) => exchangeCodeForTokens(config, code, fetchFn, { codeVerifier }),
      apiBaseUrl: FITBIT_API_BASE,
    };
  }

  private async resolveTokens(db: Database): Promise<TokenSet> {
    const tokens = await loadTokens(db, this.id);
    if (!tokens) {
      throw new Error("No OAuth tokens found for Fitbit. Run: health-data auth fitbit");
    }

    if (tokens.expiresAt > new Date()) {
      return tokens;
    }

    console.log("[fitbit] Access token expired, refreshing...");
    const config = fitbitOAuthConfig();
    if (!config) {
      throw new Error("FITBIT_CLIENT_ID and FITBIT_CLIENT_SECRET are required to refresh tokens");
    }
    if (!tokens.refreshToken) {
      throw new Error("No refresh token for FitBit");
    }
    const refreshed = await refreshAccessToken(config, tokens.refreshToken, this.fetchFn);
    await saveTokens(db, this.id, refreshed);
    return refreshed;
  }

  async sync(db: Database, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, FITBIT_API_BASE);

    let tokens: TokenSet;
    try {
      tokens = await this.resolveTokens(db);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const client = new FitbitClient(tokens.accessToken, this.fetchFn);
    const sinceDate = formatDate(since);

    // 1. Sync activities
    try {
      const activityCount = await withSyncLog(db, this.id, "activity", async () => {
        let count = 0;
        let offset = 0;
        let hasMore = true;

        while (hasMore) {
          const response = await client.getActivities(sinceDate, offset);

          for (const raw of response.activities) {
            const parsed = parseFitbitActivity(raw);
            try {
              await db
                .insert(activity)
                .values({
                  providerId: this.id,
                  externalId: parsed.externalId,
                  activityType: parsed.activityType,
                  startedAt: parsed.startedAt,
                  endedAt: parsed.endedAt,
                  name: parsed.name,
                  raw: raw,
                })
                .onConflictDoUpdate({
                  target: [activity.providerId, activity.externalId],
                  set: {
                    activityType: parsed.activityType,
                    startedAt: parsed.startedAt,
                    endedAt: parsed.endedAt,
                    name: parsed.name,
                    raw: raw,
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

          // Fitbit pagination: if next URL is empty, no more pages
          hasMore = response.pagination.next !== "";
          offset += response.pagination.limit;
        }

        return { recordCount: count, result: count };
      });
      recordsSynced += activityCount;
    } catch (err) {
      errors.push({
        message: `activity: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 2. Sync sleep
    try {
      const sleepCount = await withSyncLog(db, this.id, "sleep", async () => {
        let count = 0;
        let offset = 0;
        let hasMore = true;

        while (hasMore) {
          const response = await client.getSleepLogs(sinceDate, offset);

          for (const raw of response.sleep) {
            const parsed = parseFitbitSleep(raw);
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

          hasMore = response.pagination.next !== "";
          offset += response.pagination.limit;
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

    // 3. Sync daily summaries (day-by-day iteration)
    try {
      const dailyCount = await withSyncLog(db, this.id, "daily_metrics", async () => {
        let count = 0;
        const today = new Date();
        const currentDate = new Date(since);

        while (currentDate <= today) {
          const dateStr = formatDate(currentDate);
          try {
            const response = await client.getDailySummary(dateStr);
            const parsed = parseFitbitDailySummary(dateStr, response);

            await db
              .insert(dailyMetrics)
              .values({
                date: parsed.date,
                providerId: this.id,
                steps: parsed.steps,
                restingHr: parsed.restingHr,
                activeEnergyKcal: parsed.activeEnergyKcal,
                exerciseMinutes: parsed.exerciseMinutes,
                distanceKm: parsed.distanceKm,
                flightsClimbed: parsed.flightsClimbed,
              })
              .onConflictDoUpdate({
                target: [dailyMetrics.date, dailyMetrics.providerId],
                set: {
                  steps: parsed.steps,
                  restingHr: parsed.restingHr,
                  activeEnergyKcal: parsed.activeEnergyKcal,
                  exerciseMinutes: parsed.exerciseMinutes,
                  distanceKm: parsed.distanceKm,
                  flightsClimbed: parsed.flightsClimbed,
                },
              });
            count++;
          } catch (err) {
            errors.push({
              message: `daily_metrics ${dateStr}: ${err instanceof Error ? err.message : String(err)}`,
              cause: err,
            });
          }

          currentDate.setDate(currentDate.getDate() + 1);
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

    // 4. Sync body weight logs (30-day windows)
    try {
      const weightCount = await withSyncLog(db, this.id, "body_measurement", async () => {
        let count = 0;
        const today = new Date();
        const currentDate = new Date(since);

        // Iterate in 30-day windows
        while (currentDate <= today) {
          const dateStr = formatDate(currentDate);
          try {
            const response = await client.getWeightLogs(dateStr);

            for (const raw of response.weight) {
              const parsed = parseFitbitWeightLog(raw);
              try {
                await db
                  .insert(bodyMeasurement)
                  .values({
                    providerId: this.id,
                    externalId: parsed.externalId,
                    recordedAt: parsed.recordedAt,
                    weightKg: parsed.weightKg,
                    bodyFatPct: parsed.bodyFatPct,
                  })
                  .onConflictDoUpdate({
                    target: [bodyMeasurement.providerId, bodyMeasurement.externalId],
                    set: {
                      weightKg: parsed.weightKg,
                      bodyFatPct: parsed.bodyFatPct,
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
          } catch (err) {
            errors.push({
              message: `weight ${dateStr}: ${err instanceof Error ? err.message : String(err)}`,
              cause: err,
            });
          }

          // Advance by 30 days
          currentDate.setDate(currentDate.getDate() + 30);
        }

        return { recordCount: count, result: count };
      });
      recordsSynced += weightCount;
    } catch (err) {
      errors.push({
        message: `body_measurement: ${err instanceof Error ? err.message : String(err)}`,
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
