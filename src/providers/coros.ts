import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import { exchangeCodeForTokens } from "../auth/oauth.ts";
import { resolveOAuthTokens } from "../auth/resolve-tokens.ts";
import type { SyncDatabase } from "../db/index.ts";
import { activity, dailyMetrics, sleepSession } from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider } from "../db/tokens.ts";
import type { ProviderAuthSetup, SyncError, SyncProvider, SyncResult } from "./types.ts";

// ============================================================
// COROS API types
// ============================================================

const COROS_API_BASE = "https://open.coros.com";
const DEFAULT_REDIRECT_URI = "https://localhost:9876/callback";

interface CorosWorkout {
  labelId: string;
  mode: number;
  subMode: number;
  startTime: number; // UNIX seconds
  endTime: number; // UNIX seconds
  duration: number; // seconds
  distance: number; // meters
  avgHeartRate: number;
  maxHeartRate: number;
  avgSpeed: number; // m/s
  maxSpeed: number; // m/s
  totalCalories: number;
  avgCadence?: number;
  avgPower?: number;
  maxPower?: number;
  totalAscent?: number;
  totalDescent?: number;
  avgStrokeRate?: number;
  fitUrl?: string;
}

interface CorosWorkoutsResponse {
  data: CorosWorkout[];
  message: string;
  result: string;
}

interface CorosDailyData {
  date: string; // YYYYMMDD
  steps?: number;
  distance?: number;
  calories?: number;
  restingHr?: number;
  avgHr?: number;
  maxHr?: number;
  sleepDuration?: number; // minutes
  deepSleep?: number; // minutes
  lightSleep?: number; // minutes
  remSleep?: number; // minutes
  awakeDuration?: number; // minutes
  spo2Avg?: number;
  hrv?: number;
}

interface CorosDailyResponse {
  data: CorosDailyData[];
  message: string;
  result: string;
}

// ============================================================
// Parsed types
// ============================================================

export interface ParsedCorosWorkout {
  externalId: string;
  activityType: string;
  name: string;
  startedAt: Date;
  endedAt: Date;
  raw: Record<string, unknown>;
}

// ============================================================
// Activity type mapping
// ============================================================

const COROS_SPORT_MAP: Record<number, string> = {
  8: "running",
  9: "cycling",
  10: "swimming",
  13: "strength",
  14: "walking",
  15: "hiking",
  17: "rowing",
  18: "yoga",
  22: "trail_running",
  23: "skiing",
  27: "triathlon",
  100: "other",
};

export function mapCorosSportType(mode: number): string {
  return COROS_SPORT_MAP[mode] ?? "other";
}

export function parseCorosWorkout(workout: CorosWorkout): ParsedCorosWorkout {
  return {
    externalId: workout.labelId,
    activityType: mapCorosSportType(workout.mode),
    name: `COROS ${mapCorosSportType(workout.mode)}`,
    startedAt: new Date(workout.startTime * 1000),
    endedAt: new Date(workout.endTime * 1000),
    raw: {
      distance: workout.distance,
      duration: workout.duration,
      avgHeartRate: workout.avgHeartRate,
      maxHeartRate: workout.maxHeartRate,
      avgSpeed: workout.avgSpeed,
      maxSpeed: workout.maxSpeed,
      calories: workout.totalCalories,
      avgCadence: workout.avgCadence,
      avgPower: workout.avgPower,
      maxPower: workout.maxPower,
      totalAscent: workout.totalAscent,
      totalDescent: workout.totalDescent,
      mode: workout.mode,
      subMode: workout.subMode,
    },
  };
}

// ============================================================
// OAuth configuration
// ============================================================

export function corosOAuthConfig(): OAuthConfig | null {
  const clientId = process.env.COROS_CLIENT_ID;
  const clientSecret = process.env.COROS_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const redirectUri = process.env.OAUTH_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;

  return {
    clientId,
    clientSecret,
    authorizeUrl: `${COROS_API_BASE}/oauth2/authorize`,
    tokenUrl: `${COROS_API_BASE}/oauth2/token`,
    redirectUri,
    scopes: [],
  };
}

// ============================================================
// Helper
// ============================================================

