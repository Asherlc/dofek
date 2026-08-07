import { eq } from "drizzle-orm";
import type { TokenSet } from "../../auth/oauth.ts";
import { refreshAccessToken } from "../../auth/oauth.ts";
import type { SyncDatabase } from "../../db/index.ts";
import { replaceMetricStreamBatch } from "../../db/metric-stream-writer.ts";
import {
  finishProviderActivityListSync,
  upsertProviderActivity,
} from "../../db/provider-activity-sync.ts";
import { dailyMetrics, sleepSession, sleepStage } from "../../db/schema/activity.ts";
import { SOURCE_TYPE_API } from "../../db/sensor-channels.ts";
import { withSyncLog } from "../../db/sync-log.ts";
import { deleteTokens, ensureProvider, loadTokens, saveTokens } from "../../db/tokens.ts";
import { logger } from "../../logger.ts";
import type { MetricStreamEventPublisher } from "../../metric-stream/redpanda-producer.ts";
import { parseTcx, tcxToSensorSamples } from "../../tcx/parser.ts";
import {
  authFailureReasonFromError,
  ProviderAuthorizationFailedError,
  RefreshTokenRevokedError,
} from "../auth-errors.ts";
import type { SyncWindow } from "../sync-window.ts";
import type { SyncError } from "../types.ts";
import { PolarClient, PolarNotFoundError, PolarUnauthorizedError } from "./client.ts";
import { POLAR_API_BASE, polarOAuthConfig } from "./oauth.ts";
import {
  parsePolarDailyActivity,
  parsePolarExercise,
  parsePolarSleep,
  parsePolarSleepStages,
} from "./parsers.ts";
import type { PolarNightlyRecharge } from "./types.ts";

interface PolarSyncServiceOptions {
  db: SyncDatabase;
  providerId: string;
  providerName: string;
  fetchFn: typeof globalThis.fetch;
  userId?: string;
  metricStreamPublisher?: MetricStreamEventPublisher;
}

export interface PolarSyncAccumulator {
  recordsSynced: number;
  errors: SyncError[];
}

export class PolarSyncService {
  readonly #db: SyncDatabase;
  readonly #providerId: string;
  readonly #providerName: string;
  readonly #fetchFn: typeof globalThis.fetch;
  readonly #userId?: string;
  readonly #metricStreamPublisher?: MetricStreamEventPublisher;
  readonly #errors: SyncError[] = [];
  #recordsSynced = 0;

  constructor(options: PolarSyncServiceOptions) {
    this.#db = options.db;
    this.#providerId = options.providerId;
    this.#providerName = options.providerName;
    this.#fetchFn = options.fetchFn;
    this.#userId = options.userId;
    this.#metricStreamPublisher = options.metricStreamPublisher;
  }

  async run(window: SyncWindow): Promise<PolarSyncAccumulator> {
    await ensureProvider(this.#db, this.#providerId, this.#providerName, POLAR_API_BASE);

    let tokens: TokenSet;
    try {
      tokens = await this.#resolveTokens();
    } catch (error) {
      this.#errors.push({
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });
      return this.#result();
    }

