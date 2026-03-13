import { and, eq } from "drizzle-orm";
import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import { exchangeCodeForTokens, refreshAccessToken } from "../auth/oauth.ts";
import type { Database } from "../db/index.ts";
import {
  activity,
  bodyMeasurement,
  DEFAULT_USER_ID,
  dailyMetrics,
  sleepSession,
  userSettings,
} from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import type { Provider, ProviderAuthSetup, SyncError, SyncResult } from "./types.ts";

// ============================================================
// Garmin Health API types (official REST API response shapes)
// ============================================================

export interface GarminActivitySummary {
  activityId: number;
  activityName: string;
  activityType: string; // "RUNNING", "CYCLING", etc.
  startTimeInSeconds: number; // UTC epoch seconds
  startTimeOffsetInSeconds: number;
  durationInSeconds: number;
  distanceInMeters: number;
  averageHeartRateInBeatsPerMinute?: number;
  maxHeartRateInBeatsPerMinute?: number;
  averageSpeedInMetersPerSecond?: number;
  activeKilocalories?: number;
  averageBikeCadenceInRoundsPerMinute?: number;
  averageRunCadenceInStepsPerMinute?: number;
  averagePowerInWatts?: number;
  maxPowerInWatts?: number;
  normalizedPowerInWatts?: number;
  totalElevationGainInMeters?: number;
  totalElevationLossInMeters?: number;
  deviceName?: string;
  manual?: boolean;
}

export interface GarminSleepSummary {
  calendarDate: string;
  startTimeInSeconds: number; // UTC epoch seconds
  startTimeOffsetInSeconds: number;
  durationInSeconds: number;
  deepSleepDurationInSeconds: number;
  lightSleepDurationInSeconds: number;
  remSleepInSeconds: number;
  awakeDurationInSeconds: number;
  averageSpO2Value?: number;
  lowestSpO2Value?: number;
  averageRespirationValue?: number;
  overallSleepScore?: number;
}

export interface GarminDailySummary {
  calendarDate: string;
  startTimeInSeconds: number;
  startTimeOffsetInSeconds: number;
  durationInSeconds: number;
  steps: number;
  distanceInMeters: number;
  activeKilocalories: number;
  bmrKilocalories: number;
  restingHeartRateInBeatsPerMinute?: number;
  maxHeartRateInBeatsPerMinute?: number;
  averageStressLevel?: number;
  maxStressLevel?: number;
  bodyBatteryChargedValue?: number;
  bodyBatteryDrainedValue?: number;
  averageSpo2?: number;
  lowestSpo2?: number;
  respirationAvg?: number;
  floorsClimbed?: number;
  moderateIntensityDurationInSeconds?: number;
  vigorousIntensityDurationInSeconds?: number;
}

export interface GarminBodyComposition {
  measurementTimeInSeconds: number; // UTC epoch seconds
  measurementTimeOffsetInSeconds?: number;
  weightInGrams: number;
  bmi?: number;
  bodyFatInPercent?: number;
  muscleMassInGrams?: number;
  boneMassInGrams?: number;
  bodyWaterInPercent?: number;
}

// ============================================================
// Parsed types
// ============================================================

export interface ParsedGarminActivity {
  externalId: string;
  activityType: string;
  name: string;
  startedAt: Date;
  endedAt: Date;
  raw: GarminActivitySummary;
}

export interface ParsedGarminSleep {
  externalId: string;
  startedAt: Date;
  endedAt: Date;
  durationMinutes: number;
  deepMinutes: number;
  lightMinutes: number;
  remMinutes: number;
  awakeMinutes: number;
}

export interface ParsedGarminDailyMetrics {
  date: string;
  steps: number;
  distanceKm: number;
  activeEnergyKcal: number;
  basalEnergyKcal: number;
  restingHr: number | undefined;
  spo2Avg: number | undefined;
  respiratoryRateAvg: number | undefined;
  flightsClimbed: number | undefined;
  exerciseMinutes: number | undefined;
}

export interface ParsedGarminBodyMeasurement {
  externalId: string;
  recordedAt: Date;
  weightKg: number;
  bmi: number | undefined;
  bodyFatPct: number | undefined;
  muscleMassKg: number | undefined;
  boneMassKg: number | undefined;
  waterPct: number | undefined;
}

// ============================================================
// Activity type mapping
// ============================================================

