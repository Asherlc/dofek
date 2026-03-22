import { createActivityTypeMapper, POLAR_SPORT_MAP } from "@dofek/training/training";
import { eq } from "drizzle-orm";
import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import { exchangeCodeForTokens, getOAuthRedirectUri } from "../auth/oauth.ts";
import type { SyncDatabase } from "../db/index.ts";
import { activity, dailyMetrics, sleepSession, sleepStage } from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens } from "../db/tokens.ts";
import type { ProviderAuthSetup, SyncError, SyncProvider, SyncResult } from "./types.ts";

// ============================================================
// Polar AccessLink API types
// ============================================================

export interface PolarExercise {
  id: string;
  upload_time: string;
  polar_user: string;
  device: string;
  start_time: string;
  duration: string; // ISO 8601 duration "PT1H23M45S"
  calories: number;
  distance?: number; // meters
  heart_rate?: { average: number; maximum: number };
  sport: string; // "RUNNING", "CYCLING", etc.
  has_route: boolean;
  detailed_sport_info: string;
}

export interface PolarSleep {
  polar_user: string;
  date: string; // "2024-06-15"
  sleep_start_time: string; // ISO datetime
  sleep_end_time: string;
  device_id: string;
  continuity: number;
  continuity_class: number;
  light_sleep: number; // seconds
  deep_sleep: number; // seconds
  rem_sleep: number; // seconds
  unrecognized_sleep_stage: number;
  sleep_score: number;
  total_interruption_duration: number; // seconds
  sleep_charge: number; // 1-5
  sleep_goal_minutes: number;
  sleep_rating: number; // 1-5
  hypnogram: Record<string, number>; // minute -> stage
}

export interface PolarDailyActivity {
  polar_user: string;
  date: string;
  created: string;
  calories: number;
  active_calories: number;
  duration: string; // ISO duration
  active_steps: number;
}

export interface PolarNightlyRecharge {
  polar_user: string;
  date: string;
  heart_rate_avg: number;
  beat_to_beat_avg: number; // ms (beat-to-beat interval)
  heart_rate_variability_avg: number; // ms
  breathing_rate_avg: number;
  nightly_recharge_status: number; // 1-5
  ans_charge: number; // 0-10
  ans_charge_status: number; // 1-5
}

// ============================================================
// Sport mapping
// ============================================================

const mapPolarType = createActivityTypeMapper(POLAR_SPORT_MAP);

export function mapPolarSport(sport: string): string {
  const key = sport.toLowerCase();
  return mapPolarType(key);
}

// ============================================================
// Parsing — pure functions
// ============================================================

/**
 * Parse ISO 8601 duration string (e.g. "PT1H23M45S") to seconds.
 */
export function parsePolarDuration(isoDuration: string): number {
  const hoursMatch = /(\d+(?:\.\d+)?)H/.exec(isoDuration);
  const minutesMatch = /(\d+(?:\.\d+)?)M/.exec(isoDuration);
  const secondsMatch = /(\d+(?:\.\d+)?)S/.exec(isoDuration);

  const hours = hoursMatch?.[1] ? Number.parseFloat(hoursMatch[1]) : 0;
  const minutes = minutesMatch?.[1] ? Number.parseFloat(minutesMatch[1]) : 0;
  const seconds = secondsMatch?.[1] ? Number.parseFloat(secondsMatch[1]) : 0;

  return hours * 3600 + minutes * 60 + seconds;
}

export interface ParsedPolarActivity {
  externalId: string;
  activityType: string;
  name: string;
  startedAt: Date;
  endedAt: Date;
  durationSeconds: number;
  distanceMeters?: number;
  calories: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
}

