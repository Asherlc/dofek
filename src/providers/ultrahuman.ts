import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { dailyMetrics, sleepSession } from "../db/schema/activity.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens } from "../db/tokens.ts";
import { createProviderRateLimitFetch } from "../lib/provider-rate-limit-fetch.ts";
import { authFailureReasonFromError, ProviderTokenRejectedError } from "./auth-errors.ts";
import type { SyncRun } from "./sync-run.ts";
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
  #email: string | undefined;
  #fetchFn: typeof globalThis.fetch;

  constructor(
    token: string,
    email: string | undefined,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.#token = token;
    this.#email = email;
    this.#fetchFn = createProviderRateLimitFetch("ultrahuman", fetchFn);
  }

  async getDailyMetrics(date: string): Promise<UltrahumanDailyMetricsResponse> {
    const url = new URL(`${ULTRAHUMAN_API_BASE}/partner/daily_metrics`);
    if (this.#email) {
      url.searchParams.set("email", this.#email);
    }
    url.searchParams.set("date", date);
    const response = await this.#fetchFn(url, {
      headers: {
        Authorization: this.#token,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new ProviderTokenRejectedError(
          "Ultrahuman",
          "Create a new personal API token in Ultrahuman Vision and reconnect.",
        );
      }
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
    this.#fetchFn = createProviderRateLimitFetch("ultrahuman", fetchFn);
  }

  validate(): string | null {
    return null;
  }

  authSetup(): ProviderAuthSetup {
    const fetchFn = this.#fetchFn;
    return {
      manualToken: {
        label: "Personal API token",
        instructionsUrl: "https://vision.ultrahuman.com/developer-docs",
        exchangeToken: async (token) => {
          const date = formatDate(new Date());
          const response = await fetchFn(
            `${ULTRAHUMAN_API_BASE}/partner/daily_metrics?date=${date}`,
            {
              headers: {
                Authorization: token,
                Accept: "application/json",
              },
            },
          );
          if (response.status === 401 || response.status === 403) {
            throw new ProviderTokenRejectedError(
              this.name,
              "Create a new personal API token in Ultrahuman Vision and try again.",
            );
          }
          if (!response.ok) {
            throw new Error(`Ultrahuman token validation failed (${response.status}). Try again.`);
          }
          return {
            accessToken: token,
            refreshToken: null,
            expiresAt: new Date("2099-12-31T00:00:00.000Z"),
            scopes: "self",
          };
        },
      },
      apiBaseUrl: ULTRAHUMAN_API_BASE,
    };
  }

  async sync(run: SyncRun): Promise<SyncResult> {
    const { db, window, options } = run;
    const since = window.since;
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, ULTRAHUMAN_API_BASE);

    let client: UltrahumanClient;
    try {
      if (!options.userId) {
        throw new Error("Ultrahuman sync requires an authenticated user ID.");
      }
      const stored = await loadTokens(db, this.id, options.userId);
      if (!stored) {
        throw new Error(
          "No Ultrahuman personal API token found. Connect Ultrahuman in Data Sources.",
        );
      }
      client = new UltrahumanClient(stored.accessToken, undefined, this.#fetchFn);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    // Iterate day by day
    const until = window.until;
    const currentDate = new Date(since);

    // 1. Sync daily metrics + sleep
    try {
      const count = await withSyncLog(
        db,
        this.id,
        "daily_metrics",
        async () => {
          let dailyCount = 0;

          while (currentDate <= until) {
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
              const hasAnyDailyMetric =
                daily.hrv !== undefined ||
                daily.steps !== undefined ||
                daily.exerciseMinutes !== undefined ||
                daily.skinTempC !== undefined;
              if (hasAnyDailyMetric) {
                await db
                  .insert(dailyMetrics)
                  .values({
                    date: daily.date,
                    providerId: this.id,
                    hrv: daily.hrv,
                    steps: daily.steps,
                    exerciseMinutes: daily.exerciseMinutes,
                    skinTempC: daily.skinTempC,
                  })
                  .onConflictDoUpdate({
                    target: [
                      dailyMetrics.userId,
                      dailyMetrics.date,
                      dailyMetrics.providerId,
                      dailyMetrics.sourceName,
                    ],
                    set: {
                      hrv: daily.hrv,
                      steps: daily.steps,
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
                    stagingAvailable: false,
                  })
                  .onConflictDoUpdate({
                    target: [sleepSession.userId, sleepSession.providerId, sleepSession.externalId],
                    set: {
                      durationMinutes: sleep.durationMinutes,
                      stagingAvailable: false,
                    },
                  });
                dailyCount++;
              }
            } catch (err) {
              // Stop the day-by-day loop on a rate limit and let it propagate so
              // the sync job can schedule a cooldown instead of hammering the API.
              if (err instanceof ProviderRateLimitError) throw err;
              // Authentication failures must reach withSyncLog so the clients can
              // replace the Sync action with Reconnect.
              if (authFailureReasonFromError(err)) throw err;
              errors.push({
                message: `${dateStr}: ${err instanceof Error ? err.message : String(err)}`,
                cause: err,
              });
            }

            currentDate.setDate(currentDate.getDate() + 1);
          }

          return { recordCount: dailyCount, result: dailyCount };
        },
        options?.userId,
      );
      recordsSynced += count;
    } catch (err) {
      // Propagate rate limits to the sync job's cooldown handler.
      if (err instanceof ProviderRateLimitError) throw err;
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
