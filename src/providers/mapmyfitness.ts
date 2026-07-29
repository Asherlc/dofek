import {
  type LegacyActivityType,
  type ProviderActivityType,
  resolveProviderActivityType,
} from "@dofek/training/activity-types";
import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import { exchangeCodeForTokens, getOAuthRedirectUri } from "../auth/oauth.ts";
import { resolveOAuthTokens } from "../auth/resolve-tokens.ts";
import type { SyncDatabase } from "../db/index.ts";
import {
  finishProviderActivityListSync,
  upsertProviderActivity,
} from "../db/provider-activity-sync.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider } from "../db/tokens.ts";
import { createProviderRateLimitFetch } from "../lib/provider-rate-limit-fetch.ts";
import { fetchProviderPages } from "../sync/pagination.ts";
import type { SyncDegradation } from "../sync/sync-degradation.ts";
import type { SyncRun } from "./sync-run.ts";
import type { ProviderAuthSetup, SyncError, SyncProvider, SyncResult } from "./types.ts";

// ============================================================
// MapMyFitness API types
// ============================================================

const MAPMYFITNESS_API_BASE = "https://api.mapmyfitness.com";
const _DEFAULT_REDIRECT_URI = "https://localhost:9876/callback";
const MAPMYFITNESS_WORKOUT_PAGE_SIZE = 40;
const MAPMYFITNESS_MAX_WORKOUT_PAGES = 100;

interface MapMyFitnessWorkout {
  _links: { self: Array<{ id: string }> };
  name: string;
  start_datetime: string; // ISO
  start_locale_timezone: string;
  aggregates: {
    distance_total?: number; // meters
    active_time_total?: number; // seconds
    speed_max?: number; // m/s
    speed_avg?: number; // m/s
    metabolic_energy_total?: number; // joules
    cadence_avg?: number;
    heart_rate_avg?: number;
    heart_rate_max?: number;
    heart_rate_min?: number;
    power_avg?: number;
    power_max?: number;
  };
  activity_type: string;
}

interface MapMyFitnessWorkoutListResponse {
  _embedded: {
    workouts: MapMyFitnessWorkout[];
  };
  _links: {
    next?: Array<{ href: string }>;
  };
  total_count: number;
}

// ============================================================
// Parsed types
// ============================================================

export interface ParsedMapMyFitnessWorkout {
  externalId: string;
  activityType: ProviderActivityType;
  name: string;
  startedAt: Date;
  endedAt: Date;
  timezone: string;
  raw: Record<string, unknown>;
}

// ============================================================
// Parsing — pure functions
// ============================================================

export function mapMapMyFitnessActivityType(activityType: string): ProviderActivityType {
  const lower = activityType.toLowerCase();
  let normalizedType: LegacyActivityType = "other";
  if (lower.includes("run")) normalizedType = "running";
  else if (lower.includes("ride") || lower.includes("cycl") || lower.includes("bik")) {
    normalizedType = "cycling";
  } else if (lower.includes("walk")) normalizedType = "walking";
  else if (lower.includes("swim")) normalizedType = "swimming";
  else if (lower.includes("hik")) normalizedType = "hiking";
  else if (lower.includes("yoga")) normalizedType = "yoga";
  else if (lower.includes("weight") || lower.includes("strength")) {
    normalizedType = "strength";
  } else if (lower.includes("row")) normalizedType = "rowing";
  return resolveProviderActivityType(activityType.trim() || "other", normalizedType);
}

export function parseMapMyFitnessWorkout(workout: MapMyFitnessWorkout): ParsedMapMyFitnessWorkout {
  const externalId = workout._links?.self?.[0]?.id ?? "";
  const startedAt = new Date(workout.start_datetime);
  const durationSeconds = workout.aggregates.active_time_total ?? 0;
  const endedAt = new Date(startedAt.getTime() + durationSeconds * 1000);

  return {
    externalId,
    activityType: mapMapMyFitnessActivityType(
      workout.activity_type?.trim() ? workout.activity_type : workout.name,
    ),
    name: workout.name,
    startedAt,
    endedAt,
    timezone: workout.start_locale_timezone,
    raw: {
      startLocaleTimezone: workout.start_locale_timezone,
      distanceMeters: workout.aggregates.distance_total,
      durationSeconds,
      avgSpeed: workout.aggregates.speed_avg,
      maxSpeed: workout.aggregates.speed_max,
      avgHeartRate: workout.aggregates.heart_rate_avg,
      maxHeartRate: workout.aggregates.heart_rate_max,
      avgCadence: workout.aggregates.cadence_avg,
      avgPower: workout.aggregates.power_avg,
      maxPower: workout.aggregates.power_max,
    },
  };
}

// ============================================================
// OAuth configuration
// ============================================================

export function mapMyFitnessOAuthConfig(host?: string): OAuthConfig | null {
  const clientId = process.env.MAPMYFITNESS_CLIENT_ID;
  const clientSecret = process.env.MAPMYFITNESS_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  return {
    clientId,
    clientSecret,
    authorizeUrl: "https://www.mapmyfitness.com/v7.1/oauth2/authorize/",
    tokenUrl: `${MAPMYFITNESS_API_BASE}/v7.1/oauth2/access_token/`,
    redirectUri: getOAuthRedirectUri(host),
    scopes: [],
  };
}

// ============================================================
// MapMyFitness API client
// ============================================================

export class MapMyFitnessClient {
  #accessToken: string;
  #clientId: string;
  #fetchFn: typeof globalThis.fetch;

  constructor(
    accessToken: string,
    clientId: string,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.#accessToken = accessToken;
    this.#clientId = clientId;
    this.#fetchFn = fetchFn;
  }

