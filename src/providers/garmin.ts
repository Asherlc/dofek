import { isIndoorCycling } from "@dofek/training/endurance-types";
import { and, eq } from "drizzle-orm";
import {
  GarminConnectClient,
  type GarminTokens,
  parseActivityDetail,
  parseConnectActivity,
  parseConnectDailySummary,
  parseConnectSleep,
  parseConnectSleepStages,
  parseHeartRateTimeSeries,
  parseHrvSummary,
  parseStressTimeSeries,
  parseTrainingStatus,
} from "garmin-connect";
import { z } from "zod";
import type { TokenSet } from "../auth/oauth.ts";
import type { SyncDatabase } from "../db/index.ts";
import {
  activity,
  DEFAULT_USER_ID,
  dailyMetrics,
  metricStream,
  sleepSession,
  sleepStage,
  userSettings,
} from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import { logger } from "../logger.ts";
import type {
  ProviderAuthSetup,
  SyncError,
  SyncOptions,
  SyncProvider,
  SyncResult,
} from "./types.ts";

// ============================================================
// Internal token serialization
// ============================================================

export const INTERNAL_SCOPE_MARKER = "garmin-connect-internal";

export function serializeInternalTokens(tokens: GarminTokens): TokenSet {
  return {
    accessToken: JSON.stringify(tokens),
    refreshToken: null,
    expiresAt: new Date(tokens.oauth2.expires_at * 1000),
    scopes: INTERNAL_SCOPE_MARKER,
  };
}

const garminTokensSchema = z.object({
  oauth1: z.object({
    oauth_token: z.string(),
    oauth_token_secret: z.string(),
    mfa_token: z.string().optional(),
    mfa_expiration_timestamp: z.string().optional(),
  }),
  oauth2: z.object({
    scope: z.string(),
    jti: z.string(),
    token_type: z.string(),
    access_token: z.string(),
    refresh_token: z.string(),
    expires_in: z.number(),
    expires_at: z.number(),
    refresh_token_expires_in: z.number(),
    refresh_token_expires_at: z.number(),
  }),
});