function formatDateCompact(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

// ============================================================
// Provider implementation
// ============================================================

export class CorosProvider implements SyncProvider {
  readonly id = "coros";
  readonly name = "COROS";
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = fetchFn;
  }

  validate(): string | null {
    if (!process.env.COROS_CLIENT_ID) return "COROS_CLIENT_ID is not set";
    if (!process.env.COROS_CLIENT_SECRET) return "COROS_CLIENT_SECRET is not set";
    return null;
  }

  authSetup(): ProviderAuthSetup {
    const config = corosOAuthConfig();
    if (!config) throw new Error("COROS_CLIENT_ID and CLIENT_SECRET required");
    const fetchFn = this.#fetchFn;
    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeCodeForTokens(config, code, fetchFn),
      apiBaseUrl: COROS_API_BASE,
    };
  }

  async #resolveTokens(db: SyncDatabase): Promise<TokenSet> {
    return resolveOAuthTokens({
      db,
      providerId: this.id,
      providerName: this.name,
      getOAuthConfig: () => corosOAuthConfig(),
      fetchFn: this.#fetchFn,
    });
  }

  async #apiGet<T>(accessToken: string, path: string): Promise<T> {
    const url = `${COROS_API_BASE}${path}`;
    const response = await this.#fetchFn(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`COROS API error (${response.status}): ${text}`);
    }
    return response.json();
  }

  async sync(db: SyncDatabase, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, COROS_API_BASE);

    let accessToken: string;
    try {
      const tokens = await this.#resolveTokens(db);
      accessToken = tokens.accessToken;
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const sinceDate = formatDateCompact(since);
    const toDate = formatDateCompact(new Date());

    // 1. Sync workouts
    try {
      const activityCount = await withSyncLog(db, this.id, "activity", async () => {
        const data = await this.#apiGet<CorosWorkoutsResponse>(
          accessToken,
          `/v2/coros/sport/list?startDate=${sinceDate}&endDate=${toDate}`,
        );
        let count = 0;

        for (const raw of data.data ?? []) {
          const parsed = parseCorosWorkout(raw);
          try {
            await db
              .insert(activity)
              .values({
                providerId: this.id,
                externalId: parsed.externalId,
                activityType: parsed.activityType,
                name: parsed.name,
                startedAt: parsed.startedAt,
                endedAt: parsed.endedAt,
                raw: parsed.raw,
              })
              .onConflictDoUpdate({
                target: [activity.providerId, activity.externalId],
                set: {
                  activityType: parsed.activityType,
                  name: parsed.name,
                  startedAt: parsed.startedAt,
                  endedAt: parsed.endedAt,
                  raw: parsed.raw,
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
      recordsSynced += activityCount;
    } catch (err) {
      errors.push({
        message: `activity: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 2. Sync daily data (sleep, HR, steps)
    try {
      const dailyCount = await withSyncLog(db, this.id, "daily_metrics", async () => {
        const data = await this.#apiGet<CorosDailyResponse>(
          accessToken,
          `/v2/coros/daily/list?startDate=${sinceDate}&endDate=${toDate}`,
        );
        let count = 0;

        for (const raw of data.data ?? []) {
          const dateStr = `${raw.date.slice(0, 4)}-${raw.date.slice(4, 6)}-${raw.date.slice(6, 8)}`;
          try {
            // Daily metrics
            if (raw.steps || raw.restingHr || raw.hrv) {
              await db
                .insert(dailyMetrics)
                .values({
                  date: dateStr,
                  providerId: this.id,
                  steps: raw.steps,
                  restingHr: raw.restingHr,
                  hrv: raw.hrv,
                  spo2Avg: raw.spo2Avg,
                  activeEnergyKcal: raw.calories,
                  distanceKm: raw.distance ? raw.distance / 1000 : undefined,
                })
                .onConflictDoUpdate({
                  target: [dailyMetrics.date, dailyMetrics.providerId, dailyMetrics.sourceName],
                  set: {
                    steps: raw.steps,
                    restingHr: raw.restingHr,
                    hrv: raw.hrv,
                    spo2Avg: raw.spo2Avg,
                    activeEnergyKcal: raw.calories,
                    distanceKm: raw.distance ? raw.distance / 1000 : undefined,
                  },
                });
              count++;
            }

            // Sleep
            if (raw.sleepDuration) {
              const externalId = `coros-sleep-${raw.date}`;
              await db
                .insert(sleepSession)
                .values({
                  providerId: this.id,
                  externalId,
                  startedAt: new Date(`${dateStr}T00:00:00Z`),
                  endedAt: new Date(`${dateStr}T08:00:00Z`),
                  durationMinutes: raw.sleepDuration,
                  deepMinutes: raw.deepSleep,
                  lightMinutes: raw.lightSleep,
                  remMinutes: raw.remSleep,
                  awakeMinutes: raw.awakeDuration,
                })
                .onConflictDoUpdate({
                  target: [sleepSession.providerId, sleepSession.externalId],
                  set: {
                    durationMinutes: raw.sleepDuration,
                    deepMinutes: raw.deepSleep,
                    lightMinutes: raw.lightSleep,
                    remMinutes: raw.remSleep,
                    awakeMinutes: raw.awakeDuration,
                  },
                });
              count++;
            }
          } catch (err) {
            errors.push({
              message: `daily ${dateStr}: ${err instanceof Error ? err.message : String(err)}`,
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

    return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
  }
}