const GARMIN_ACTIVITY_TYPE_MAP: Record<string, string> = {
  // Running
  RUNNING: "running",
  TRAIL_RUNNING: "running",
  TREADMILL_RUNNING: "running",
  TRACK_RUNNING: "running",
  // Cycling
  CYCLING: "cycling",
  MOUNTAIN_BIKING: "cycling",
  ROAD_BIKING: "cycling",
  INDOOR_CYCLING: "cycling",
  GRAVEL_CYCLING: "cycling",
  VIRTUAL_RIDE: "cycling",
  // Swimming
  SWIMMING: "swimming",
  LAP_SWIMMING: "swimming",
  OPEN_WATER_SWIMMING: "swimming",
  // Walking / Hiking
  WALKING: "walking",
  HIKING: "hiking",
  // Strength / Cardio
  STRENGTH_TRAINING: "strength",
  INDOOR_CARDIO: "cardio",
  // Other fitness
  YOGA: "yoga",
  PILATES: "pilates",
  ELLIPTICAL: "elliptical",
  ROWING: "rowing",
};

export function mapGarminActivityType(activityType: string): string {
  return GARMIN_ACTIVITY_TYPE_MAP[activityType] ?? "other";
}

// ============================================================
// Pure parsing functions
// ============================================================

export function parseGarminActivity(raw: GarminActivitySummary): ParsedGarminActivity {
  const startedAt = new Date(raw.startTimeInSeconds * 1000);
  const endedAt = new Date((raw.startTimeInSeconds + raw.durationInSeconds) * 1000);

  return {
    externalId: String(raw.activityId),
    activityType: mapGarminActivityType(raw.activityType),
    name: raw.activityName,
    startedAt,
    endedAt,
    raw,
  };
}

export function parseGarminSleep(sleep: GarminSleepSummary): ParsedGarminSleep {
  return {
    externalId: sleep.calendarDate,
    startedAt: new Date(sleep.startTimeInSeconds * 1000),
    endedAt: new Date((sleep.startTimeInSeconds + sleep.durationInSeconds) * 1000),
    durationMinutes: Math.round(sleep.durationInSeconds / 60),
    deepMinutes: Math.round(sleep.deepSleepDurationInSeconds / 60),
    lightMinutes: Math.round(sleep.lightSleepDurationInSeconds / 60),
    remMinutes: Math.round(sleep.remSleepInSeconds / 60),
    awakeMinutes: Math.round(sleep.awakeDurationInSeconds / 60),
  };
}

export function parseGarminDailySummary(summary: GarminDailySummary): ParsedGarminDailyMetrics {
  const moderateSec = summary.moderateIntensityDurationInSeconds;
  const vigorousSec = summary.vigorousIntensityDurationInSeconds;
  let exerciseMinutes: number | undefined;
  if (moderateSec !== undefined || vigorousSec !== undefined) {
    exerciseMinutes = Math.round(((moderateSec ?? 0) + (vigorousSec ?? 0)) / 60);
  }

  return {
    date: summary.calendarDate,
    steps: summary.steps,
    distanceKm: summary.distanceInMeters / 1000,
    activeEnergyKcal: summary.activeKilocalories,
    basalEnergyKcal: summary.bmrKilocalories,
    restingHr: summary.restingHeartRateInBeatsPerMinute,
    spo2Avg: summary.averageSpo2,
    respiratoryRateAvg: summary.respirationAvg,
    flightsClimbed: summary.floorsClimbed,
    exerciseMinutes,
  };
}

export function parseGarminBodyComposition(
  entry: GarminBodyComposition,
): ParsedGarminBodyMeasurement {
  return {
    externalId: String(entry.measurementTimeInSeconds),
    recordedAt: new Date(entry.measurementTimeInSeconds * 1000),
    weightKg: entry.weightInGrams / 1000,
    bmi: entry.bmi,
    bodyFatPct: entry.bodyFatInPercent,
    muscleMassKg:
      entry.muscleMassInGrams !== undefined ? entry.muscleMassInGrams / 1000 : undefined,
    boneMassKg: entry.boneMassInGrams !== undefined ? entry.boneMassInGrams / 1000 : undefined,
    waterPct: entry.bodyWaterInPercent,
  };
}

// ============================================================
// Garmin Health API Client (official OAuth 2.0 + Bearer token)
// ============================================================

const GARMIN_HEALTH_API_BASE = "https://apis.garmin.com/wellness-api/rest";

export class GarminClient {
  private accessToken: string;
  private fetchFn: typeof globalThis.fetch;

