import type { Provider, SyncResult, SyncError, ProviderAuthSetup } from "./types.js";
import type { Database } from "../db/index.js";
import type { OAuthConfig, TokenSet } from "../auth/oauth.js";
import { exchangeCodeForTokens, refreshAccessToken } from "../auth/oauth.js";
import { loadTokens, saveTokens } from "../db/tokens.js";
import { cardioActivity } from "../db/schema.js";

// ============================================================
// Wahoo API types
// ============================================================

export interface WahooWorkoutSummary {
  id: number;
  ascent_accum?: number;
  cadence_avg?: number;
  calories_accum?: number;
  distance_accum?: number;
  duration_active_accum?: number;
  duration_paused_accum?: number;
  duration_total_accum?: number;
  heart_rate_avg?: number;
  power_bike_np_last?: number;
  power_bike_tss_last?: number;
  power_avg?: number;
  speed_avg?: number;
  work_accum?: number;
  created_at: string;
  updated_at: string;
  file?: { url: string };
}

export interface WahooWorkout {
  id: number;
  name?: string;
  workout_token?: string;
  workout_type_id: number;
  starts: string;
  minutes?: number;
  created_at: string;
  updated_at: string;
  workout_summary?: WahooWorkoutSummary;
}

interface WahooWorkoutListResponse {
  workouts: WahooWorkout[];
  total: number;
  page: number;
  per_page: number;
  order: string;
  sort: string;
}

// ============================================================
// Activity type mapping
// ============================================================

const WORKOUT_TYPE_MAP: Record<number, string> = {
  0: "cycling",
  1: "running",
  2: "running", // treadmill
  3: "cycling", // indoor cycling
  4: "cycling", // mountain biking
  5: "cycling", // gravel
  6: "swimming",
  7: "yoga",
  8: "walking",
  9: "hiking",
  10: "rowing",
  11: "strength",
  12: "elliptical",
  13: "skiing",
};

function mapWorkoutType(typeId: number): string {
  return WORKOUT_TYPE_MAP[typeId] ?? "other";
}

// ============================================================
// Parsing / mapping (pure functions, easy to test)
// ============================================================

export interface ParsedCardioActivity {
  externalId: string;
  activityType: string;
  startedAt: Date;
  endedAt?: Date;
  durationSeconds?: number;
  distanceMeters?: number;
  calories?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  avgPower?: number;
  maxPower?: number;
  avgSpeed?: number;
  maxSpeed?: number;
  avgCadence?: number;
  totalElevationGain?: number;
  normalizedPower?: number;
  intensityFactor?: number;
  tss?: number;
  fitFileUrl?: string;
}

export function parseWorkoutSummary(workout: WahooWorkout): ParsedCardioActivity {
  const summary = workout.workout_summary;

  return {
    externalId: String(workout.id),
    activityType: mapWorkoutType(workout.workout_type_id),
    startedAt: new Date(workout.starts),
    endedAt: summary?.duration_total_accum
      ? new Date(new Date(workout.starts).getTime() + summary.duration_total_accum * 1000)
      : undefined,
    durationSeconds: summary?.duration_active_accum
      ? Math.round(summary.duration_active_accum)
      : undefined,
    distanceMeters: summary?.distance_accum,
    calories: summary?.calories_accum ? Math.round(summary.calories_accum) : undefined,
    avgHeartRate: summary?.heart_rate_avg ? Math.round(summary.heart_rate_avg) : undefined,
    avgPower: summary?.power_avg ? Math.round(summary.power_avg) : undefined,
    avgSpeed: summary?.speed_avg,
    avgCadence: summary?.cadence_avg ? Math.round(summary.cadence_avg) : undefined,
    totalElevationGain: summary?.ascent_accum,
    normalizedPower: summary?.power_bike_np_last
      ? Math.round(summary.power_bike_np_last)
      : undefined,
    tss: summary?.power_bike_tss_last,
    fitFileUrl: summary?.file?.url,
  };
}

export interface ParsedWorkoutList {
  workouts: ParsedCardioActivity[];
  total: number;
  page: number;
  perPage: number;
  hasMore: boolean;
}

export function parseWorkoutList(response: WahooWorkoutListResponse): ParsedWorkoutList {
  return {
    workouts: response.workouts.map(parseWorkoutSummary),
    total: response.total,
    page: response.page,
    perPage: response.per_page,
    hasMore: response.page * response.per_page < response.total,
  };
}

// ============================================================
// Wahoo API client
// ============================================================

const WAHOO_API_BASE = "https://api.wahooligan.com";

export class WahooClient {
  private accessToken: string;
  private fetchFn: typeof globalThis.fetch;

  constructor(accessToken: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.accessToken = accessToken;
    this.fetchFn = fetchFn;
  }