    const client = new PolarClient(tokens.accessToken, this.#fetchFn);

    await this.#syncExercises(client, window);
    if (await this.#invalidateTokensIfAuthFailed()) return this.#result();

    await this.#syncSleep(client, window);
    if (await this.#invalidateTokensIfAuthFailed()) return this.#result();

    await this.#syncDailyActivity(client, window);
    if (await this.#invalidateTokensIfAuthFailed()) return this.#result();

    return this.#result();
  }

  async #resolveTokens(): Promise<TokenSet> {
    const tokens = await loadTokens(this.#db, this.#providerId);
    if (!tokens) {
      throw new Error(
        `No OAuth tokens found for ${this.#providerName}. Run: health-data auth ${this.#providerId}`,
      );
    }

    if (tokens.expiresAt > new Date()) {
      return tokens;
    }

    // Token past stored expiry — try to refresh if we have a refresh token.
    if (tokens.refreshToken) {
      logger.info(`[${this.#providerId}] Access token expired, refreshing...`);
      const config = polarOAuthConfig();
      if (!config) {
        throw new Error(`OAuth config required to refresh ${this.#providerName} tokens`);
      }
      try {
        const refreshed = await refreshAccessToken(config, tokens.refreshToken, this.#fetchFn);
        await saveTokens(this.#db, this.#providerId, refreshed);
        return refreshed;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("invalid_grant") || message.includes("Too many unrevoked")) {
          logger.warn(
            `[${this.#providerId}] Refresh token revoked, deleting stored tokens. ` +
              `User must re-authorize ${this.#providerName}.`,
          );
          await deleteTokens(this.#db, this.#providerId);
          throw new RefreshTokenRevokedError(this.#providerName, {
            cause: error instanceof Error ? error : undefined,
          });
        }
        throw error;
      }
    }

    // Polar tokens are long-lived and may still be valid even past the stored
    // expiry (which uses a conservative 1-year default when the API omits
    // expires_in). Use the existing token and let the API call determine
    // if it's truly expired.
    logger.info(
      `[${this.#providerId}] Token past stored expiry with no refresh token — using existing token`,
    );
    return tokens;
  }

  async #syncExercises(client: PolarClient, window: SyncWindow): Promise<void> {
    const since = window.since;
    const syncWindowEnd = window.until;
    const presentActivityExternalIds = new Set<string>();
    try {
      const exerciseCount = await withSyncLog(
        this.#db,
        this.#providerId,
        "exercises",
        async () => {
          const exercises = await client.getExercises();
          let count = 0;

          for (const exercise of exercises) {
            const exerciseStart = new Date(exercise.start_time);
            if (exerciseStart < since) continue;
            if (exerciseStart > syncWindowEnd) continue;

            const parsedExercise = parsePolarExercise(exercise);
            presentActivityExternalIds.add(parsedExercise.externalId);
            try {
              const activityRow = await upsertProviderActivity(
                this.#db,
                {
                  providerId: this.#providerId,
                  externalId: parsedExercise.externalId,
                  activityType: parsedExercise.activityType,
                  name: parsedExercise.name,
                  startedAt: parsedExercise.startedAt,
                  endedAt: parsedExercise.endedAt,
                  raw: {
                    durationSeconds: parsedExercise.durationSeconds,
                    distanceMeters: parsedExercise.distanceMeters,
                    avgHeartRate: parsedExercise.avgHeartRate,
                    maxHeartRate: parsedExercise.maxHeartRate,
                  },
                },
                {
                  activityType: parsedExercise.activityType,
                  name: parsedExercise.name,
                  startedAt: parsedExercise.startedAt,
                  endedAt: parsedExercise.endedAt,
                  raw: {
                    durationSeconds: parsedExercise.durationSeconds,
                    distanceMeters: parsedExercise.distanceMeters,
                    avgHeartRate: parsedExercise.avgHeartRate,
                    maxHeartRate: parsedExercise.maxHeartRate,
                  },
                },
              );

              const activityId = activityRow?.id;
              if (activityId && exercise.has_route) {
                await this.#syncExerciseTcx(client, exercise.id, activityId);
              }

              count++;
            } catch (error) {
              this.#errors.push({
                message: `Exercise ${exercise.id}: ${error instanceof Error ? error.message : String(error)}`,
                externalId: exercise.id,
                cause: error,
              });
            }
          }

          await finishProviderActivityListSync(this.#db, {
            providerId: this.#providerId,
            userId: this.#userId,
            windowStart: since,
            windowEnd: syncWindowEnd,
            presentExternalIds: presentActivityExternalIds,
          });
          return { recordCount: count, result: count };
        },
        this.#userId,
      );

      this.#recordsSynced += exerciseCount;
    } catch (error) {
      this.#errors.push(this.#buildSectionError("exercises", error));
    }
  }