export function parsePolarExercise(exercise: PolarExercise): ParsedPolarActivity {
  const durationSeconds = parsePolarDuration(exercise.duration);
  const startedAt = new Date(exercise.start_time);
  const endedAt = new Date(startedAt.getTime() + durationSeconds * 1000);

  return {
    externalId: exercise.id,
    activityType: mapPolarSport(exercise.sport),
    name: exercise.detailed_sport_info,
    startedAt,
    endedAt,
    durationSeconds,
    distanceMeters: exercise.distance,
    calories: exercise.calories,
    avgHeartRate: exercise.heart_rate?.average,
    maxHeartRate: exercise.heart_rate?.maximum,
  };
}

export interface ParsedPolarSleep {
  externalId: string;
  startedAt: Date;
  endedAt: Date;
  durationMinutes: number;
  lightMinutes: number;
  deepMinutes: number;
  remMinutes: number;
  awakeMinutes: number;
}

export interface ParsedPolarSleepStage {
  stage: "deep" | "light" | "rem" | "awake";
  startedAt: Date;
  endedAt: Date;
}

export function parsePolarSleep(sleep: PolarSleep): ParsedPolarSleep {
  const startedAt = new Date(sleep.sleep_start_time);
  const endedAt = new Date(sleep.sleep_end_time);

  const lightMinutes = Math.round(sleep.light_sleep / 60);
  const deepMinutes = Math.round(sleep.deep_sleep / 60);
  const remMinutes = Math.round(sleep.rem_sleep / 60);
  const awakeMinutes = Math.round(sleep.total_interruption_duration / 60);

  return {
    externalId: sleep.date,
    startedAt,
    endedAt,
    durationMinutes: lightMinutes + deepMinutes + remMinutes,
    lightMinutes,
    deepMinutes,
    remMinutes,
    awakeMinutes,
  };
}

// Polar hypnogram stage codes (from Polar API documentation):
// 1 = deep, 2 = light, 3 = REM, 4 = interrupted (awake), 5 = awake (at sleep boundary)
const POLAR_HYPNOGRAM_STAGE_MAP: Record<number, "deep" | "light" | "rem" | "awake"> = {
  1: "deep",
  2: "light",
  3: "rem",
  4: "awake",
  5: "awake",
};

export function parsePolarSleepStages(
  sleepStartTime: string,
  hypnogram: Record<string, number>,
): ParsedPolarSleepStage[] {
  const startMs = new Date(sleepStartTime).getTime();
  const entries = Object.entries(hypnogram)
    .map(([minuteStr, stageValue]) => ({
      minute: Number(minuteStr),
      stage: POLAR_HYPNOGRAM_STAGE_MAP[stageValue],
    }))
    .filter(
      (e): e is { minute: number; stage: "deep" | "light" | "rem" | "awake" } => e.stage != null,
    )
    .sort((a, b) => a.minute - b.minute);

  if (entries.length === 0) return [];

  // Safe: guarded by entries.length === 0 check above
  const first = entries[0]!;

  // Merge consecutive identical stages into intervals.
  // Each hypnogram entry represents one minute starting at that offset.
  const stages: ParsedPolarSleepStage[] = [];
  let currentStage = first.stage;
  let currentStart = first.minute;
  let previousMinute = first.minute;

  for (let i = 1; i < entries.length; i++) {
    const entry = entries[i]!;
    // Start a new interval if stage changed or there's a gap
    if (entry.stage !== currentStage || entry.minute !== previousMinute + 1) {
      stages.push({
        stage: currentStage,
        startedAt: new Date(startMs + currentStart * 60000),
        endedAt: new Date(startMs + (previousMinute + 1) * 60000),
      });
      currentStage = entry.stage;
      currentStart = entry.minute;
    }
    previousMinute = entry.minute;
  }

  // Push final interval
  stages.push({
    stage: currentStage,
    startedAt: new Date(startMs + currentStart * 60000),
    endedAt: new Date(startMs + (previousMinute + 1) * 60000),
  });

  return stages;
}

export interface ParsedPolarDailyMetrics {
  date: string;
  steps: number;
  activeEnergyKcal: number;
  restingHr?: number;
  hrv?: number;
  respiratoryRateAvg?: number;
}

