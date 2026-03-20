import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import { exchangeCodeForTokens, refreshAccessToken } from "../auth/oauth.ts";
import type { SyncDatabase } from "../db/index.ts";
import { activity } from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import { logger } from "../logger.ts";
import type { ProviderAuthSetup, SyncError, SyncProvider, SyncResult } from "./types.ts";

// ============================================================
// MapMyFitness API types
// ============================================================

const MAPMYFITNESS_API_BASE = "https://api.mapmyfitness.com";
const DEFAULT_REDIRECT_URI = "https://localhost:9876/callback";

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
  activityType: string;
  name: string;
  startedAt: Date;
  endedAt: Date;
  raw: Record<string, unknown>;
}

// ============================================================
// Parsing — pure functions
// ============================================================

export function mapMapMyFitnessActivityType(activityType: string): string {
  const lower = activityType.toLowerCase();
  if (lower.includes("run")) return "running";
  if (lower.includes("ride") || lower.includes("cycl") || lower.includes("bik")) return "cycling";
  if (lower.includes("walk")) return "walking";
  if (lower.includes("swim")) return "swimming";
  if (lower.includes("hik")) return "hiking";
  if (lower.includes("yoga")) return "yoga";
  if (lower.includes("weight") || lower.includes("strength")) return "strength";
  if (lower.includes("row")) return "rowing";
  return "other";
}

export function parseMapMyFitnessWorkout(workout: MapMyFitnessWorkout): ParsedMapMyFitnessWorkout {
  const externalId = workout._links?.self?.[0]?.id ?? "";
  const startedAt = new Date(workout.start_datetime);
  const durationSeconds = workout.aggregates.active_time_total ?? 0;
  const endedAt = new Date(startedAt.getTime() + durationSeconds * 1000);

  return {
    externalId,
    activityType: mapMapMyFitnessActivityType(workout.activity_type ?? workout.name),
    name: workout.name,
    startedAt,
    endedAt,
    raw: {
      distanceMeters: workout.aggregates.distance_total,
      durationSeconds,
      avgSpeed: workout.aggregates.speed_avg,
      maxSpeed: workout.aggregates.speed_max,
      avgHeartRate: workout.aggregates.heart_rate_avg,
      maxHeartRate: workout.aggregates.heart_rate_max,
      avgCadence: workout.aggregates.cadence_avg,
      avgPower: workout.aggregates.power_avg,
      maxPower: workout.aggregates.power_max,
      calories: workout.aggregates.metabolic_energy_total
        ? Math.round(workout.aggregates.metabolic_energy_total / 4184)
        : undefined,
    },
  };
}

// ============================================================
// OAuth configuration
// ============================================================

export function mapMyFitnessOAuthConfig(): OAuthConfig | null {
  const clientId = process.env.MAPMYFITNESS_CLIENT_ID;
  const clientSecret = process.env.MAPMYFITNESS_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const redirectUri = process.env.OAUTH_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;

  return {
    clientId,
    clientSecret,
    authorizeUrl: "https://www.mapmyfitness.com/v7.1/oauth2/authorize/",
    tokenUrl: `${MAPMYFITNESS_API_BASE}/v7.1/oauth2/access_token/`,
    redirectUri,
    scopes: [],
  };
}

// ============================================================
// MapMyFitness API client
// ============================================================

export class MapMyFitnessClient {
  private accessToken: string;
  private clientId: string;
  private fetchFn: typeof globalThis.fetch;

  constructor(
    accessToken: string,
    clientId: string,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.accessToken = accessToken;
    this.clientId = clientId;
    this.fetchFn = fetchFn;
  }

  private async get<T>(path: string): Promise<T> {
    const url = `${MAPMYFITNESS_API_BASE}${path}`;
    const response = await this.fetchFn(url, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Api-Key": this.clientId,
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
    offset = 0,
  ): Promise<MapMyFitnessWorkoutListResponse> {
    return this.get<MapMyFitnessWorkoutListResponse>(
      `/v7.1/workout/?user=${userId}&started_after=${startedAfter}&order_by=-start_datetime&limit=40&offset=${offset}`,
    );
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
  private fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.fetchFn = fetchFn;
  }

  validate(): string | null {
    if (!process.env.MAPMYFITNESS_CLIENT_ID) return "MAPMYFITNESS_CLIENT_ID is not set";
    if (!process.env.MAPMYFITNESS_CLIENT_SECRET) return "MAPMYFITNESS_CLIENT_SECRET is not set";
    return null;
  }

  authSetup(): ProviderAuthSetup {
    const config = mapMyFitnessOAuthConfig();
    if (!config) throw new Error("MAPMYFITNESS_CLIENT_ID and CLIENT_SECRET required");
    const fetchFn = this.fetchFn;

    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeCodeForTokens(config, code, fetchFn),
      apiBaseUrl: MAPMYFITNESS_API_BASE,
    };
  }

  private async resolveTokens(db: SyncDatabase): Promise<TokenSet> {
    const tokens = await loadTokens(db, this.id);
    if (!tokens) {
      throw new Error("No OAuth tokens found for MapMyFitness. Run: health-data auth mapmyfitness");
    }

    if (tokens.expiresAt > new Date()) return tokens;

    logger.info("[mapmyfitness] Token expired, refreshing...");
    const config = mapMyFitnessOAuthConfig();
    if (!config) throw new Error("MapMyFitness OAuth config required");
    if (!tokens.refreshToken) throw new Error("No refresh token for MapMyFitness");
    const refreshed = await refreshAccessToken(config, tokens.refreshToken, this.fetchFn);
    await saveTokens(db, this.id, refreshed);
    return refreshed;
  }

  async sync(db: SyncDatabase, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, MAPMYFITNESS_API_BASE);

    let tokens: TokenSet;
    try {
      tokens = await this.resolveTokens(db);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const clientId = process.env.MAPMYFITNESS_CLIENT_ID ?? "";
    const client = new MapMyFitnessClient(tokens.accessToken, clientId, this.fetchFn);

    // Extract user ID from token scopes or use "-" for self
    const userId = tokens.scopes?.match(/user_id:(\S+)/)?.[1] ?? "-";

    try {
      const activityCount = await withSyncLog(db, this.id, "activity", async () => {
        let count = 0;
        let offset = 0;
        let hasMore = true;

        while (hasMore) {
          const response = await client.getWorkouts(userId, formatDate(since), offset);
          const workouts = response._embedded?.workouts ?? [];
          if (workouts.length === 0) break;

          for (const raw of workouts) {
            const parsed = parseMapMyFitnessWorkout(raw);
            if (!parsed.externalId) continue;
            try {
              await db
                .insert(activity)
                .values({
                  providerId: this.id,
                  externalId: parsed.externalId,
                  activityType: parsed.activityType,
                  name: parsed.name,
                  startedAt: parsed.startedAt,
                  endedAt: parsed.endedAt,
                  raw: parsed.raw,
                })
                .onConflictDoUpdate({
                  target: [activity.providerId, activity.externalId],
                  set: {
                    activityType: parsed.activityType,
                    name: parsed.name,
                    startedAt: parsed.startedAt,
                    endedAt: parsed.endedAt,
                    raw: parsed.raw,
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

          hasMore = !!response._links?.next?.length;
          offset += 40;
        }

        return { recordCount: count, result: count };
      });
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
      duration: Date.now() - start,
    };
  }
}