  async #syncExerciseTcx(
    client: PolarClient,
    exerciseId: string,
    activityId: string,
  ): Promise<void> {
    try {
      const tcxData = await client.downloadTcx(exerciseId);
      const trackPoints = parseTcx(tcxData);
      const sampleRows = tcxToSensorSamples(trackPoints, this.#providerId, activityId);

      if (sampleRows.length === 0) return;

      await replaceMetricStreamBatch(
        this.#db,
        { activityId },
        sampleRows,
        SOURCE_TYPE_API,
        this.#metricStreamPublisher,
      );
      logger.info(
        `[polar] Inserted ${sampleRows.length} metric stream rows for exercise ${exerciseId}`,
      );
    } catch (error) {
      this.#errors.push({
        message: `TCX for ${exerciseId}: ${error instanceof Error ? error.message : String(error)}`,
        externalId: exerciseId,
        cause: error,
      });
    }
  }

  async #syncSleep(client: PolarClient, window: SyncWindow): Promise<void> {
    const since = window.since;
    const until = window.until;
    try {
      const sleepCount = await withSyncLog(
        this.#db,
        this.#providerId,
        "sleep",
        async () => {
          const sleepRecords = await client.getSleep();
          let count = 0;

          for (const sleepRecord of sleepRecords) {
            const sleepStart = new Date(sleepRecord.sleep_start_time);
            if (sleepStart < since) continue;
            if (sleepStart > until) continue;

            const parsedSleep = parsePolarSleep(sleepRecord);
            try {
              const [sessionRow] = await this.#db
                .insert(sleepSession)
                .values({
                  providerId: this.#providerId,
                  externalId: parsedSleep.externalId,
                  startedAt: parsedSleep.startedAt,
                  endedAt: parsedSleep.endedAt,
                  durationMinutes: parsedSleep.durationMinutes,
                  lightMinutes: parsedSleep.lightMinutes,
                  deepMinutes: parsedSleep.deepMinutes,
                  remMinutes: parsedSleep.remMinutes,
                  awakeMinutes: parsedSleep.awakeMinutes,
                  stagingAvailable: parsedSleep.stagingAvailable,
                })
                .onConflictDoUpdate({
                  target: [sleepSession.userId, sleepSession.providerId, sleepSession.externalId],
                  set: {
                    startedAt: parsedSleep.startedAt,
                    endedAt: parsedSleep.endedAt,
                    durationMinutes: parsedSleep.durationMinutes,
                    lightMinutes: parsedSleep.lightMinutes,
                    deepMinutes: parsedSleep.deepMinutes,
                    remMinutes: parsedSleep.remMinutes,
                    awakeMinutes: parsedSleep.awakeMinutes,
                    stagingAvailable: parsedSleep.stagingAvailable,
                  },
                })
                .returning({ id: sleepSession.id });

              const stages = sleepRecord.hypnogram
                ? parsePolarSleepStages(sleepRecord.sleep_start_time, sleepRecord.hypnogram)
                : [];
              if (sessionRow && stages.length > 0) {
                await this.#db.delete(sleepStage).where(eq(sleepStage.sessionId, sessionRow.id));
                await this.#db.insert(sleepStage).values(
                  stages.map((stage) => ({
                    sessionId: sessionRow.id,
                    stage: stage.stage,
                    startedAt: stage.startedAt,
                    endedAt: stage.endedAt,
                  })),
                );
              }

              count++;
            } catch (error) {
              this.#errors.push({
                message: `Sleep ${sleepRecord.date}: ${error instanceof Error ? error.message : String(error)}`,
                externalId: sleepRecord.date,
                cause: error,
              });
            }
          }

          return { recordCount: count, result: count };
        },
        this.#userId,
      );

      this.#recordsSynced += sleepCount;
    } catch (error) {
      this.#errors.push(this.#buildSectionError("sleep", error));
    }
  }

  async #syncDailyActivity(client: PolarClient, window: SyncWindow): Promise<void> {
    const since = window.since;
    const until = window.until;
    try {
      const dailyCount = await withSyncLog(
        this.#db,
        this.#providerId,
        "daily_activity",
        async () => {
          const dailyActivities = await client.getDailyActivity();

          // Fetch nightly recharge independently — some devices/accounts
          // don't support it, and a failure here should not prevent daily
          // activity from syncing.
          let nightlyRecharges: PolarNightlyRecharge[] = [];
          try {
            nightlyRecharges = await client.getNightlyRecharge();
          } catch (rechargeError) {
            logger.warn(
              `[${this.#providerId}] Nightly recharge fetch failed, continuing without it: ${rechargeError instanceof Error ? rechargeError.message : String(rechargeError)}`,
            );
          }

          const rechargeByDate = this.#createRechargeIndex(nightlyRecharges);
          let count = 0;

          for (const dailyActivity of dailyActivities) {
            const activityDate = dailyActivity.start_time.slice(0, 10);
            const activityDateStart = new Date(`${activityDate}T00:00:00.000Z`);
            if (activityDateStart < since) continue;
            if (activityDateStart > until) continue;

            const recharge = rechargeByDate.get(activityDate) ?? null;
            const parsedDailyMetrics = parsePolarDailyActivity(dailyActivity, recharge);

            try {
              await this.#db
                .insert(dailyMetrics)
                .values({
                  date: parsedDailyMetrics.date,
                  providerId: this.#providerId,
                  steps: parsedDailyMetrics.steps,
                  hrv: parsedDailyMetrics.hrv,
                  respiratoryRateAvg: parsedDailyMetrics.respiratoryRateAvg,
                })
                .onConflictDoUpdate({
                  target: [
                    dailyMetrics.userId,
                    dailyMetrics.date,
                    dailyMetrics.providerId,
                    dailyMetrics.sourceName,
                  ],
                  set: {
                    steps: parsedDailyMetrics.steps,
                    hrv: parsedDailyMetrics.hrv,
                    respiratoryRateAvg: parsedDailyMetrics.respiratoryRateAvg,
                  },
                });
              count++;
            } catch (error) {
              this.#errors.push({
                message: `Daily ${parsedDailyMetrics.date}: ${error instanceof Error ? error.message : String(error)}`,
                externalId: parsedDailyMetrics.date,
                cause: error,
              });
            }
          }

          return { recordCount: count, result: count };
        },
        this.#userId,
      );

      this.#recordsSynced += dailyCount;
    } catch (error) {
      this.#errors.push(this.#buildSectionError("daily_activity", error));
    }
  }

  #createRechargeIndex(
    nightlyRecharges: PolarNightlyRecharge[],
  ): Map<string, PolarNightlyRecharge> {
    const rechargeByDate = new Map<string, PolarNightlyRecharge>();
    for (const recharge of nightlyRecharges) {
      rechargeByDate.set(recharge.date, recharge);
    }
    return rechargeByDate;
  }

  /**
   * If any accumulated error was caused by a 401/403 from Polar's API,
   * the stored token is dead. Delete it so the provider shows as
   * disconnected and the scheduler stops retrying every cycle.
   *
   * Returns true if tokens were invalidated (caller should short-circuit).
   */
  async #invalidateTokensIfAuthFailed(): Promise<boolean> {
    if (
      !this.#errors.some(
        (syncError) => authFailureReasonFromError(syncError.cause) === "authorization_failed",
      )
    ) {
      return false;
    }
    logger.warn(`[${this.#providerId}] Authorization failed; deleting stored tokens.`);
    try {
      await deleteTokens(this.#db, this.#providerId);
    } catch (deleteError) {
      this.#errors.push({
        message: `Failed to delete dead tokens: ${deleteError instanceof Error ? deleteError.message : String(deleteError)}`,
        cause: deleteError,
      });
    }
    return true;
  }

  #buildSectionError(section: "exercises" | "sleep" | "daily_activity", error: unknown): SyncError {
    if (error instanceof PolarUnauthorizedError) {
      const cause = new ProviderAuthorizationFailedError(this.#providerName, { cause: error });
      if (section === "exercises") {
        return {
          message: "Polar authorization failed while syncing exercises.",
          cause,
        };
      }
      if (section === "sleep") {
        return {
          message: "Polar authorization failed while syncing sleep.",
          cause,
        };
      }
      return {
        message: "Polar authorization failed while syncing daily activity.",
        cause,
      };
    }

    if (error instanceof PolarNotFoundError) {
      if (section === "exercises") {
        return {
          message: "Polar exercises endpoint returned 404 — try re-authenticating with Polar",
          cause: error,
        };
      }
      if (section === "sleep") {
        return {
          message: "Polar sleep endpoint returned 404 — try re-authenticating with Polar",
          cause: error,
        };
      }
      return {
        message: "Polar daily activity endpoint returned 404 — try re-authenticating with Polar",
        cause: error,
      };
    }

    return {
      message: `${section}: ${error instanceof Error ? error.message : String(error)}`,
      cause: error,
    };
  }

  #result(): PolarSyncAccumulator {
    return {
      recordsSynced: this.#recordsSynced,
      errors: this.#errors,
    };
  }
}