export function deserializeInternalTokens(stored: TokenSet): GarminTokens | null {
  try {
    const parsed: unknown = JSON.parse(stored.accessToken);
    const result = garminTokensSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

// ============================================================
// Date helpers for internal API (day-by-day iteration)
// ============================================================

export function formatDate(d: Date): string {
  return d.toISOString().split("T")[0] ?? "";
}

export function eachDay(since: Date, until: Date): string[] {
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

async function loadSyncCursor(db: SyncDatabase): Promise<string | null> {
  const rows = await db
    .select({ value: userSettings.value })
    .from(userSettings)
    .where(and(eq(userSettings.userId, DEFAULT_USER_ID), eq(userSettings.key, SYNC_CURSOR_KEY)))
    .limit(1);

  if (rows.length === 0 || !rows[0]) return null;
  const cursorSchema = z.object({ cursor: z.string().optional() }).catch({ cursor: undefined });
  const value = cursorSchema.parse(rows[0].value);
  return value.cursor ?? null;
}

async function saveSyncCursor(db: SyncDatabase, cursor: string): Promise<void> {
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

export class GarminProvider implements SyncProvider {
  readonly id = "garmin";
  readonly name = "Garmin Connect";
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = fetchFn;
  }

  validate(): string | null {
    return null;
  }

  activityUrl(externalId: string): string {
    return `https://connect.garmin.com/modern/activity/${externalId}`;
  }

  authSetup(): ProviderAuthSetup {
    const dummyConfig = {
      clientId: "garmin-connect-internal",
      authorizeUrl: "",
      tokenUrl: "",
      redirectUri: "",
      scopes: [],
    };

    return {
      oauthConfig: dummyConfig,
      exchangeCode: async () => {
        throw new Error("Garmin uses credential-based sign-in, not OAuth code exchange");
      },
      automatedLogin: async (email: string, password: string): Promise<TokenSet> => {
        const { tokens } = await GarminConnectClient.signIn(
          email,
          password,
          "garmin.com",
          this.#fetchFn,
        );
        return serializeInternalTokens(tokens);
      },
    };
  }

  async #resolveTokens(db: SyncDatabase): Promise<GarminTokens> {
    const tokens = await loadTokens(db, this.id);
    if (!tokens) {
      throw new Error("No OAuth tokens found for Garmin. Sign in via the dashboard first.");
    }

    const internalTokens = deserializeInternalTokens(tokens);
    if (!internalTokens) {
      throw new Error(
        "Stored Garmin tokens are not in the expected format. Please sign in again via the dashboard.",
      );
    }

    if (tokens.expiresAt > new Date()) {
      return internalTokens;
    }

    // Refresh via OAuth1→OAuth2 exchange
    logger.info("[garmin] Internal API token expired, refreshing via OAuth1 exchange...");
    const client = await GarminConnectClient.fromTokens(
      internalTokens,
      "garmin.com",
      this.#fetchFn,
    );
    const refreshed = client.getTokens();
    if (!refreshed) throw new Error("Failed to refresh Garmin Connect tokens");
    await saveTokens(db, this.id, serializeInternalTokens(refreshed));
    return refreshed;
  }

  async sync(db: SyncDatabase, since: Date, options?: SyncOptions): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];

    let internalTokens: GarminTokens;
    try {
      internalTokens = await this.#resolveTokens(db);
    } catch (err) {
      return {
        provider: this.id,
        recordsSynced: 0,
        errors: [{ message: err instanceof Error ? err.message : String(err), cause: err }],
        duration: Date.now() - start,
      };
    }

    await ensureProvider(db, this.id, this.name);

    // Use sync cursor if available, otherwise fall back to `since` param
    const cursor = await loadSyncCursor(db);
    const effectiveSince = cursor ? new Date(cursor) : since;
    const now = new Date();

    const recordsSynced = await this.#syncViaConnectApi(
      db,
      internalTokens,
      effectiveSince,
      now,
      errors,
      options?.userId,
    );

    // Save sync cursor
    await saveSyncCursor(db, now.toISOString());

    return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
  }

  // ============================================================
  // Internal Connect API sync
  // ============================================================

  async #syncViaConnectApi(
    db: SyncDatabase,
    tokens: GarminTokens,
    since: Date,
    until: Date,
    errors: SyncError[],
    userId?: string,
  ): Promise<number> {
    let client: GarminConnectClient;
    try {
      client = await GarminConnectClient.fromTokens(tokens, "garmin.com", this.#fetchFn);
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
      const count = await withSyncLog(
        db,
        this.id,
        "activities",
        async () => {
          const activitiesCount = await this.#syncConnectActivities(db, client);
          return { recordCount: activitiesCount, result: activitiesCount };
        },
        userId,
      );
      recordsSynced += count;
    } catch (err) {
      errors.push({
        message: `Activities sync failed: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // Sync sleep (day-by-day)
    try {
      const count = await withSyncLog(
        db,
        this.id,
        "sleep",
        async () => {
          const sleepCount = await this.#syncConnectSleep(db, client, dates);
          return { recordCount: sleepCount, result: sleepCount };
        },
        userId,
      );
      recordsSynced += count;
    } catch (err) {
      errors.push({
        message: `Sleep sync failed: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // Sync daily metrics with training data (day-by-day)
    try {
      const count = await withSyncLog(
        db,
        this.id,
        "daily_metrics",
        async () => {
          const dailyMetricsCount = await this.#syncConnectDailyMetrics(db, client, dates);
          return { recordCount: dailyMetricsCount, result: dailyMetricsCount };
        },
        userId,
      );
      recordsSynced += count;
    } catch (err) {
      errors.push({
        message: `Daily metrics sync failed: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // Sync stress time-series (day-by-day)
    try {
      const count = await withSyncLog(
        db,
        this.id,
        "stress",
        async () => {
          const stressCount = await this.#syncConnectStress(db, client, dates);
          return { recordCount: stressCount, result: stressCount };
        },
        userId,
      );
      recordsSynced += count;
    } catch (err) {
      errors.push({
        message: `Stress sync failed: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // Sync heart rate time-series (day-by-day)
    try {
      const count = await withSyncLog(
        db,
        this.id,
        "heart_rate",
        async () => {
          const heartRateCount = await this.#syncConnectHeartRate(db, client, dates);
          return { recordCount: heartRateCount, result: heartRateCount };
        },
        userId,
      );
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

  async #syncConnectActivities(db: SyncDatabase, client: GarminConnectClient): Promise<number> {
    // Fetch recent activities (paginated, most recent first)
    const activities = await client.getActivities(0, 50);
    let count = 0;

    for (const raw of activities) {
      const parsed = parseConnectActivity(raw);

      const connectDeviceName = raw.deviceName ?? null;

      await db
        .insert(activity)
        .values({
          providerId: this.id,
          externalId: parsed.externalId,
          activityType: parsed.activityType,
          startedAt: parsed.startedAt,
          endedAt: parsed.endedAt,
          name: parsed.name,
          sourceName: connectDeviceName,
          raw: parsed.raw,
        })
        .onConflictDoUpdate({
          target: [activity.providerId, activity.externalId],
          set: {
            activityType: parsed.activityType,
            startedAt: parsed.startedAt,
            endedAt: parsed.endedAt,
            name: parsed.name,
            sourceName: connectDeviceName,
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
              speed: isIndoorCycling(parsed.activityType)
                ? undefined
                : sample.directSpeed !== null
                  ? sample.directSpeed
                  : undefined,
              altitude: sample.directElevation !== null ? sample.directElevation : undefined,
              lat: sample.directLatitude !== null ? sample.directLatitude : undefined,
              lng: sample.directLongitude !== null ? sample.directLongitude : undefined,
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

  async #syncConnectSleep(
    db: SyncDatabase,
    client: GarminConnectClient,
    dates: string[],
  ): Promise<number> {
    let count = 0;

    for (const date of dates) {
      try {
        const raw = await client.getSleepData(date);
        const parsed = parseConnectSleep(raw);
        if (!parsed) continue;

        const [session] = await db
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
          })
          .returning({ id: sleepSession.id });

        const stages = parseConnectSleepStages(raw);
        if (session && stages.length > 0) {
          // Delete existing stages for this session (re-sync)
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
      } catch {
        // No sleep data for this date
      }
    }

    return count;
  }

  async #syncConnectDailyMetrics(
    db: SyncDatabase,
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
            target: [dailyMetrics.date, dailyMetrics.providerId, dailyMetrics.sourceName],
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

  async #syncConnectStress(
    db: SyncDatabase,
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

  async #syncConnectHeartRate(
    db: SyncDatabase,
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
}