  async #get<T>(path: string): Promise<T> {
    const url = `${MAPMYFITNESS_API_BASE}${path}`;
    const response = await this.#fetchFn(url, {
      headers: {
        Authorization: `Bearer ${this.#accessToken}`,
        "Api-Key": this.#clientId,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`MapMyFitness API error (${response.status}): ${text}`);
    }

    return response.json();
  }

  async getWorkouts(
    userId: string,
    startedAfter: string,
    startedBefore: string,
    offset = 0,
  ): Promise<MapMyFitnessWorkoutListResponse> {
    const params = new URLSearchParams({
      user: userId,
      started_after: startedAfter,
      started_before: startedBefore,
      order_by: "-start_datetime",
      limit: "40",
      offset: String(offset),
    });
    return this.#get<MapMyFitnessWorkoutListResponse>(`/v7.1/workout/?${params.toString()}`);
  }
}

// ============================================================
// Helper
// ============================================================

function formatDate(date: Date): string {
  return date.toISOString();
}

// ============================================================
// Provider implementation
// ============================================================

export class MapMyFitnessProvider implements SyncProvider {
  readonly id = "mapmyfitness";
  readonly name = "MapMyFitness";
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = createProviderRateLimitFetch("mapmyfitness", fetchFn);
  }

  validate(): string | null {
    if (!process.env.MAPMYFITNESS_CLIENT_ID) return "MAPMYFITNESS_CLIENT_ID is not set";
    if (!process.env.MAPMYFITNESS_CLIENT_SECRET) return "MAPMYFITNESS_CLIENT_SECRET is not set";
    return null;
  }

  authSetup(options?: { host?: string }): ProviderAuthSetup {
    const config = mapMyFitnessOAuthConfig(options?.host);
    if (!config) throw new Error("MAPMYFITNESS_CLIENT_ID and CLIENT_SECRET required");
    const fetchFn = this.#fetchFn;

    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeCodeForTokens(config, code, fetchFn),
      apiBaseUrl: MAPMYFITNESS_API_BASE,
    };
  }

  async #resolveTokens(db: SyncDatabase): Promise<TokenSet> {
    return resolveOAuthTokens({
      db,
      providerId: this.id,
      providerName: this.name,
      getOAuthConfig: () => mapMyFitnessOAuthConfig(),
      fetchFn: this.#fetchFn,
    });
  }

  async sync(run: SyncRun): Promise<SyncResult> {
    const { db, window, options } = run;
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, MAPMYFITNESS_API_BASE);

    let tokens: TokenSet;
    try {
      tokens = await this.#resolveTokens(db);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const clientId = process.env.MAPMYFITNESS_CLIENT_ID ?? "";
    const client = new MapMyFitnessClient(tokens.accessToken, clientId, this.#fetchFn);
    const since = window.since;
    const syncWindowEnd = window.until;
    const presentActivityExternalIds = new Set<string>();
    const degradations: SyncDegradation[] = [];

    // Extract user ID from token scopes or use "-" for self
    const userId = tokens.scopes?.match(/user_id:(\S+)/)?.[1] ?? "-";

    try {
      const activityCount = await withSyncLog(
        db,
        this.id,
        "activity",
        async () => {
          let count = 0;

          const pages = await fetchProviderPages<MapMyFitnessWorkout, number>({
            providerId: this.id,
            stepName: "activity_list",
            initialCursor: 0,
            maxPages: MAPMYFITNESS_MAX_WORKOUT_PAGES,
            fetchPage: async (offset) => {
              const currentOffset = offset ?? 0;
              const response = await client.getWorkouts(
                userId,
                formatDate(since),
                formatDate(syncWindowEnd),
                currentOffset,
              );
              const workouts = response._embedded?.workouts ?? [];
              const responseHasNext = !!response._links?.next?.length;
              return {
                items: workouts,
                nextCursor: responseHasNext ? currentOffset + MAPMYFITNESS_WORKOUT_PAGE_SIZE : null,
              };
            },
            onPage: async (pageResult) => {
              for (const raw of pageResult.items) {
                const parsed = parseMapMyFitnessWorkout(raw);
                if (!parsed.externalId) continue;
                if (parsed.startedAt > syncWindowEnd) continue;
                presentActivityExternalIds.add(parsed.externalId);
                try {
                  await upsertProviderActivity(
                    db,
                    {
                      providerId: this.id,
                      externalId: parsed.externalId,
                      activityType: parsed.activityType,
                      name: parsed.name,
                      startedAt: parsed.startedAt,
                      endedAt: parsed.endedAt,
                      timezone: parsed.timezone,
                      raw: parsed.raw,
                    },
                    {
                      activityType: parsed.activityType,
                      name: parsed.name,
                      startedAt: parsed.startedAt,
                      endedAt: parsed.endedAt,
                      timezone: parsed.timezone,
                      raw: parsed.raw,
                    },
                  );
                  count++;
                } catch (err) {
                  errors.push({
                    message: err instanceof Error ? err.message : String(err),
                    externalId: parsed.externalId,
                    cause: err,
                  });
                }
              }
            },
          });

          if (pages.degradations.length === 0) {
            await finishProviderActivityListSync(db, {
              providerId: this.id,
              userId: options?.userId,
              windowStart: since,
              windowEnd: syncWindowEnd,
              presentExternalIds: presentActivityExternalIds,
            });
          }
          degradations.push(...pages.degradations);
          return { recordCount: count, result: count, degradations };
        },
        options?.userId,
      );
      recordsSynced += activityCount;
    } catch (err) {
      errors.push({
        message: `activity: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    return {
      provider: this.id,
      recordsSynced,
      errors,
      degradations: degradations.length > 0 ? degradations : undefined,
      duration: Date.now() - start,
    };
  }
}
