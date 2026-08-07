import { EightSleepClient } from "@dofek/eight-sleep/client";
import {
  parseEightSleepDailyMetrics,
  parseEightSleepHeartRateSamples,
  parseEightSleepTrendDay,
} from "@dofek/eight-sleep/parsing";
import type { EightSleepTrendDay } from "@dofek/eight-sleep/types";
import { writeMetricStreamBatch } from "../db/metric-stream-writer.ts";
import { dailyMetrics, sleepSession } from "../db/schema/activity.ts";
import { SOURCE_TYPE_API } from "../db/sensor-channels.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens } from "../db/tokens.ts";
import { createProviderRateLimitFetch } from "../lib/provider-rate-limit-fetch.ts";
import { AccessTokenExpiredError, ProviderStoredIdentityMissingError } from "./auth-errors.ts";
import type { SyncRun } from "./sync-run.ts";
import type { ProviderAuthSetup, SyncError, SyncProvider, SyncResult } from "./types.ts";

// ============================================================
// Helper: format date as YYYY-MM-DD
// ============================================================

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ============================================================
// Provider implementation
// ============================================================

export class EightSleepProvider implements SyncProvider {
  readonly id = "eight-sleep";
  readonly name = "Eight Sleep";
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = createProviderRateLimitFetch("eight-sleep", fetchFn);
  }

  validate(): string | null {
    // Eight Sleep is always "enabled" — auth state checked at sync time via stored tokens
    return null;
  }

  authSetup(_options?: { host?: string }): ProviderAuthSetup {
    const fetchFn = this.#fetchFn;
    return {
      automatedLogin: async (email: string, password: string) => {
        const result = await EightSleepClient.signIn(email, password, fetchFn);
        return {
          accessToken: result.accessToken,
          refreshToken: null,
          expiresAt: new Date(Date.now() + result.expiresIn * 1000),
          scopes: `userId:${result.userId}`,
        };
      },
    };
  }

  async sync(run: SyncRun): Promise<SyncResult> {
    const { db, window, options } = run;
    const since = window.since;
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;
    const syncOptions = options ?? {};

    await ensureProvider(db, this.id, this.name);

    // Resolve tokens — re-authenticate if expired (no refresh tokens)
    let client: EightSleepClient;
    try {
      const stored = await loadTokens(db, this.id);
      if (!stored) {
        throw new Error("Eight Sleep not connected — authenticate via the web UI");
      }

      const userIdMatch = stored.scopes?.match(/userId:(\S+)/);
      const userId = userIdMatch?.[1];
      if (!userId) {
        throw new ProviderStoredIdentityMissingError("Eight Sleep", "user ID");
      }

      // Eight Sleep has no refresh tokens — user must re-authenticate when expired
      if (stored.expiresAt <= new Date()) {
        throw new AccessTokenExpiredError("Eight Sleep");
      }
      client = new EightSleepClient(stored.accessToken, userId, this.#fetchFn);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const sinceDate = formatDate(since);
    const toDate = formatDate(new Date());
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    // Fetch trends (sleep data)
    let trendDays: EightSleepTrendDay[] = [];
    try {
      const trends = await client.getTrends(timezone, sinceDate, toDate);
      trendDays = trends.days.filter((d) => !d.processing);
    } catch (err) {
      errors.push({
        message: `getTrends: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    // 1. Sync sleep sessions
    try {
      const sleepCount = await withSyncLog(
        db,
        this.id,
        "sleep",
        async () => {
          let count = 0;
          for (const day of trendDays) {
            if (!day.presenceStart || !day.presenceEnd) continue;
            const parsed = parseEightSleepTrendDay(day);
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
                  stagingAvailable: parsed.stagingAvailable,
                  sleepType: parsed.sleepType,
                })
                .onConflictDoUpdate({
                  target: [sleepSession.userId, sleepSession.providerId, sleepSession.externalId],
                  set: {
                    startedAt: parsed.startedAt,
                    endedAt: parsed.endedAt,
                    durationMinutes: parsed.durationMinutes,
                    deepMinutes: parsed.deepMinutes,
                    remMinutes: parsed.remMinutes,
                    lightMinutes: parsed.lightMinutes,
                    awakeMinutes: parsed.awakeMinutes,
                    stagingAvailable: parsed.stagingAvailable,
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
          return { recordCount: count, result: count };
        },
        syncOptions.userId,
      );
      recordsSynced += sleepCount;
    } catch (err) {
      errors.push({
        message: `sleep: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 2. Sync daily metrics (HRV, resting HR, respiratory rate, bed temp)
    try {
      const dailyCount = await withSyncLog(
        db,
        this.id,
        "daily_metrics",
        async () => {
          let count = 0;
          for (const day of trendDays) {
            const parsed = parseEightSleepDailyMetrics(day);
            // Skip if no quality data
            if (parsed.hrv == null && parsed.respiratoryRateAvg == null && parsed.skinTempC == null)
              continue;
            try {
              await db
                .insert(dailyMetrics)
                .values({
                  date: parsed.date,
                  providerId: this.id,
                  hrv: parsed.hrv,
                  respiratoryRateAvg: parsed.respiratoryRateAvg,
                  skinTempC: parsed.skinTempC,
                })
                .onConflictDoUpdate({
                  target: [
                    dailyMetrics.userId,
                    dailyMetrics.date,
                    dailyMetrics.providerId,
                    dailyMetrics.sourceName,
                  ],
                  set: {
                    hrv: parsed.hrv,
                    respiratoryRateAvg: parsed.respiratoryRateAvg,
                    skinTempC: parsed.skinTempC,
                  },
                });
              count++;
            } catch (err) {
              errors.push({
                message: `daily ${parsed.date}: ${err instanceof Error ? err.message : String(err)}`,
                cause: err,
              });
            }
          }
          return { recordCount: count, result: count };
        },
        syncOptions.userId,
      );
      recordsSynced += dailyCount;
    } catch (err) {
      errors.push({
        message: `daily_metrics: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 3. Sync temperature samples to metric stream.
    try {
      const bodyCount = await withSyncLog(
        db,
        this.id,
        "metric_stream",
        async () => {
          let count = 0;
          for (const day of trendDays) {
            const roomTemp = day.sleepQualityScore?.tempRoomC?.average;
            const bedTemp = day.sleepQualityScore?.tempBedC?.average;
            if (!roomTemp && !bedTemp) continue;

            const externalId = `eightsleep-temp-${day.day}`;
            try {
              await writeMetricStreamBatch(
                db,
                [
                  {
                    providerId: this.id,
                    externalId,
                    recordedAt: new Date(day.presenceStart || `${day.day}T00:00:00Z`),
                    temperatureC: bedTemp,
                  },
                ],
                SOURCE_TYPE_API,
                undefined,
                syncOptions.metricStreamPublisher,
              );
              count++;
            } catch (err) {
              errors.push({
                message: err instanceof Error ? err.message : String(err),
                externalId,
                cause: err,
              });
            }
          }
          return { recordCount: count, result: count };
        },
        syncOptions.userId,
      );
      recordsSynced += bodyCount;
    } catch (err) {
      errors.push({
        message: `metric_stream: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 4. Sync HR time series from sessions
    try {
      const hrCount = await withSyncLog(
        db,
        this.id,
        "hr_stream",
        async () => {
          let totalRecords = 0;

          for (const day of trendDays) {
            if (!day.sessions?.length) continue;
            const samples = parseEightSleepHeartRateSamples(day.sessions);
            if (samples.length === 0) continue;

            const metricRows = samples.map((sample) => ({
              providerId: this.id,
              recordedAt: sample.recordedAt,
              heartRate: sample.heartRate,
            }));
            await writeMetricStreamBatch(
              db,
              metricRows,
              SOURCE_TYPE_API,
              undefined,
              syncOptions.metricStreamPublisher,
            );
            totalRecords += samples.length;
          }

          return { recordCount: totalRecords, result: totalRecords };
        },
        syncOptions.userId,
      );
      recordsSynced += hrCount;
    } catch (err) {
      errors.push({
        message: `hr_stream: ${err instanceof Error ? err.message : String(err)}`,
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