  constructor(accessToken: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.accessToken = accessToken;
    this.fetchFn = fetchFn;
  }

  private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${GARMIN_HEALTH_API_BASE}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    const response = await this.fetchFn(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Garmin API error (${response.status}): ${text}`);
    }

    return response.json() as Promise<T>;
  }

  async getActivities(
    uploadStartTimeInSeconds: number,
    uploadEndTimeInSeconds: number,
  ): Promise<GarminActivitySummary[]> {
    return this.get<GarminActivitySummary[]>("/activities", {
      uploadStartTimeInSeconds: String(uploadStartTimeInSeconds),
      uploadEndTimeInSeconds: String(uploadEndTimeInSeconds),
    });
  }

  async getSleep(
    uploadStartTimeInSeconds: number,
    uploadEndTimeInSeconds: number,
  ): Promise<GarminSleepSummary[]> {
    return this.get<GarminSleepSummary[]>("/sleep", {
      uploadStartTimeInSeconds: String(uploadStartTimeInSeconds),
      uploadEndTimeInSeconds: String(uploadEndTimeInSeconds),
    });
  }

  async getDailySummaries(
    uploadStartTimeInSeconds: number,
    uploadEndTimeInSeconds: number,
  ): Promise<GarminDailySummary[]> {
    return this.get<GarminDailySummary[]>("/dailies", {
      uploadStartTimeInSeconds: String(uploadStartTimeInSeconds),
      uploadEndTimeInSeconds: String(uploadEndTimeInSeconds),
    });
  }

  async getBodyComposition(
    uploadStartTimeInSeconds: number,
    uploadEndTimeInSeconds: number,
  ): Promise<GarminBodyComposition[]> {
    return this.get<GarminBodyComposition[]>("/bodyComposition", {
      uploadStartTimeInSeconds: String(uploadStartTimeInSeconds),
      uploadEndTimeInSeconds: String(uploadEndTimeInSeconds),
    });
  }
}

// ============================================================
// OAuth 2.0 configuration
// ============================================================

const GARMIN_OAUTH_AUTHORIZE_URL = "https://connect.garmin.com/oauth2/authorize";
const GARMIN_OAUTH_TOKEN_URL = "https://diauth.garmin.com/di-oauth2-service/oauth/token";

export function garminOAuthConfig(): OAuthConfig | null {
  const clientId = process.env.GARMIN_CLIENT_ID;
  if (!clientId) return null;

  const clientSecret = process.env.GARMIN_CLIENT_SECRET;
  const redirectUri = process.env.OAUTH_REDIRECT_URI ?? "https://dofek.asherlc.com/callback";

  return {
    clientId,
    clientSecret: clientSecret ?? undefined,
    authorizeUrl: GARMIN_OAUTH_AUTHORIZE_URL,
    tokenUrl: GARMIN_OAUTH_TOKEN_URL,
    redirectUri,
    scopes: [],
    usePkce: true,
  };
}

// ============================================================
// Sync cursor helpers
// ============================================================

const SYNC_CURSOR_KEY = "garmin_sync_cursor";

async function loadSyncCursor(db: Database): Promise<string | null> {
  const rows = await db
    .select({ value: userSettings.value })
    .from(userSettings)
    .where(and(eq(userSettings.userId, DEFAULT_USER_ID), eq(userSettings.key, SYNC_CURSOR_KEY)))
    .limit(1);

  if (rows.length === 0 || !rows[0]) return null;
  const value = rows[0].value as { cursor?: string };
  return value.cursor ?? null;
}

async function saveSyncCursor(db: Database, cursor: string): Promise<void> {
  await db
    .insert(userSettings)
    .values({
      userId: DEFAULT_USER_ID,
      key: SYNC_CURSOR_KEY,
      value: { cursor },
    })
    .onConflictDoUpdate({
      target: [userSettings.userId, userSettings.key],
      set: { value: { cursor }, updatedAt: new Date() },
    });
}

// ============================================================
// Provider
// ============================================================

export class GarminProvider implements Provider {
  readonly id = "garmin";
  readonly name = "Garmin Connect";
  private fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.fetchFn = fetchFn;
  }

  validate(): string | null {
    if (!process.env.GARMIN_CLIENT_ID) return "GARMIN_CLIENT_ID is not set";
    return null;
  }

  authSetup(): ProviderAuthSetup {
    const config = garminOAuthConfig();
    if (!config) throw new Error("GARMIN_CLIENT_ID is required");
    return {
      oauthConfig: config,
      exchangeCode: (code, codeVerifier) =>
        exchangeCodeForTokens(
          config,
          code,
          this.fetchFn,
          codeVerifier ? { codeVerifier } : undefined,
        ),
      apiBaseUrl: GARMIN_HEALTH_API_BASE,
    };
  }

  private async resolveTokens(db: Database): Promise<TokenSet> {
    const tokens = await loadTokens(db, this.id);
    if (!tokens) {
      throw new Error("No OAuth tokens found for Garmin. Authorize via the dashboard first.");
    }

    if (tokens.expiresAt > new Date()) {
      return tokens;
    }

    console.log("[garmin] Access token expired, refreshing...");
    const config = garminOAuthConfig();
    if (!config) throw new Error("GARMIN_CLIENT_ID is required to refresh tokens");
    const refreshed = await refreshAccessToken(config, tokens.refreshToken, this.fetchFn);
    await saveTokens(db, this.id, refreshed);
    return refreshed;
  }

  async sync(db: Database, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    let tokens: TokenSet;
    try {
      tokens = await this.resolveTokens(db);
    } catch (err) {
      return {
        provider: this.id,
        recordsSynced: 0,
        errors: [{ message: err instanceof Error ? err.message : String(err), cause: err }],
        duration: Date.now() - start,
      };
    }

    await ensureProvider(db, this.id, this.name, GARMIN_HEALTH_API_BASE);

    const client = new GarminClient(tokens.accessToken, this.fetchFn);

    // Use sync cursor if available, otherwise fall back to `since` param
    const cursor = await loadSyncCursor(db);
    const effectiveSince = cursor ? new Date(cursor) : since;

    const now = new Date();
    const sinceEpochSeconds = Math.floor(effectiveSince.getTime() / 1000);
    const nowEpochSeconds = Math.floor(now.getTime() / 1000);

    // Sync activities
    try {
      const activityCount = await withSyncLog(db, this.id, "activities", async () => {
        const count = await this.syncActivities(db, client, sinceEpochSeconds, nowEpochSeconds);
        return { recordCount: count, result: count };
      });
      recordsSynced += activityCount;
    } catch (err) {
      errors.push({
        message: `Activities sync failed: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // Sync sleep
    try {
      const sleepCount = await withSyncLog(db, this.id, "sleep", async () => {
        const count = await this.syncSleep(db, client, sinceEpochSeconds, nowEpochSeconds);
        return { recordCount: count, result: count };
      });
      recordsSynced += sleepCount;
    } catch (err) {
      errors.push({
        message: `Sleep sync failed: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // Sync daily summaries
    try {
      const dailyCount = await withSyncLog(db, this.id, "daily_metrics", async () => {
        const count = await this.syncDailyMetrics(db, client, sinceEpochSeconds, nowEpochSeconds);
        return { recordCount: count, result: count };
      });
      recordsSynced += dailyCount;
    } catch (err) {
      errors.push({
        message: `Daily metrics sync failed: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // Sync body composition
    try {
      const weightCount = await withSyncLog(db, this.id, "body_composition", async () => {
        const count = await this.syncBodyComposition(
          db,
          client,
          sinceEpochSeconds,
          nowEpochSeconds,
        );
        return { recordCount: count, result: count };
      });
      recordsSynced += weightCount;
    } catch (err) {
      errors.push({
        message: `Body composition sync failed: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // Save sync cursor
    await saveSyncCursor(db, now.toISOString());

    return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
  }

  private async syncActivities(
    db: Database,
    client: GarminClient,
    sinceEpochSeconds: number,
    untilEpochSeconds: number,
  ): Promise<number> {
    const activities = await client.getActivities(sinceEpochSeconds, untilEpochSeconds);
    let count = 0;

    for (const raw of activities) {
      const parsed = parseGarminActivity(raw);

      await db
        .insert(activity)
        .values({
          providerId: this.id,
          externalId: parsed.externalId,
          activityType: parsed.activityType,
          startedAt: parsed.startedAt,
          endedAt: parsed.endedAt,
          name: parsed.name,
          raw: parsed.raw,
        })
        .onConflictDoUpdate({
          target: [activity.providerId, activity.externalId],
          set: {
            activityType: parsed.activityType,
            startedAt: parsed.startedAt,
            endedAt: parsed.endedAt,
            name: parsed.name,
            raw: parsed.raw,
          },
        });

      count++;
    }

    return count;
  }

  private async syncSleep(
    db: Database,
    client: GarminClient,
    sinceEpochSeconds: number,
    untilEpochSeconds: number,
  ): Promise<number> {
    const sleepRecords = await client.getSleep(sinceEpochSeconds, untilEpochSeconds);
    let count = 0;

    for (const raw of sleepRecords) {
      if (!raw.startTimeInSeconds) continue;

      const parsed = parseGarminSleep(raw);

      await db
        .insert(sleepSession)
        .values({
          providerId: this.id,
          externalId: parsed.externalId,
          startedAt: parsed.startedAt,
          endedAt: parsed.endedAt,
          durationMinutes: parsed.durationMinutes,
          deepMinutes: parsed.deepMinutes,
          lightMinutes: parsed.lightMinutes,
          remMinutes: parsed.remMinutes,
          awakeMinutes: parsed.awakeMinutes,
        })
        .onConflictDoUpdate({
          target: [sleepSession.providerId, sleepSession.externalId],
          set: {
            startedAt: parsed.startedAt,
            endedAt: parsed.endedAt,
            durationMinutes: parsed.durationMinutes,
            deepMinutes: parsed.deepMinutes,
            lightMinutes: parsed.lightMinutes,
            remMinutes: parsed.remMinutes,
            awakeMinutes: parsed.awakeMinutes,
          },
        });

      count++;
    }

    return count;
  }

  private async syncDailyMetrics(
    db: Database,
    client: GarminClient,
    sinceEpochSeconds: number,
    untilEpochSeconds: number,
  ): Promise<number> {
    const summaries = await client.getDailySummaries(sinceEpochSeconds, untilEpochSeconds);
    let count = 0;

    for (const raw of summaries) {
      if (!raw.calendarDate) continue;

      const parsed = parseGarminDailySummary(raw);

      await db
        .insert(dailyMetrics)
        .values({
          date: parsed.date,
          providerId: this.id,
          steps: parsed.steps,
          distanceKm: parsed.distanceKm,
          activeEnergyKcal: parsed.activeEnergyKcal,
          basalEnergyKcal: parsed.basalEnergyKcal,
          restingHr: parsed.restingHr,
          spo2Avg: parsed.spo2Avg,
          respiratoryRateAvg: parsed.respiratoryRateAvg,
          flightsClimbed: parsed.flightsClimbed,
          exerciseMinutes: parsed.exerciseMinutes,
        })
        .onConflictDoUpdate({
          target: [dailyMetrics.date, dailyMetrics.providerId],
          set: {
            steps: parsed.steps,
            distanceKm: parsed.distanceKm,
            activeEnergyKcal: parsed.activeEnergyKcal,
            basalEnergyKcal: parsed.basalEnergyKcal,
            restingHr: parsed.restingHr,
            spo2Avg: parsed.spo2Avg,
            respiratoryRateAvg: parsed.respiratoryRateAvg,
            flightsClimbed: parsed.flightsClimbed,
            exerciseMinutes: parsed.exerciseMinutes,
          },
        });

      count++;
    }

    return count;
  }

  private async syncBodyComposition(
    db: Database,
    client: GarminClient,
    sinceEpochSeconds: number,
    untilEpochSeconds: number,
  ): Promise<number> {
    const entries = await client.getBodyComposition(sinceEpochSeconds, untilEpochSeconds);
    let count = 0;

    for (const raw of entries) {
      if (!raw.weightInGrams) continue;

      const parsed = parseGarminBodyComposition(raw);

      await db
        .insert(bodyMeasurement)
        .values({
          providerId: this.id,
          externalId: parsed.externalId,
          recordedAt: parsed.recordedAt,
          weightKg: parsed.weightKg,
          bmi: parsed.bmi,
          bodyFatPct: parsed.bodyFatPct,
          muscleMassKg: parsed.muscleMassKg,
          boneMassKg: parsed.boneMassKg,
          waterPct: parsed.waterPct,
        })
        .onConflictDoUpdate({
          target: [bodyMeasurement.providerId, bodyMeasurement.externalId],
          set: {
            recordedAt: parsed.recordedAt,
            weightKg: parsed.weightKg,
            bmi: parsed.bmi,
            bodyFatPct: parsed.bodyFatPct,
            muscleMassKg: parsed.muscleMassKg,
            boneMassKg: parsed.boneMassKg,
            waterPct: parsed.waterPct,
          },
        });

      count++;
    }

    return count;
  }
}
