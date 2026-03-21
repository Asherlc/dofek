import type { SyncDatabase } from "../db/index.ts";
import { dailyMetrics, sleepSession } from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens } from "../db/tokens.ts";
import type { ProviderAuthSetup, SyncError, SyncProvider, SyncResult } from "./types.ts";

// ============================================================
// Ultrahuman Partner API types
// ============================================================

const ULTRAHUMAN_API_BASE = "https://partner.ultrahuman.com/api/v1";

interface UltrahumanMetric {
  type: string;
  object: Record<string, unknown>;
}

interface UltrahumanDailyMetricsResponse {
  data: {
    metrics: Record<string, UltrahumanMetric[]>;
  };
  error: string | null;
  status: number;
}

// ============================================================
// Parsed types
// ============================================================

export interface ParsedUltrahumanDailyMetrics {
  date: string;
  restingHr?: number;
  hrv?: number;
  steps?: number;
  vo2max?: number;
  exerciseMinutes?: number;
  skinTempC?: number;
}

export interface ParsedUltrahumanSleep {
  date: string;
  durationMinutes?: number;
  sleepScore?: number;
}

// ============================================================
// Parsing — pure functions
// ============================================================

export function parseUltrahumanMetrics(
  date: string,
  metrics: UltrahumanMetric[],
): { daily: ParsedUltrahumanDailyMetrics; sleep: ParsedUltrahumanSleep } {
  const daily: ParsedUltrahumanDailyMetrics = { date };
  const sleep: ParsedUltrahumanSleep = { date };

  for (const metric of metrics) {
    const obj = metric.object;
    switch (metric.type) {
      case "night_rhr":
      case "avg_rhr":
        daily.restingHr =
          typeof obj.avg === "number"
            ? Math.round(obj.avg)
            : typeof obj.value === "number"
              ? Math.round(obj.value)
              : undefined;
        break;
      case "avg_sleep_hrv":
        daily.hrv = typeof obj.value === "number" ? obj.value : undefined;
        break;
      case "steps":
        daily.steps = typeof obj.value === "number" ? Math.round(obj.value) : undefined;
        break;
      case "vo2_max":
        daily.vo2max = typeof obj.value === "number" ? obj.value : undefined;
        break;
      case "active_minutes":
        daily.exerciseMinutes = typeof obj.value === "number" ? Math.round(obj.value) : undefined;
        break;
      case "body_temperature":
        daily.skinTempC = typeof obj.value === "number" ? obj.value : undefined;
        break;
      case "sleep": {
        const quickMetrics = Array.isArray(obj.quick_metrics) ? obj.quick_metrics : undefined;
        if (quickMetrics) {
          for (const qm of quickMetrics) {
            if (qm.type === "total_sleep") {
              sleep.durationMinutes = Math.round(qm.value / 60);
            }
            if (qm.type === "sleep_index") {
              sleep.sleepScore = qm.value;
            }
          }
        }
        break;
      }
    }
  }

  return { daily, sleep };
}

// ============================================================
// Ultrahuman API client
// ============================================================

export class UltrahumanClient {
  #token: string;
  #email: string;
  #fetchFn: typeof globalThis.fetch;

  constructor(token: string, email: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#token = token;
    this.#email = email;
    this.#fetchFn = fetchFn;
  }

  async getDailyMetrics(date: string): Promise<UltrahumanDailyMetricsResponse> {
    const url = `${ULTRAHUMAN_API_BASE}/partner/daily_metrics?email=${encodeURIComponent(this.#email)}&date=${date}`;
    const response = await this.#fetchFn(url, {
      headers: {
        Authorization: this.#token,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ultrahuman API error (${response.status}): ${text}`);
    }

    return response.json();
  }
}

// ============================================================
// Helper
// ============================================================

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ============================================================
// Provider implementation
// ============================================================

export class UltrahumanProvider implements SyncProvider {
  readonly id = "ultrahuman";
  readonly name = "Ultrahuman";
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = fetchFn;
  }

  validate(): string | null {
    if (!process.env.ULTRAHUMAN_API_TOKEN) return "ULTRAHUMAN_API_TOKEN is not set";
    if (!process.env.ULTRAHUMAN_EMAIL) return "ULTRAHUMAN_EMAIL is not set";
    return null;
  }

  async sync(db: SyncDatabase, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, ULTRAHUMAN_API_BASE);

    let client: UltrahumanClient;
    try {
      // Try loading from stored tokens first (set via auth command)
      const stored = await loadTokens(db, this.id);
      const token = stored?.accessToken ?? process.env.ULTRAHUMAN_API_TOKEN;
      const emailMatch = stored?.scopes?.match(/email:(\S+)/);
      const email = emailMatch?.[1] ?? process.env.ULTRAHUMAN_EMAIL;

      if (!token || !email) {
        throw new Error("Ultrahuman API token and email required");
      }
      client = new UltrahumanClient(token, email, this.#fetchFn);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    // Iterate day by day
    const today = new Date();
    const currentDate = new Date(since);

    // 1. Sync daily metrics + sleep
    try {
      const count = await withSyncLog(db, this.id, "daily_metrics", async () => {
        let dailyCount = 0;

        while (currentDate <= today) {
          const dateStr = formatDate(currentDate);
          try {
            const response = await client.getDailyMetrics(dateStr);
            const dayMetrics = response.data?.metrics?.[dateStr];
            if (!dayMetrics?.length) {
              currentDate.setDate(currentDate.getDate() + 1);
              continue;
            }

            const { daily, sleep } = parseUltrahumanMetrics(dateStr, dayMetrics);

            // Upsert daily metrics
            if (daily.restingHr || daily.hrv || daily.steps || daily.vo2max) {
              await db
                .insert(dailyMetrics)
                .values({
                  date: daily.date,
                  providerId: this.id,
                  restingHr: daily.restingHr,
                  hrv: daily.hrv,
                  steps: daily.steps,
                  vo2max: daily.vo2max,
                  exerciseMinutes: daily.exerciseMinutes,
                  skinTempC: daily.skinTempC,
                })
                .onConflictDoUpdate({
                  target: [dailyMetrics.date, dailyMetrics.providerId, dailyMetrics.sourceName],
                  set: {
                    restingHr: daily.restingHr,
                    hrv: daily.hrv,
                    steps: daily.steps,
                    vo2max: daily.vo2max,
                    exerciseMinutes: daily.exerciseMinutes,
                    skinTempC: daily.skinTempC,
                  },
                });
              dailyCount++;
            }

            // Upsert sleep session
            if (sleep.durationMinutes) {
              const externalId = `ultrahuman-sleep-${dateStr}`;
              await db
                .insert(sleepSession)
                .values({
                  providerId: this.id,
                  externalId,
                  startedAt: new Date(`${dateStr}T00:00:00Z`),
                  endedAt: new Date(`${dateStr}T08:00:00Z`),
                  durationMinutes: sleep.durationMinutes,
                })
                .onConflictDoUpdate({
                  target: [sleepSession.providerId, sleepSession.externalId],
                  set: {
                    durationMinutes: sleep.durationMinutes,
                  },
                });
              dailyCount++;
            }
          } catch (err) {
            errors.push({
              message: `${dateStr}: ${err instanceof Error ? err.message : String(err)}`,
              cause: err,
            });
          }

          currentDate.setDate(currentDate.getDate() + 1);
        }

        return { recordCount: dailyCount, result: dailyCount };
      });
      recordsSynced += count;
    } catch (err) {
      errors.push({
        message: `daily_metrics: ${err instanceof Error ? err.message : String(err)}`,
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
