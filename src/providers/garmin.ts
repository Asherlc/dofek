import { isIndoorCycling } from "@dofek/training/endurance-types";
import { captureException } from "@sentry/node";
import { and, eq } from "drizzle-orm";
import { GarminApiError, GarminConnectClient } from "garmin-connect/client";
import {
  parseActivityDetail,
  parseConnectActivity,
  parseConnectDailySummary,
  parseConnectSleep,
  parseConnectSleepStages,
  parseHeartRateTimeSeries,
  parseHrvSummary,
  parseStressTimeSeries,
} from "garmin-connect/parsing";
import type { GarminTokens } from "garmin-connect/types";
import { z } from "zod";
import type { TokenSet } from "../auth/oauth.ts";
import type { SyncDatabase } from "../db/index.ts";
import { writeMetricStreamBatch } from "../db/metric-stream-writer.ts";
import { activity, dailyMetrics, sleepSession, sleepStage, userSettings } from "../db/schema.ts";
import { SOURCE_TYPE_API } from "../db/sensor-channels.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { getTokenUserId } from "../db/token-user-context.ts";
import { ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import { isRetryableInfraError } from "../lib/retryable-infra-error.ts";
import { logger } from "../logger.ts";
import type {
  ProviderAuthSetup,
  SyncCheckpointStore,
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

const garminSyncPhaseSchema = z.enum([
  "activities",
  "sleep",
  "daily_metrics",
  "stress",
  "heart_rate",
  "complete",
]);
type GarminSyncPhase = z.infer<typeof garminSyncPhaseSchema>;

const GARMIN_SYNC_PHASES: GarminSyncPhase[] = [
  "activities",
  "sleep",
  "daily_metrics",
  "stress",
  "heart_rate",
  "complete",
];

const garminSyncCheckpointSchema = z.object({
  phase: garminSyncPhaseSchema,
  nextDate: z.string().optional(),
});
type GarminSyncCheckpoint = z.infer<typeof garminSyncCheckpointSchema>;

function resolveScopedUserId(userId?: string): string {
  const scopedUserId = userId ?? getTokenUserId();
  if (!scopedUserId) {
    throw new Error("garmin sync requires a userId");
  }
  return scopedUserId;
}

async function loadSyncCursor(db: SyncDatabase, userId?: string): Promise<string | null> {
  const scopedUserId = resolveScopedUserId(userId);
  const rows = await db
    .select({ value: userSettings.value })
    .from(userSettings)
    .where(and(eq(userSettings.userId, scopedUserId), eq(userSettings.key, SYNC_CURSOR_KEY)))
    .limit(1);

  if (rows.length === 0 || !rows[0]) return null;
  const cursorSchema = z.object({ cursor: z.string().optional() }).catch({ cursor: undefined });
  const value = cursorSchema.parse(rows[0].value);
  return value.cursor ?? null;
}

async function saveSyncCursor(db: SyncDatabase, cursor: string, userId?: string): Promise<void> {
  const scopedUserId = resolveScopedUserId(userId);
  await db
    .insert(userSettings)
    .values({
      userId: scopedUserId,
      key: SYNC_CURSOR_KEY,
      value: { cursor },
    })
    .onConflictDoUpdate({
      target: [userSettings.userId, userSettings.key],
      set: { value: { cursor }, updatedAt: new Date() },
    });
}

async function loadGarminSyncCheckpoint(
  checkpointStore?: SyncCheckpointStore,
): Promise<GarminSyncCheckpoint> {
  if (!checkpointStore) return { phase: "activities" };
  const rawCheckpoint = await checkpointStore.load();
  const result = garminSyncCheckpointSchema.safeParse(rawCheckpoint);
  return result.success ? result.data : { phase: "activities" };
}

function shouldSyncPhase(checkpoint: GarminSyncCheckpoint, phase: GarminSyncPhase): boolean {
  if (checkpoint.phase === "complete") return false;
  return GARMIN_SYNC_PHASES.indexOf(phase) >= GARMIN_SYNC_PHASES.indexOf(checkpoint.phase);
}

function datesForPhase(
  dates: string[],
  checkpoint: GarminSyncCheckpoint,
  phase: GarminSyncPhase,
): string[] {
  const nextDate = checkpoint.nextDate;
  if (checkpoint.phase !== phase || !nextDate) return dates;
  const resumeIndex = dates.findIndex((date) => date >= nextDate);
  return resumeIndex === -1 ? [] : dates.slice(resumeIndex);
}

function checkpointForNextPhase(phase: GarminSyncPhase, firstDate?: string): GarminSyncCheckpoint {
  const nextPhase = GARMIN_SYNC_PHASES[GARMIN_SYNC_PHASES.indexOf(phase) + 1] ?? "complete";
  return firstDate ? { phase: nextPhase, nextDate: firstDate } : { phase: nextPhase };
}

async function saveGarminCheckpoint(
  checkpointStore: SyncCheckpointStore | undefined,
  checkpoint: GarminSyncCheckpoint,
): Promise<void> {
  await checkpointStore?.save(checkpoint);
}

async function saveNextDateCheckpoint(
  checkpointStore: SyncCheckpointStore | undefined,
  phase: GarminSyncPhase,
  dates: string[],
  date: string,
): Promise<void> {
  const dateIndex = dates.indexOf(date);
  const nextDate = dateIndex >= 0 ? dates[dateIndex + 1] : undefined;
  await saveGarminCheckpoint(
    checkpointStore,
    nextDate ? { phase, nextDate } : checkpointForNextPhase(phase, dates[0]),
  );
}

// ============================================================
// Error helpers
// ============================================================

/** Returns true for "no data available" (204) responses, which are expected for some dates. */
function isNoDataError(error: unknown): boolean {
  return error instanceof GarminApiError && error.statusCode === 204;
}

/**
 * Tracks unexpected errors within a sync operation (e.g., "sleep", "stress").
 * Reports only the first error to Sentry to avoid noise when Garmin is down,
 * and collects all errors for a summary message.
 */
class SyncErrorTracker {
  readonly operation: string;
  readonly errors: Array<{ context: string; error: unknown }> = [];
  #sentryReported = false;

  constructor(operation: string) {
    this.operation = operation;
  }

  /** Record an error. Only the first error per operation is sent to Sentry. */
  record(context: string, error: unknown): void {
    if (isRetryableInfraError(error)) throw error;
    if (isNoDataError(error)) return;

    this.errors.push({ context, error });
    logger.warn(`[garmin] ${this.operation} failed for ${context}: ${error}`);

    if (!this.#sentryReported) {
      captureException(error, {
        tags: { provider: "garmin", operation: this.operation },
        extra: { context },
      });
      this.#sentryReported = true;
    }
  }

  get hasErrors(): boolean {
    return this.errors.length > 0;
  }

  /** Throws a summary error if any unexpected errors were recorded. */
  throwIfErrors(): void {
    if (!this.hasErrors) return;
    const count = this.errors.length;
    const firstContext = this.errors[0]?.context ?? "unknown";
    const firstMessage =
      this.errors[0]?.error instanceof Error
        ? this.errors[0].error.message
        : String(this.errors[0]?.error);
    throw new Error(
      `${this.operation}: ${count} error(s), first at ${firstContext}: ${firstMessage}`,
    );
  }
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

  authSetup(_options?: { host?: string }): ProviderAuthSetup {
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

  async #resolveTokens(db: SyncDatabase, userId?: string): Promise<GarminTokens> {
    const scopedUserId = resolveScopedUserId(userId);
    const tokens = await loadTokens(db, this.id, scopedUserId);
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
    await saveTokens(db, this.id, serializeInternalTokens(refreshed), scopedUserId);
    return refreshed;
  }

  async sync(db: SyncDatabase, since: Date, options?: SyncOptions): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];

    const scopedUserId = resolveScopedUserId(options?.userId);

    let internalTokens: GarminTokens;
    try {
      internalTokens = await this.#resolveTokens(db, scopedUserId);
    } catch (err) {
      if (isRetryableInfraError(err)) throw err;
      return {
        provider: this.id,
        recordsSynced: 0,
        errors: [{ message: err instanceof Error ? err.message : String(err), cause: err }],
        duration: Date.now() - start,
      };
    }

    await ensureProvider(db, this.id, this.name);

    // Use sync cursor if available, otherwise fall back to `since` param
    const cursor = await loadSyncCursor(db, scopedUserId);
    const effectiveSince = cursor ? new Date(cursor) : since;
    const now = new Date();
    const checkpoint = await loadGarminSyncCheckpoint(options?.checkpoint);

    const recordsSynced = await this.#syncViaConnectApi(
      db,
      internalTokens,
      effectiveSince,
      now,
      errors,
      scopedUserId,
      checkpoint,
      options?.checkpoint,
    );

    // Save sync cursor
    await saveSyncCursor(db, now.toISOString(), scopedUserId);
    await options?.checkpoint?.clear();

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
    checkpoint: GarminSyncCheckpoint = { phase: "activities" },
    checkpointStore?: SyncCheckpointStore,
  ): Promise<number> {
    const scopedUserId = resolveScopedUserId(userId);
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
      await saveTokens(db, this.id, serializeInternalTokens(refreshedTokens), scopedUserId);
    }

    const dates = eachDay(since, until);
    let recordsSynced = 0;

    // Sync activities (paginated)
    if (shouldSyncPhase(checkpoint, "activities")) {
      try {
        const count = await withSyncLog(
          db,
          this.id,
          "activities",
          async () => {
            const activitiesCount = await this.#syncConnectActivities(db, client, scopedUserId);
            return { recordCount: activitiesCount, result: activitiesCount };
          },
          scopedUserId,
        );
        recordsSynced += count;
        await saveGarminCheckpoint(checkpointStore, checkpointForNextPhase("activities", dates[0]));
      } catch (err) {
        if (isRetryableInfraError(err)) throw err;
        errors.push({
          message: `Activities sync failed: ${err instanceof Error ? err.message : String(err)}`,
          cause: err,
        });
      }
    }

    // Sync sleep (day-by-day)
    if (shouldSyncPhase(checkpoint, "sleep")) {
      try {
        const count = await withSyncLog(
          db,
          this.id,
          "sleep",
          async () => {
            const sleepCount = await this.#syncConnectSleep(
              db,
              client,
              datesForPhase(dates, checkpoint, "sleep"),
              checkpointStore,
            );
            return { recordCount: sleepCount, result: sleepCount };
          },
          scopedUserId,
        );
        recordsSynced += count;
        await saveGarminCheckpoint(checkpointStore, checkpointForNextPhase("sleep", dates[0]));
      } catch (err) {
        if (isRetryableInfraError(err)) throw err;
        errors.push({
          message: `Sleep sync failed: ${err instanceof Error ? err.message : String(err)}`,
          cause: err,
        });
      }
    }

    // Sync daily metrics with training data (day-by-day)
    if (shouldSyncPhase(checkpoint, "daily_metrics")) {
      try {
        const count = await withSyncLog(
          db,
          this.id,
          "daily_metrics",
          async () => {
            const dailyMetricsCount = await this.#syncConnectDailyMetrics(
              db,
              client,
              datesForPhase(dates, checkpoint, "daily_metrics"),
              checkpointStore,
            );
            return { recordCount: dailyMetricsCount, result: dailyMetricsCount };
          },
          scopedUserId,
        );
        recordsSynced += count;
        await saveGarminCheckpoint(
          checkpointStore,
          checkpointForNextPhase("daily_metrics", dates[0]),
        );
      } catch (err) {
        if (isRetryableInfraError(err)) throw err;
        errors.push({
          message: `Daily metrics sync failed: ${err instanceof Error ? err.message : String(err)}`,
          cause: err,
        });
      }
    }

    // Sync stress time-series (day-by-day)
    if (shouldSyncPhase(checkpoint, "stress")) {
      try {
        const count = await withSyncLog(
          db,
          this.id,
          "stress",
          async () => {
            const stressCount = await this.#syncConnectStress(
              db,
              client,
              datesForPhase(dates, checkpoint, "stress"),
              checkpointStore,
            );
            return { recordCount: stressCount, result: stressCount };
          },
          scopedUserId,
        );
        recordsSynced += count;
        await saveGarminCheckpoint(checkpointStore, checkpointForNextPhase("stress", dates[0]));
      } catch (err) {
        if (isRetryableInfraError(err)) throw err;
        errors.push({
          message: `Stress sync failed: ${err instanceof Error ? err.message : String(err)}`,
          cause: err,
        });
      }
    }

    // Sync heart rate time-series (day-by-day)
    if (shouldSyncPhase(checkpoint, "heart_rate")) {
      try {
        const count = await withSyncLog(
          db,
          this.id,
          "heart_rate",
          async () => {
            const heartRateCount = await this.#syncConnectHeartRate(
              db,
              client,
              datesForPhase(dates, checkpoint, "heart_rate"),
              checkpointStore,
            );
            return { recordCount: heartRateCount, result: heartRateCount };
          },
          scopedUserId,
        );
        recordsSynced += count;
        await saveGarminCheckpoint(checkpointStore, { phase: "complete" });
      } catch (err) {
        if (isRetryableInfraError(err)) throw err;
        errors.push({
          message: `Heart rate sync failed: ${err instanceof Error ? err.message : String(err)}`,
          cause: err,
        });
      }
    }

    return recordsSynced;
  }

  // ============================================================
  // Connect API sync methods
  // ============================================================

  async #syncConnectActivities(
    db: SyncDatabase,
    client: GarminConnectClient,
    userId: string,
  ): Promise<number> {
    // Fetch recent activities (paginated, most recent first)
    const activities = await client.getActivities(0, 50);
    let count = 0;
    const detailErrors = new SyncErrorTracker("activity_detail");

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
          target: [activity.userId, activity.providerId, activity.externalId],
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
              and(
                eq(activity.userId, userId),
                eq(activity.providerId, this.id),
                eq(activity.externalId, parsed.externalId),
              ),
            )
            .limit(1);

          const activityUuid = activityRows[0]?.id;

          const metricRow = {
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
          };
          await writeMetricStreamBatch(db, [metricRow], SOURCE_TYPE_API);
        }
      } catch (error) {
        // Activity detail is non-critical — don't fail the sync, but track errors
        detailErrors.record(String(raw.activityId), error);
      }

      count++;
    }

    // Don't throw for detail errors — activity metadata is still synced
    return count;
  }

  async #syncConnectSleep(
    db: SyncDatabase,
    client: GarminConnectClient,
    dates: string[],
    checkpointStore?: SyncCheckpointStore,
  ): Promise<number> {
    let count = 0;
    const tracker = new SyncErrorTracker("sleep");

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
            target: [sleepSession.userId, sleepSession.providerId, sleepSession.externalId],
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
      } catch (error) {
        tracker.record(date, error);
      }
      await saveNextDateCheckpoint(checkpointStore, "sleep", dates, date);
    }

    tracker.throwIfErrors();

    return count;
  }

  async #syncConnectDailyMetrics(
    db: SyncDatabase,
    client: GarminConnectClient,
    dates: string[],
    checkpointStore?: SyncCheckpointStore,
  ): Promise<number> {
    let count = 0;
    const tracker = new SyncErrorTracker("daily_metrics");
    // HRV is enrichment — track separately but don't fail the sync.
    const hrvTracker = new SyncErrorTracker("hrv");

    for (const date of dates) {
      try {
        const raw = await client.getDailySummary(date);
        if (raw.privacyProtected) continue;

        const parsed = parseConnectDailySummary(raw);

        // Also fetch training status and HRV for enrichment
        let hrv: number | undefined;
        try {
          const hrvData = await client.getHrvSummary(date);
          const parsedHrv = parseHrvSummary(hrvData);
          hrv = parsedHrv.lastNightAvg ?? parsedHrv.lastNight;
        } catch (error) {
          hrvTracker.record(date, error);
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
            spo2Avg: parsed.spo2Avg,
            respiratoryRateAvg: parsed.respiratoryRateAvg,
            flightsClimbed: parsed.flightsClimbed,
            exerciseMinutes: parsed.exerciseMinutes,
            hrv,
          })
          .onConflictDoUpdate({
            target: [
              dailyMetrics.userId,
              dailyMetrics.date,
              dailyMetrics.providerId,
              dailyMetrics.sourceName,
            ],
            set: {
              steps: parsed.steps,
              distanceKm: parsed.distanceKm,
              activeEnergyKcal: parsed.activeEnergyKcal,
              basalEnergyKcal: parsed.basalEnergyKcal,
              spo2Avg: parsed.spo2Avg,
              respiratoryRateAvg: parsed.respiratoryRateAvg,
              flightsClimbed: parsed.flightsClimbed,
              exerciseMinutes: parsed.exerciseMinutes,
              hrv,
            },
          });

        count++;
      } catch (error) {
        tracker.record(date, error);
      }
      await saveNextDateCheckpoint(checkpointStore, "daily_metrics", dates, date);
    }

    tracker.throwIfErrors();
    return count;
  }

  async #syncConnectStress(
    db: SyncDatabase,
    client: GarminConnectClient,
    dates: string[],
    checkpointStore?: SyncCheckpointStore,
  ): Promise<number> {
    let count = 0;
    const tracker = new SyncErrorTracker("stress");

    for (const date of dates) {
      try {
        const raw = await client.getDailyStress(date);
        const parsed = parseStressTimeSeries(raw);

        const stressRows = parsed.samples.map((sample) => ({
          recordedAt: sample.timestamp,
          providerId: this.id,
          stress: sample.stressLevel,
        }));
        await writeMetricStreamBatch(db, stressRows, SOURCE_TYPE_API);

        count += stressRows.length;
      } catch (error) {
        tracker.record(date, error);
      }
      await saveNextDateCheckpoint(checkpointStore, "stress", dates, date);
    }

    tracker.throwIfErrors();
    return count;
  }

  async #syncConnectHeartRate(
    db: SyncDatabase,
    client: GarminConnectClient,
    dates: string[],
    checkpointStore?: SyncCheckpointStore,
  ): Promise<number> {
    let count = 0;
    const tracker = new SyncErrorTracker("heart_rate");

    for (const date of dates) {
      try {
        const raw = await client.getDailyHeartRate(date);
        const parsed = parseHeartRateTimeSeries(raw);

        const hrRows = parsed.samples.map((sample) => ({
          recordedAt: sample.timestamp,
          providerId: this.id,
          heartRate: sample.heartRate,
        }));
        await writeMetricStreamBatch(db, hrRows, SOURCE_TYPE_API);

        count += hrRows.length;
      } catch (error) {
        tracker.record(date, error);
      }
      await saveNextDateCheckpoint(checkpointStore, "heart_rate", dates, date);
    }

    tracker.throwIfErrors();

    return count;
  }
}
