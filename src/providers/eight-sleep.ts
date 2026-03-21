import type { EightSleepTrendDay } from "eight-sleep-client";
import {
  EIGHT_SLEEP_CLIENT_ID,
  EIGHT_SLEEP_CLIENT_SECRET,
  EightSleepClient,
  parseEightSleepDailyMetrics,
  parseEightSleepHeartRateSamples,
  parseEightSleepTrendDay,
} from "eight-sleep-client";
import type { SyncDatabase } from "../db/index.ts";
import { bodyMeasurement, dailyMetrics, metricStream, sleepSession } from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens } from "../db/tokens.ts";
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

const AUTH_API_BASE = "https://auth-api.8slp.net/v1";

export class EightSleepProvider implements SyncProvider {
  readonly id = "eight-sleep";
  readonly name = "Eight Sleep";
  private fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.fetchFn = fetchFn;
  }

  validate(): string | null {
    // Eight Sleep is always "enabled" — auth state checked at sync time via stored tokens
    return null;
  }

  authSetup(): ProviderAuthSetup {
    const fetchFn = this.fetchFn;
    return {
      oauthConfig: {
        clientId: EIGHT_SLEEP_CLIENT_ID,
        clientSecret: EIGHT_SLEEP_CLIENT_SECRET,
        authorizeUrl: `${AUTH_API_BASE}/tokens`,
        tokenUrl: `${AUTH_API_BASE}/tokens`,
        redirectUri: "",
        scopes: [],
      },
      automatedLogin: async (email: string, password: string) => {
        const result = await EightSleepClient.signIn(email, password, fetchFn);
        return {
          accessToken: result.accessToken,
          refreshToken: null,
          expiresAt: new Date(Date.now() + result.expiresIn * 1000),
          scopes: `userId:${result.userId}`,
        };
      },
      exchangeCode: async () => {
        throw new Error("Eight Sleep uses automated login, not OAuth code exchange");
      },
    };
  }

  async sync(db: SyncDatabase, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

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
        throw new Error("Eight Sleep user ID not found — re-authenticate");
      }

      // Eight Sleep has no refresh tokens — user must re-authenticate when expired
      if (stored.expiresAt <= new Date()) {
        throw new Error("Eight Sleep token expired — please re-authenticate via Settings");
      }
      client = new EightSleepClient(stored.accessToken, userId, this.fetchFn);
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
      const sleepCount = await withSyncLog(db, this.id, "sleep", async () => {
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
        return { recordCount: count, result: count };
      });
      recordsSynced += sleepCount;
    } catch (err) {
      errors.push({
        message: `sleep: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 2. Sync daily metrics (HRV, resting HR, respiratory rate, bed temp)
    try {
      const dailyCount = await withSyncLog(db, this.id, "daily_metrics", async () => {
        let count = 0;
        for (const day of trendDays) {
          const parsed = parseEightSleepDailyMetrics(day);
          // Skip if no quality data
          if (!parsed.restingHr && !parsed.hrv && !parsed.respiratoryRateAvg) continue;
          try {
            await db
              .insert(dailyMetrics)
              .values({
                date: parsed.date,
                providerId: this.id,
                restingHr: parsed.restingHr ? Math.round(parsed.restingHr) : undefined,
                hrv: parsed.hrv,
                respiratoryRateAvg: parsed.respiratoryRateAvg,
                skinTempC: parsed.skinTempC,
              })
              .onConflictDoUpdate({
                target: [dailyMetrics.date, dailyMetrics.providerId],
                set: {
                  restingHr: parsed.restingHr ? Math.round(parsed.restingHr) : undefined,
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
      });
      recordsSynced += dailyCount;
    } catch (err) {
      errors.push({
        message: `daily_metrics: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 3. Sync body temperature as body measurements
    try {
      const bodyCount = await withSyncLog(db, this.id, "body_measurement", async () => {
        let count = 0;
        for (const day of trendDays) {
          const roomTemp = day.sleepQualityScore?.tempRoomC?.average;
          const bedTemp = day.sleepQualityScore?.tempBedC?.average;
          if (!roomTemp && !bedTemp) continue;

          const externalId = `eightsleep-temp-${day.day}`;
          try {
            await db
              .insert(bodyMeasurement)
              .values({
                providerId: this.id,
                externalId,
                recordedAt: new Date(day.presenceStart || `${day.day}T00:00:00Z`),
                temperatureC: bedTemp,
              })
              .onConflictDoUpdate({
                target: [bodyMeasurement.providerId, bodyMeasurement.externalId],
                set: { temperatureC: bedTemp },
              });
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
      });
      recordsSynced += bodyCount;
    } catch (err) {
      errors.push({
        message: `body_measurement: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 4. Sync HR time series from sessions
    try {
      const hrCount = await withSyncLog(db, this.id, "hr_stream", async () => {
        let totalRecords = 0;
        const BATCH_SIZE = 500;

        for (const day of trendDays) {
          if (!day.sessions?.length) continue;
          const samples = parseEightSleepHeartRateSamples(day.sessions);
          if (samples.length === 0) continue;

          for (let i = 0; i < samples.length; i += BATCH_SIZE) {
            const batch = samples.slice(i, i + BATCH_SIZE);
            await db
              .insert(metricStream)
              .values(
                batch.map((s) => ({
                  providerId: this.id,
                  recordedAt: s.recordedAt,
                  heartRate: s.heartRate,
                })),
              )
              .onConflictDoNothing();
          }
          totalRecords += samples.length;
        }

        return { recordCount: totalRecords, result: totalRecords };
      });
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
