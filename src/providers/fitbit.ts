import { z } from "zod";
import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generateCodeChallenge,
  generateCodeVerifier,
  getOAuthRedirectUri,
} from "../auth/oauth.ts";
import { resolveOAuthTokens } from "../auth/resolve-tokens.ts";
import type { SyncDatabase } from "../db/index.ts";
import { activity, bodyMeasurement, dailyMetrics, sleepSession } from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider } from "../db/tokens.ts";
import { ProviderHttpClient } from "./http-client.ts";
import type {
  ProviderAuthSetup,
  ProviderIdentity,
  SyncError,
  SyncProvider,
  SyncResult,
} from "./types.ts";

// ============================================================
// Fitbit API Zod schemas
// ============================================================

const fitbitHeartRateZoneSchema = z.object({
  name: z.string(),
  min: z.number(),
  max: z.number(),
  minutes: z.number(),
});

export const fitbitActivitySchema = z.object({
  logId: z.number(),
  activityName: z.string(),
  activityTypeId: z.number(),
  startTime: z.string(),
  activeDuration: z.number(),
  calories: z.number(),
  distance: z.number().optional(),
  distanceUnit: z.string(),
  steps: z.number().optional(),
  averageHeartRate: z.number().optional(),
  heartRateZones: z.array(fitbitHeartRateZoneSchema).optional(),
  logType: z.string(),
  startDate: z.string(),
  tcxLink: z.string().optional(),
});

export type FitbitActivity = z.infer<typeof fitbitActivitySchema>;

const fitbitPaginationSchema = z.object({
  next: z.string(),
  previous: z.string(),
  limit: z.number(),
  offset: z.number(),
  sort: z.string(),
});

const fitbitActivityListResponseSchema = z.object({
  activities: z.array(fitbitActivitySchema),
  pagination: fitbitPaginationSchema,
});

export type FitbitActivityListResponse = z.infer<typeof fitbitActivityListResponseSchema>;

const fitbitSleepStageSummarySchema = z.object({
  count: z.number(),
  minutes: z.number(),
  thirtyDayAvgMinutes: z.number(),
});

export const fitbitSleepLogSchema = z.object({
  logId: z.number(),
  dateOfSleep: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  duration: z.number(),
  efficiency: z.number(),
  isMainSleep: z.boolean(),
  type: z.enum(["stages", "classic"]),
  levels: z.object({
    summary: z.object({
      deep: fitbitSleepStageSummarySchema.optional(),
      light: fitbitSleepStageSummarySchema.optional(),
      rem: fitbitSleepStageSummarySchema.optional(),
      wake: fitbitSleepStageSummarySchema.optional(),
    }),
  }),
});

export type FitbitSleepLog = z.infer<typeof fitbitSleepLogSchema>;

const fitbitSleepListResponseSchema = z.object({
  sleep: z.array(fitbitSleepLogSchema),
  pagination: fitbitPaginationSchema,
});

export type FitbitSleepListResponse = z.infer<typeof fitbitSleepListResponseSchema>;

export const fitbitDailySummarySchema = z.object({
  summary: z.object({
    steps: z.number(),
    caloriesOut: z.number(),
    activeScore: z.number(),
    activityCalories: z.number(),
    restingHeartRate: z.number().optional(),
    distances: z.array(z.object({ activity: z.string(), distance: z.number() })),
    fairlyActiveMinutes: z.number(),
    veryActiveMinutes: z.number(),
    lightlyActiveMinutes: z.number(),
    sedentaryMinutes: z.number(),
    floors: z.number().optional(),
  }),
});

export type FitbitDailySummary = z.infer<typeof fitbitDailySummarySchema>;

export const fitbitWeightLogSchema = z.object({
  logId: z.number(),
  weight: z.number(),
  bmi: z.number(),
  fat: z.number().optional(),
  date: z.string(),
  time: z.string(),
});

export type FitbitWeightLog = z.infer<typeof fitbitWeightLogSchema>;

const fitbitWeightListResponseSchema = z.object({
  weight: z.array(fitbitWeightLogSchema),
});

type FitbitWeightListResponse = z.infer<typeof fitbitWeightListResponseSchema>;

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
  sleepType: "main" | "not_main";
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
    sleepType: sleep.isMainSleep ? "main" : "not_main",
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

export class FitbitClient extends ProviderHttpClient {
  constructor(accessToken: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    super(accessToken, FITBIT_API_BASE, fetchFn);
  }

  async getActivities(afterDate: string, offset = 0): Promise<FitbitActivityListResponse> {
    return this.get(
      `/1/user/-/activities/list.json?afterDate=${afterDate}&sort=asc&limit=20&offset=${offset}`,
      fitbitActivityListResponseSchema,
    );
  }

  async getSleepLogs(afterDate: string, offset = 0): Promise<FitbitSleepListResponse> {
    return this.get(
      `/1.2/user/-/sleep/list.json?afterDate=${afterDate}&sort=asc&limit=20&offset=${offset}`,
      fitbitSleepListResponseSchema,
    );
  }

  async getDailySummary(date: string): Promise<FitbitDailySummary> {
    return this.get(`/1/user/-/activities/date/${date}.json`, fitbitDailySummarySchema);
  }

  async getWeightLogs(startDate: string): Promise<FitbitWeightListResponse> {
    return this.get(
      `/1/user/-/body/log/weight/date/${startDate}/30d.json`,
      fitbitWeightListResponseSchema,
    );
  }
}

// ============================================================
// OAuth configuration
// ============================================================

export function fitbitOAuthConfig(): OAuthConfig | null {
  const clientId = process.env.FITBIT_CLIENT_ID;
  const clientSecret = process.env.FITBIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    authorizeUrl: "https://www.fitbit.com/oauth2/authorize",
    tokenUrl: `${FITBIT_API_BASE}/oauth2/token`,
    redirectUri: getOAuthRedirectUri(),
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

export class FitbitProvider implements SyncProvider {
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
      getUserIdentity: async (accessToken: string): Promise<ProviderIdentity> => {
        const response = await fetchFn(`${FITBIT_API_BASE}/1/user/-/profile.json`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Fitbit profile API error (${response.status}): ${text}`);
        }
        const data: {
          user: { encodedId: string; displayName?: string | null };
        } = await response.json();
        return {
          providerAccountId: data.user.encodedId,
          email: null,
          name: data.user.displayName ?? null,
        };
      },
    };
  }

  private async resolveTokens(db: SyncDatabase): Promise<TokenSet> {
    return resolveOAuthTokens({
      db,
      providerId: this.id,
      providerName: this.name,
      getOAuthConfig: () => fitbitOAuthConfig(),
      fetchFn: this.fetchFn,
    });
  }

  async sync(db: SyncDatabase, since: Date): Promise<SyncResult> {
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
                target: [dailyMetrics.date, dailyMetrics.providerId, dailyMetrics.sourceName],
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
