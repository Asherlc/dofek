import { PELOTON_API_BASE, PelotonClient } from "@dofek/peloton";
import {
  createPelotonAuthorization,
  exchangePelotonAuthorizationCode,
  parseAuth0FormHtml,
  pelotonAutomatedLogin,
  pelotonOAuthConfig,
} from "@dofek/peloton/auth";
import { PelotonAuthenticationError } from "@dofek/peloton/errors";
import { mapFitnessDiscipline, parsePerformanceGraph, parseWorkout } from "@dofek/peloton/parsing";
import type { PelotonPerformanceGraph, PelotonWorkout } from "@dofek/peloton/types";
import type { TokenSet } from "../auth/oauth.ts";
import { resolveOAuthTokens } from "../auth/resolve-tokens.ts";
import type { SyncDatabase } from "../db/index.ts";
import { replaceMetricStreamBatch } from "../db/metric-stream-writer.ts";
import {
  finishProviderActivityListSync,
  upsertProviderActivity,
} from "../db/provider-activity-sync.ts";
import { SOURCE_TYPE_API } from "../db/sensor-channels.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider } from "../db/tokens.ts";
import { createProviderRateLimitFetch } from "../lib/provider-rate-limit-fetch.ts";
import { logger } from "../logger.ts";
import { fetchProviderPages } from "../sync/pagination.ts";
import { AccessTokenExpiredError } from "./auth-errors.ts";
import type { SyncRun } from "./sync-run.ts";
import type { ProviderAuthSetup, SyncError, SyncProvider, SyncResult } from "./types.ts";

export type { PelotonPerformanceGraph, PelotonWorkout };
export {
  mapFitnessDiscipline,
  PelotonAuthenticationError,
  PelotonClient,
  parseAuth0FormHtml,
  parsePerformanceGraph,
  parseWorkout,
  pelotonAutomatedLogin,
  pelotonOAuthConfig,
};

async function requestPeloton<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error: unknown) {
    if (error instanceof PelotonAuthenticationError) {
      throw new AccessTokenExpiredError("Peloton", { cause: error });
    }
    throw error;
  }
}