export function parsePolarDailyActivity(
  daily: PolarDailyActivity,
  recharge: PolarNightlyRecharge | null,
): ParsedPolarDailyMetrics {
  return {
    date: daily.date,
    steps: daily.active_steps,
    activeEnergyKcal: daily.active_calories,
    restingHr: recharge?.heart_rate_avg,
    hrv: recharge?.heart_rate_variability_avg,
    respiratoryRateAvg: recharge?.breathing_rate_avg,
  };
}

// ============================================================
// Polar OAuth configuration
// ============================================================

const POLAR_API_BASE = "https://www.polaraccesslink.com/v3";
const POLAR_AUTHORIZE_URL = "https://flow.polar.com/oauth2/authorization";
const POLAR_TOKEN_URL = "https://polarremote.com/v2/oauth2/token";

function polarOAuthConfig(): OAuthConfig | null {
  const clientId = process.env.POLAR_CLIENT_ID;
  const clientSecret = process.env.POLAR_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    authorizeUrl: POLAR_AUTHORIZE_URL,
    tokenUrl: POLAR_TOKEN_URL,
    redirectUri: getOAuthRedirectUri(),
    scopes: ["accesslink.read_all"],
    tokenAuthMethod: "basic",
  };
}

// ============================================================
// Polar API client
// ============================================================

export class PolarNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolarNotFoundError";
  }
}

export class PolarUnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolarUnauthorizedError";
  }
}

export class PolarClient {
  private accessToken: string;
  private fetchFn: typeof globalThis.fetch;

  constructor(accessToken: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.accessToken = accessToken;
    this.fetchFn = fetchFn;
  }

