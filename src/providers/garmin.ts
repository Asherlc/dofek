import { and, eq } from "drizzle-orm";
import {
  GarminConnectClient,
  type GarminTokens,
  parseActivityDetail,
  parseConnectActivity,
  parseConnectDailySummary,
  parseConnectSleep,
  parseHeartRateTimeSeries,
  parseHrvSummary,
  parseStressTimeSeries,
  parseTrainingStatus,
} from "garmin-connect";
import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import { exchangeCodeForTokens, refreshAccessToken } from "../auth/oauth.ts";
import type { Database } from "../db/index.ts";
import {
  activity,
  bodyMeasurement,
  DEFAULT_USER_ID,
  dailyMetrics,
  metricStream,
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
// Internal token serialization
// ============================================================

const INTERNAL_SCOPE_MARKER = "garmin-connect-internal";

function serializeInternalTokens(tokens: GarminTokens): TokenSet {
  return {
    accessToken: JSON.stringify(tokens),
    refreshToken: null,
    expiresAt: new Date(tokens.oauth2.expires_at * 1000),
    scopes: INTERNAL_SCOPE_MARKER,
  };
}

function deserializeInternalTokens(stored: TokenSet): GarminTokens | null {
  if (stored.scopes !== INTERNAL_SCOPE_MARKER) return null;
  try {
    const parsed = JSON.parse(stored.accessToken) as Record<string, unknown>;
    if (typeof parsed === "object" && parsed !== null && "oauth1" in parsed && "oauth2" in parsed) {
      return parsed as unknown as GarminTokens;
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================
// Date helpers for internal API (day-by-day iteration)
// ============================================================

function formatDate(d: Date): string {
  return d.toISOString().split("T")[0] ?? "";
}

function eachDay(since: Date, until: Date): string[] {
  const dates: string[] = [];
  const current = new Date(since);
  current.setUTCHours(0, 0, 0, 0);
  const end = new Date(until);
  end.setUTCHours(0, 0, 0, 0);

  while (current <= end) {
    dates.push(formatDate(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
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
    const hasOfficialApi = !!process.env.GARMIN_CLIENT_ID;
    const hasCredentials = !!process.env.GARMIN_USERNAME && !!process.env.GARMIN_PASSWORD;
    if (!hasOfficialApi && !hasCredentials) {
      return "Either GARMIN_CLIENT_ID (official API) or GARMIN_USERNAME + GARMIN_PASSWORD (Connect internal API) must be set";
    }
    return null;
  }

  authSetup(): ProviderAuthSetup {
    const config = garminOAuthConfig();

    // Build a minimal OAuthConfig even for internal-only mode so the interface is satisfied
    const oauthConfig: OAuthConfig = config ?? {
      clientId: "garmin-connect-internal",
      authorizeUrl: "",
      tokenUrl: "",
      redirectUri: "",
      scopes: [],
    };

    const setup: ProviderAuthSetup = {
      oauthConfig,
      exchangeCode: async (code, codeVerifier) => {
        if (!config) throw new Error("GARMIN_CLIENT_ID is required for OAuth flow");
        return exchangeCodeForTokens(
          config,
          code,
          this.fetchFn,
          codeVerifier ? { codeVerifier } : undefined,
        );
      },
      apiBaseUrl: GARMIN_HEALTH_API_BASE,
    };

    // Add automated login for internal Connect API
    setup.automatedLogin = async (email: string, password: string): Promise<TokenSet> => {
      const { tokens } = await GarminConnectClient.signIn(
        email,
        password,
        "garmin.com",
        this.fetchFn,
      );
      return serializeInternalTokens(tokens);
    };

    return setup;
  }

  private async resolveTokens(db: Database): Promise<TokenSet> {
    const tokens = await loadTokens(db, this.id);
    if (!tokens) {
      throw new Error("No OAuth tokens found for Garmin. Authorize via the dashboard first.");
    }

    if (tokens.expiresAt > new Date()) {
      return tokens;
    }

    // For internal tokens, refresh via OAuth1→OAuth2 exchange
    const internalTokens = deserializeInternalTokens(tokens);
    if (internalTokens) {
      console.log("[garmin] Internal API token expired, refreshing via OAuth1 exchange...");
      const client = await GarminConnectClient.fromTokens(
        internalTokens,
        "garmin.com",
        this.fetchFn,
      );
      const refreshed = client.getTokens();
      if (!refreshed) throw new Error("Failed to refresh Garmin Connect tokens");
      const newTokenSet = serializeInternalTokens(refreshed);
      await saveTokens(db, this.id, newTokenSet);
      return newTokenSet;
    }

    // For official tokens, use standard refresh
    console.log("[garmin] Access token expired, refreshing...");
    const config = garminOAuthConfig();
    if (!config) throw new Error("GARMIN_CLIENT_ID is required to refresh tokens");
    if (!tokens.refreshToken) throw new Error("No refresh token for Garmin");
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

    // Use sync cursor if available, otherwise fall back to `since` param
    const cursor = await loadSyncCursor(db);
    const effectiveSince = cursor ? new Date(cursor) : since;
    const now = new Date();

    // Check if we're using the internal Connect API
    const internalTokens = deserializeInternalTokens(tokens);

    if (internalTokens) {
      // Internal API mode — more granular data
      const connectResult = await this.syncViaConnectApi(
        db,
        internalTokens,
        effectiveSince,
        now,
        errors,
      );
      recordsSynced += connectResult;
    } else {
      // Official API mode
      const officialResult = await this.syncViaOfficialApi(db, tokens, effectiveSince, now, errors);
      recordsSynced += officialResult;
    }

    // Save sync cursor
    await saveSyncCursor(db, now.toISOString());

    return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
  }

  // ============================================================
  // Official API sync (existing behavior)
  // ============================================================

  private async syncViaOfficialApi(
    db: Database,
    tokens: TokenSet,
    since: Date,
    until: Date,
    errors: SyncError[],
  ): Promise<number> {
    const client = new GarminClient(tokens.accessToken, this.fetchFn);
    const sinceEpochSeconds = Math.floor(since.getTime() / 1000);
    const untilEpochSeconds = Math.floor(until.getTime() / 1000);
    let recordsSynced = 0;

    // Sync activities
    try {
      const count = await withSyncLog(db, this.id, "activities", async () => {
        const c = await this.syncOfficialActivities(
          db,
          client,
          sinceEpochSeconds,
          untilEpochSeconds,
        );
        return { recordCount: c, result: c };
      });
      recordsSynced += count;
    } catch (err) {
      errors.push({
        message: `Activities sync failed: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // Sync sleep
    try {
      const count = await withSyncLog(db, this.id, "sleep", async () => {
        const c = await this.syncOfficialSleep(db, client, sinceEpochSeconds, untilEpochSeconds);
        return { recordCount: c, result: c };
      });
      recordsSynced += count;
    } catch (err) {
      errors.push({
        message: `Sleep sync failed: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // Sync daily summaries
    try {
      const count = await withSyncLog(db, this.id, "daily_metrics", async () => {
        const c = await this.syncOfficialDailyMetrics(
          db,
          client,
          sinceEpochSeconds,
          untilEpochSeconds,
        );
        return { recordCount: c, result: c };
      });
      recordsSynced += count;
    } catch (err) {
      errors.push({
        message: `Daily metrics sync failed: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // Sync body composition
    try {
      const count = await withSyncLog(db, this.id, "body_composition", async () => {
        const c = await this.syncOfficialBodyComposition(
          db,
          client,
          sinceEpochSeconds,
          untilEpochSeconds,
        );
        return { recordCount: c, result: c };
      });
      recordsSynced += count;
    } catch (err) {
      errors.push({
        message: `Body composition sync failed: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    return recordsSynced;
  }

  // ============================================================
  // Internal Connect API sync (enhanced data)
  // ============================================================

  private async syncViaConnectApi(
    db: Database,
    tokens: GarminTokens,
    since: Date,
    until: Date,
    errors: SyncError[],
  ): Promise<number> {
    let client: GarminConnectClient;
    try {
      client = await GarminConnectClient.fromTokens(tokens, "garmin.com", this.fetchFn);
    } catch (err) {
      errors.push({
        message: `Connect API authentication failed: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
      return 0;
    }

    // Save refreshed tokens back
    const refreshedTokens = client.getTokens();
    if (refreshedTokens) {
      await saveTokens(db, this.id, serializeInternalTokens(refreshedTokens));
    }

    const dates = eachDay(since, until);
    let recordsSynced = 0;

    // Sync activities (paginated)
    try {
      const count = await withSyncLog(db, this.id, "activities", async () => {
        const c = await this.syncConnectActivities(db, client);
        return { recordCount: c, result: c };
      });
      recordsSynced += count;
    } catch (err) {
      errors.push({
        message: `Activities sync failed: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // Sync sleep (day-by-day)
    try {
      const count = await withSyncLog(db, this.id, "sleep", async () => {
        const c = await this.syncConnectSleep(db, client, dates);
        return { recordCount: c, result: c };
      });
      recordsSynced += count;
    } catch (err) {
      errors.push({
        message: `Sleep sync failed: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // Sync daily metrics with training data (day-by-day)
    try {
      const count = await withSyncLog(db, this.id, "daily_metrics", async () => {
        const c = await this.syncConnectDailyMetrics(db, client, dates);
        return { recordCount: c, result: c };
      });
      recordsSynced += count;
    } catch (err) {
      errors.push({
        message: `Daily metrics sync failed: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // Sync stress time-series (day-by-day)
    try {
      const count = await withSyncLog(db, this.id, "stress", async () => {
        const c = await this.syncConnectStress(db, client, dates);
        return { recordCount: c, result: c };
      });
      recordsSynced += count;
    } catch (err) {
      errors.push({
        message: `Stress sync failed: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // Sync heart rate time-series (day-by-day)
    try {
      const count = await withSyncLog(db, this.id, "heart_rate", async () => {
        const c = await this.syncConnectHeartRate(db, client, dates);
        return { recordCount: c, result: c };
      });
      recordsSynced += count;
    } catch (err) {
      errors.push({
        message: `Heart rate sync failed: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    return recordsSynced;
  }

  // ============================================================
  // Connect API sync methods
  // ============================================================

  private async syncConnectActivities(db: Database, client: GarminConnectClient): Promise<number> {
    // Fetch recent activities (paginated, most recent first)
    const activities = await client.getActivities(0, 50);
    let count = 0;

    for (const raw of activities) {
      const parsed = parseConnectActivity(raw);

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

      // Sync activity detail streams
      try {
        const detail = await client.getActivityDetail(raw.activityId);
        const stream = parseActivityDetail(detail);

        for (const sample of stream.samples) {
          const timestamp = sample.directTimestamp;
          if (timestamp === null || timestamp === undefined) continue;

          // Look up the activity UUID for the FK reference
          const activityRows = await db
            .select({ id: activity.id })
            .from(activity)
            .where(
              and(eq(activity.providerId, this.id), eq(activity.externalId, parsed.externalId)),
            )
            .limit(1);

          const activityUuid = activityRows[0]?.id;

          await db
            .insert(metricStream)
            .values({
              recordedAt: new Date(timestamp),
              providerId: this.id,
              activityId: activityUuid,
              heartRate: sample.directHeartRate !== null ? sample.directHeartRate : undefined,
              power: sample.directPower !== null ? sample.directPower : undefined,
              cadence:
                sample.directRunCadence !== null
                  ? sample.directRunCadence
                  : sample.directBikeCadence !== null
                    ? sample.directBikeCadence
                    : undefined,
              speed: sample.directSpeed !== null ? sample.directSpeed : undefined,
              altitude: sample.directElevation !== null ? sample.directElevation : undefined,
              lat: sample.directLatitude !== null ? sample.directLatitude : undefined,
              lng: sample.directLongitude !== null ? sample.directLongitude : undefined,
              distance: sample.directMovingDistance ?? sample.sumDistance ?? undefined,
              temperature:
                sample.directAirTemperature !== null ? sample.directAirTemperature : undefined,
            })
            .onConflictDoNothing();
        }
      } catch {
        // Activity detail may not be available for all activities (manual entries, etc.)
      }

      count++;
    }

    return count;
  }

  private async syncConnectSleep(
    db: Database,
    client: GarminConnectClient,
    dates: string[],
  ): Promise<number> {
    let count = 0;

    for (const date of dates) {
      try {
        const raw = await client.getSleepData(date);
        const parsed = parseConnectSleep(raw);
        if (!parsed) continue;

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
      } catch {
        // No sleep data for this date
      }
    }

    return count;
  }

  private async syncConnectDailyMetrics(
    db: Database,
    client: GarminConnectClient,
    dates: string[],
  ): Promise<number> {
    let count = 0;

    for (const date of dates) {
      try {
        const raw = await client.getDailySummary(date);
        if (raw.privacyProtected) continue;

        const parsed = parseConnectDailySummary(raw);

        // Also fetch training status and HRV for enrichment
        let hrv: number | undefined;
        let vo2max: number | undefined;

        try {
          const hrvData = await client.getHrvSummary(date);
          const parsedHrv = parseHrvSummary(hrvData);
          hrv = parsedHrv.lastNightAvg ?? parsedHrv.lastNight;
        } catch {
          // HRV not available for this date
        }

        try {
          const trainingData = await client.getTrainingStatus(date);
          const parsedTraining = parseTrainingStatus(trainingData, date);
          vo2max = parsedTraining.vo2MaxRunning ?? parsedTraining.vo2MaxCycling;
        } catch {
          // Training status not available
        }

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
            hrv,
            vo2max,
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
              hrv,
              vo2max,
            },
          });

        count++;
      } catch {
        // No daily summary for this date
      }
    }

    return count;
  }

  private async syncConnectStress(
    db: Database,
    client: GarminConnectClient,
    dates: string[],
  ): Promise<number> {
    let count = 0;

    for (const date of dates) {
      try {
        const raw = await client.getDailyStress(date);
        const parsed = parseStressTimeSeries(raw);

        for (const sample of parsed.samples) {
          await db
            .insert(metricStream)
            .values({
              recordedAt: sample.timestamp,
              providerId: this.id,
              stress: sample.stressLevel,
            })
            .onConflictDoNothing();

          count++;
        }
      } catch {
        // No stress data for this date
      }
    }

    return count;
  }

  private async syncConnectHeartRate(
    db: Database,
    client: GarminConnectClient,
    dates: string[],
  ): Promise<number> {
    let count = 0;

    for (const date of dates) {
      try {
        const raw = await client.getDailyHeartRate(date);
        const parsed = parseHeartRateTimeSeries(raw);

        for (const sample of parsed.samples) {
          await db
            .insert(metricStream)
            .values({
              recordedAt: sample.timestamp,
              providerId: this.id,
              heartRate: sample.heartRate,
            })
            .onConflictDoNothing();

          count++;
        }
      } catch {
        // No heart rate data for this date
      }
    }

    return count;
  }

  // ============================================================
  // Official API sync methods (unchanged)
  // ============================================================

  private async syncOfficialActivities(
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

  private async syncOfficialSleep(
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

  private async syncOfficialDailyMetrics(
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

  private async syncOfficialBodyComposition(
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