export class PelotonProvider implements SyncProvider {
  readonly id = "peloton";
  readonly name = "Peloton";
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = createProviderRateLimitFetch("peloton", fetchFn);
  }

  validate(): string | null {
    // Peloton credentials are entered via the UI modal (automated Auth0 login),
    // not env vars. Always enabled — auth state is checked at sync time.
    return null;
  }

  activityUrl(externalId: string): string {
    return `https://members.onepeloton.com/profile/workouts/${externalId}`;
  }

  authSetup(options?: { host?: string }): ProviderAuthSetup {
    const config = pelotonOAuthConfig(options?.host);
    const authorization = createPelotonAuthorization();
    const fetchFn = this.#fetchFn;

    return {
      oauthConfig: config,
      authUrl: authorization.url,
      exchangeCode: (code) =>
        exchangePelotonAuthorizationCode(code, authorization.codeVerifier, fetchFn),
      automatedLogin: (email, password) => pelotonAutomatedLogin(email, password, fetchFn),
      apiBaseUrl: PELOTON_API_BASE,
    };
  }

  async #resolveTokens(db: SyncDatabase): Promise<TokenSet> {
    return resolveOAuthTokens({
      db,
      providerId: this.id,
      providerName: this.name,
      getOAuthConfig: () => pelotonOAuthConfig(),
      fetchFn: this.#fetchFn,
    });
  }

  async sync(run: SyncRun): Promise<SyncResult> {
    const { db, window, options } = run;
    const { onProgress, userId, homeTimezone } = options ?? {};
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    let tokens: TokenSet;
    try {
      tokens = await this.#resolveTokens(db);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const client = new PelotonClient(tokens.accessToken, this.#fetchFn);
    await ensureProvider(db, this.id, this.name, PELOTON_API_BASE);
    const since = window.since;
    const syncWindowEnd = window.until;
    const presentActivityExternalIds = new Set<string>();

    const syncResult = await withSyncLog(
      db,
      this.id,
      "workouts",
      async () => {
        let workoutCount = 0;
        let streamCount = 0;
        let totalWorkouts = 0;
        const pages = await fetchProviderPages<PelotonWorkout, number>({
          providerId: this.id,
          stepName: "workouts",
          initialCursor: 0,
          fetchPage: async (page) => {
            const response = await requestPeloton(() => client.getWorkouts(page ?? 0));
            totalWorkouts = response.total;
            return {
              items: response.data,
              nextCursor: response.show_next ? response.page + 1 : null,
            };
          },
          onPage: async (pageResult) => {
            for (const workout of pageResult.items) {
              if (workout.status !== "COMPLETE") continue;

              const startedAt = new Date(workout.start_time * 1000);
              if (startedAt < since) continue;
              if (startedAt > syncWindowEnd) continue;

              const parsed = parseWorkout(workout);
              presentActivityExternalIds.add(parsed.externalId);

              let activityId: string | null = null;
              try {
                const row = await upsertProviderActivity(
                  db,
                  {
                    providerId: this.id,
                    externalId: parsed.externalId,
                    activityType: parsed.activityType,
                    startedAt: parsed.startedAt,
                    endedAt: parsed.endedAt,
                    name: parsed.name,
                    timezone: parsed.timezone,
                    homeTimezone,
                    stravaId: parsed.stravaId,
                    raw: parsed.raw,
                  },
                  {
                    activityType: parsed.activityType,
                    startedAt: parsed.startedAt,
                    endedAt: parsed.endedAt,
                    name: parsed.name,
                    timezone: parsed.timezone,
                    stravaId: parsed.stravaId,
                    raw: parsed.raw,
                  },
                );

                activityId = row?.id ?? null;
                workoutCount++;
                // no-mutate: Progress reporting is UX-only and can't fail in a testable way
                if (onProgress && totalWorkouts > 0) {
                  // no-mutate
                  onProgress(
                    Math.round((workoutCount / totalWorkouts) * 100),
                    `${workoutCount}/${totalWorkouts} workouts`,
                  );
                }
              } catch (err) {
                errors.push({
                  message: err instanceof Error ? err.message : String(err),
                  externalId: parsed.externalId,
                  cause: err,
                });
              }

              try {
                const everyN = 5;
                const graph = await requestPeloton(() =>
                  client.getPerformanceGraph(workout.id, everyN),
                );
                const series = parsePerformanceGraph(graph, everyN);
                const hrSeries = series.find((item) => item.slug === "heart_rate");
                const hasPedaling = workout.has_pedaling_metrics !== false;
                const powerSeries = hasPedaling
                  ? series.find((item) => item.slug === "output")
                  : undefined;
                const cadenceSeries = hasPedaling
                  ? series.find((item) => item.slug === "cadence")
                  : undefined;
                const sampleCount =
                  hrSeries?.values.length ??
                  powerSeries?.values.length ??
                  cadenceSeries?.values.length ??
                  0;

                if (sampleCount > 0 && activityId) {
                  const rows = [];
                  for (let index = 0; index < sampleCount; index++) {
                    rows.push({
                      providerId: this.id,
                      activityId,
                      recordedAt: new Date(startedAt.getTime() + index * everyN * 1000),
                      heartRate: hrSeries?.values[index] ?? null,
                      power: powerSeries?.values[index] ?? null,
                      cadence: cadenceSeries?.values[index] ?? null,
                    });
                  }

                  await replaceMetricStreamBatch(
                    db,
                    { activityId },
                    rows,
                    SOURCE_TYPE_API,
                    options?.metricStreamPublisher,
                  );
                  streamCount += rows.length;
                }
              } catch (err) {
                errors.push({
                  message: `Performance graph for ${workout.id}: ${err instanceof Error ? err.message : String(err)}`,
                  externalId: workout.id,
                  cause: err,
                });
              }
            }
          },
          shouldStopAfterPage: (pageResult) =>
            pageResult.items.some(
              (workout) =>
                workout.status === "COMPLETE" && new Date(workout.start_time * 1000) < since,
            ),
        });

        logger.info(`[peloton] ${workoutCount} workouts, ${streamCount} metric stream rows`);
        if (pages.degradations.length === 0) {
          await finishProviderActivityListSync(db, {
            providerId: this.id,
            userId,
            windowStart: since,
            windowEnd: syncWindowEnd,
            presentExternalIds: presentActivityExternalIds,
          });
        }
        return {
          recordCount: workoutCount + streamCount,
          result: workoutCount + streamCount,
          degradations: pages.degradations,
        };
      },
      userId,
    );

    recordsSynced += syncResult;

    return {
      provider: this.id,
      recordsSynced,
      errors,
      duration: Date.now() - start,
    };
  }
}