  private async get<T>(path: string): Promise<T> {
    const response = await this.fetchFn(`${POLAR_API_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: "application/json",
      },
    });

    if (response.status === 401 || response.status === 403) {
      throw new PolarUnauthorizedError(`Polar API unauthorized (${response.status}): ${path}`);
    }

    if (response.status === 404) {
      throw new PolarNotFoundError(`Polar API 404: ${path}`);
    }

    if (!response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      let detail: string;
      if (contentType.includes("application/json")) {
        const json = await response.json();
        detail = JSON.stringify(json);
      } else if (contentType.includes("text/html")) {
        detail = "(HTML error page)";
      } else {
        const text = await response.text();
        detail = text.length > 200 ? `${text.slice(0, 200)}…` : text;
      }
      throw new Error(`Polar API error (${response.status}): ${detail}`);
    }

    return response.json();
  }

  async getExercises(): Promise<PolarExercise[]> {
    return this.get<PolarExercise[]>("/exercises");
  }

  async getSleep(): Promise<PolarSleep[]> {
    return this.get<PolarSleep[]>("/sleep");
  }

  async getDailyActivity(): Promise<PolarDailyActivity[]> {
    return this.get<PolarDailyActivity[]>("/activity");
  }

  async getNightlyRecharge(): Promise<PolarNightlyRecharge[]> {
    return this.get<PolarNightlyRecharge[]>("/nightly-recharge");
  }
}

// ============================================================
// Provider implementation
// ============================================================

export class PolarProvider implements SyncProvider {
  readonly id = "polar";
  readonly name = "Polar";
  private fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.fetchFn = fetchFn;
  }

  validate(): string | null {
    if (!process.env.POLAR_CLIENT_ID) return "POLAR_CLIENT_ID is not set";
    if (!process.env.POLAR_CLIENT_SECRET) return "POLAR_CLIENT_SECRET is not set";
    return null;
  }

  authSetup(): ProviderAuthSetup {
    const config = polarOAuthConfig();
    if (!config) throw new Error("POLAR_CLIENT_ID and POLAR_CLIENT_SECRET are required");
    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeCodeForTokens(config, code),
      apiBaseUrl: POLAR_API_BASE,
    };
  }

  private async resolveTokens(db: SyncDatabase): Promise<TokenSet> {
    const tokens = await loadTokens(db, this.id);
    if (!tokens) {
      throw new Error("No OAuth tokens found for Polar. Run: health-data auth polar");
    }
    // Polar tokens don't expire unless revoked, but we still return them
    return tokens;
  }

  async sync(db: SyncDatabase, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, POLAR_API_BASE);

    let tokens: TokenSet;
    try {
      tokens = await this.resolveTokens(db);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const client = new PolarClient(tokens.accessToken, this.fetchFn);

    // --- Sync exercises (activities) ---
    try {
      const exerciseCount = await withSyncLog(db, this.id, "exercises", async () => {
        const exercises = await client.getExercises();
        let count = 0;

        for (const exercise of exercises) {
          // Skip exercises before our sync window
          if (new Date(exercise.start_time) < since) continue;

          const parsed = parsePolarExercise(exercise);

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
                raw: {
                  durationSeconds: parsed.durationSeconds,
                  distanceMeters: parsed.distanceMeters,
                  calories: parsed.calories,
                  avgHeartRate: parsed.avgHeartRate,
                  maxHeartRate: parsed.maxHeartRate,
                },
              })
              .onConflictDoUpdate({
                target: [activity.providerId, activity.externalId],
                set: {
                  activityType: parsed.activityType,
                  name: parsed.name,
                  startedAt: parsed.startedAt,
                  endedAt: parsed.endedAt,
                  raw: {
                    durationSeconds: parsed.durationSeconds,
                    distanceMeters: parsed.distanceMeters,
                    calories: parsed.calories,
                    avgHeartRate: parsed.avgHeartRate,
                    maxHeartRate: parsed.maxHeartRate,
                  },
                },
              });
            count++;
          } catch (err) {
            errors.push({
              message: `Exercise ${exercise.id}: ${err instanceof Error ? err.message : String(err)}`,
              externalId: exercise.id,
              cause: err,
            });
          }
        }

        return { recordCount: count, result: count };
      });
      recordsSynced += exerciseCount;
    } catch (err) {
      if (err instanceof PolarUnauthorizedError) {
        errors.push({
          message:
            "Polar authorization failed while syncing exercises — run: health-data auth polar",
          cause: err,
        });
      } else if (err instanceof PolarNotFoundError) {
        errors.push({
          message: "Polar exercises endpoint returned 404 — try re-authenticating with Polar",
          cause: err,
        });
      } else {
        errors.push({
          message: `exercises: ${err instanceof Error ? err.message : String(err)}`,
          cause: err,
        });
      }
    }

    // --- Sync sleep ---
    try {
      const sleepCount = await withSyncLog(db, this.id, "sleep", async () => {
        const sleepRecords = await client.getSleep();
        let count = 0;

        for (const sleepRecord of sleepRecords) {
          if (new Date(sleepRecord.sleep_start_time) < since) continue;

          const parsed = parsePolarSleep(sleepRecord);

          try {
            const [session] = await db
              .insert(sleepSession)
              .values({
                providerId: this.id,
                externalId: parsed.externalId,
                startedAt: parsed.startedAt,
                endedAt: parsed.endedAt,
                durationMinutes: parsed.durationMinutes,
                lightMinutes: parsed.lightMinutes,
                deepMinutes: parsed.deepMinutes,
                remMinutes: parsed.remMinutes,
                awakeMinutes: parsed.awakeMinutes,
              })
              .onConflictDoUpdate({
                target: [sleepSession.providerId, sleepSession.externalId],
                set: {
                  startedAt: parsed.startedAt,
                  endedAt: parsed.endedAt,
                  durationMinutes: parsed.durationMinutes,
                  lightMinutes: parsed.lightMinutes,
                  deepMinutes: parsed.deepMinutes,
                  remMinutes: parsed.remMinutes,
                  awakeMinutes: parsed.awakeMinutes,
                },
              })
              .returning({ id: sleepSession.id });

            const stages = sleepRecord.hypnogram
              ? parsePolarSleepStages(sleepRecord.sleep_start_time, sleepRecord.hypnogram)
              : [];
            if (session && stages.length > 0) {
              await db.delete(sleepStage).where(eq(sleepStage.sessionId, session.id));
              await db.insert(sleepStage).values(
                stages.map((s) => ({
                  sessionId: session.id,
                  stage: s.stage,
                  startedAt: s.startedAt,
                  endedAt: s.endedAt,
                })),
              );
            }

            count++;
          } catch (err) {
            errors.push({
              message: `Sleep ${sleepRecord.date}: ${err instanceof Error ? err.message : String(err)}`,
              externalId: sleepRecord.date,
              cause: err,
            });
          }
        }

        return { recordCount: count, result: count };
      });
      recordsSynced += sleepCount;
    } catch (err) {
      if (err instanceof PolarUnauthorizedError) {
        errors.push({
          message: "Polar authorization failed while syncing sleep — run: health-data auth polar",
          cause: err,
        });
      } else if (err instanceof PolarNotFoundError) {
        errors.push({
          message: "Polar sleep endpoint returned 404 — try re-authenticating with Polar",
          cause: err,
        });
      } else {
        errors.push({
          message: `sleep: ${err instanceof Error ? err.message : String(err)}`,
          cause: err,
        });
      }
    }

    // --- Sync daily activity + nightly recharge ---
    try {
      const dailyCount = await withSyncLog(db, this.id, "daily_activity", async () => {
        const [dailyActivities, nightlyRecharges] = await Promise.all([
          client.getDailyActivity(),
          client.getNightlyRecharge(),
        ]);

        // Index nightly recharge by date for O(1) lookup
        const rechargeByDate = new Map<string, PolarNightlyRecharge>();
        for (const recharge of nightlyRecharges) {
          rechargeByDate.set(recharge.date, recharge);
        }

        let count = 0;
        for (const daily of dailyActivities) {
          if (new Date(daily.date) < since) continue;

          const recharge = rechargeByDate.get(daily.date) ?? null;
          const parsed = parsePolarDailyActivity(daily, recharge);

          try {
            await db
              .insert(dailyMetrics)
              .values({
                date: parsed.date,
                providerId: this.id,
                steps: parsed.steps,
                activeEnergyKcal: parsed.activeEnergyKcal,
                restingHr: parsed.restingHr,
                hrv: parsed.hrv,
                respiratoryRateAvg: parsed.respiratoryRateAvg,
              })
              .onConflictDoUpdate({
                target: [dailyMetrics.date, dailyMetrics.providerId, dailyMetrics.sourceName],
                set: {
                  steps: parsed.steps,
                  activeEnergyKcal: parsed.activeEnergyKcal,
                  restingHr: parsed.restingHr,
                  hrv: parsed.hrv,
                  respiratoryRateAvg: parsed.respiratoryRateAvg,
                },
              });
            count++;
          } catch (err) {
            errors.push({
              message: `Daily ${daily.date}: ${err instanceof Error ? err.message : String(err)}`,
              externalId: daily.date,
              cause: err,
            });
          }
        }

        return { recordCount: count, result: count };
      });
      recordsSynced += dailyCount;
    } catch (err) {
      if (err instanceof PolarUnauthorizedError) {
        errors.push({
          message:
            "Polar authorization failed while syncing daily activity — run: health-data auth polar",
          cause: err,
        });
      } else if (err instanceof PolarNotFoundError) {
        errors.push({
          message: "Polar daily activity endpoint returned 404 — try re-authenticating with Polar",
          cause: err,
        });
      } else {
        errors.push({
          message: `daily_activity: ${err instanceof Error ? err.message : String(err)}`,
          cause: err,
        });
      }
    }

    return {
      provider: this.id,
      recordsSynced,
      errors,
      duration: Date.now() - start,
    };
  }
}