  private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(path, WAHOO_API_BASE);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    const response = await this.fetchFn(url.toString(), {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Wahoo API error (${response.status}): ${text}`);
    }

    return response.json() as Promise<T>;
  }

  async getWorkouts(page = 1, perPage = 30): Promise<WahooWorkoutListResponse> {
    return this.get<WahooWorkoutListResponse>("/v1/workouts", {
      page: String(page),
      per_page: String(perPage),
    });
  }

  async getWorkout(id: number): Promise<{ workout: WahooWorkout }> {
    return this.get<{ workout: WahooWorkout }>(`/v1/workouts/${id}`);
  }
}

// ============================================================
// Provider implementation
// ============================================================

const DEFAULT_REDIRECT_URI = "https://localhost:9876/callback";

export function wahooOAuthConfig(): OAuthConfig {
  const clientId = process.env.WAHOO_CLIENT_ID;
  const clientSecret = process.env.WAHOO_CLIENT_SECRET;
  const redirectUri = process.env.OAUTH_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;

  return {
    clientId: clientId ?? "",
    clientSecret: clientSecret ?? "",
    authorizeUrl: `${WAHOO_API_BASE}/oauth/authorize`,
    tokenUrl: `${WAHOO_API_BASE}/oauth/token`,
    redirectUri,
    scopes: ["user_read", "workouts_read", "offline_data"],
  };
}

export class WahooProvider implements Provider {
  readonly id = "wahoo";
  readonly name = "Wahoo";
  private fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.fetchFn = fetchFn;
  }

  validate(): string | null {
    if (!process.env.WAHOO_CLIENT_ID) return "WAHOO_CLIENT_ID is not set";
    if (!process.env.WAHOO_CLIENT_SECRET) return "WAHOO_CLIENT_SECRET is not set";
    return null;
  }

  authSetup(): ProviderAuthSetup {
    const config = wahooOAuthConfig();
    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeCodeForTokens(config, code),
      apiBaseUrl: WAHOO_API_BASE,
    };
  }

  /**
   * Resolve a valid access token — refreshing if expired.
   */
  private async resolveTokens(db: Database): Promise<TokenSet> {
    const tokens = await loadTokens(db, this.id);
    if (!tokens) {
      throw new Error("No OAuth tokens found for Wahoo. Run: health-data auth wahoo");
    }

    if (tokens.expiresAt > new Date()) {
      return tokens;
    }

    console.log("[wahoo] Access token expired, refreshing...");
    const config = wahooOAuthConfig();
    const refreshed = await refreshAccessToken(config, tokens.refreshToken, this.fetchFn);
    await saveTokens(db, this.id, refreshed);
    return refreshed;
  }

  async sync(db: Database, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    let tokens: TokenSet;
    try {
      tokens = await this.resolveTokens(db);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const client = new WahooClient(tokens.accessToken, this.fetchFn);

    // Paginate through all workouts
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await client.getWorkouts(page);
      const parsed = parseWorkoutList(response);

      for (const workout of parsed.workouts) {
        // Skip workouts before our sync window
        if (workout.startedAt < since) {
          hasMore = false;
          break;
        }

        try {
          await db
            .insert(cardioActivity)
            .values({
              providerId: this.id,
              externalId: workout.externalId,
              activityType: workout.activityType,
              startedAt: workout.startedAt,
              endedAt: workout.endedAt,
              durationSeconds: workout.durationSeconds,
              distanceMeters: workout.distanceMeters,
              calories: workout.calories,
              avgHeartRate: workout.avgHeartRate,
              avgPower: workout.avgPower,
              avgSpeed: workout.avgSpeed,
              avgCadence: workout.avgCadence,
              totalElevationGain: workout.totalElevationGain,
              normalizedPower: workout.normalizedPower,
              tss: workout.tss,
            })
            .onConflictDoUpdate({
              target: [cardioActivity.providerId, cardioActivity.externalId],
              set: {
                activityType: workout.activityType,
                startedAt: workout.startedAt,
                endedAt: workout.endedAt,
                durationSeconds: workout.durationSeconds,
                distanceMeters: workout.distanceMeters,
                calories: workout.calories,
                avgHeartRate: workout.avgHeartRate,
                avgPower: workout.avgPower,
                avgSpeed: workout.avgSpeed,
                avgCadence: workout.avgCadence,
                totalElevationGain: workout.totalElevationGain,
                normalizedPower: workout.normalizedPower,
                tss: workout.tss,
              },
            });

          recordsSynced++;
        } catch (err) {
          errors.push({
            message: err instanceof Error ? err.message : String(err),
            externalId: workout.externalId,
            cause: err,
          });
        }
      }

      hasMore = hasMore && parsed.hasMore;
      page++;
    }

    return {
      provider: this.id,
      recordsSynced,
      errors,
      duration: Date.now() - start,
    };
  }
}
