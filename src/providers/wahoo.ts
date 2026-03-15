import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import { exchangeCodeForTokens, getOAuthRedirectUri, refreshAccessToken } from "../auth/oauth.ts";
import type { Database } from "../db/index.ts";
import { activity, metricStream } from "../db/schema.ts";
import { loadTokens, saveTokens } from "../db/tokens.ts";
import { type ParsedFitRecord, parseFitFile } from "../fit/parser.ts";
import type {
  Provider,
  ProviderAuthSetup,
  ProviderIdentity,
  SyncError,
  SyncResult,
} from "./types.ts";

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
  name?: string;
  startedAt: Date;
  endedAt?: Date;
  fitFileUrl?: string;
}

export function parseWorkoutSummary(workout: WahooWorkout): ParsedCardioActivity {
  const summary = workout.workout_summary;

  return {
    externalId: String(workout.id),
    activityType: mapWorkoutType(workout.workout_type_id),
    name: workout.name,
    startedAt: new Date(workout.starts),
    endedAt: summary?.duration_total_accum
      ? new Date(new Date(workout.starts).getTime() + summary.duration_total_accum * 1000)
      : undefined,
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
// FIT record → metric_stream mapping
// ============================================================

export function fitRecordsToMetricStream(
  records: ParsedFitRecord[],
  providerId: string,
  activityId: string,
): (typeof metricStream.$inferInsert)[] {
  return records.map((r) => ({
    providerId,
    activityId,
    recordedAt: r.recordedAt,
    heartRate: r.heartRate,
    power: r.power,
    cadence: r.cadence,
    speed: r.speed,
    lat: r.lat,
    lng: r.lng,
    altitude: r.altitude,
    temperature: r.temperature,
    distance: r.distance,
    grade: r.grade,
    calories: r.calories,
    verticalSpeed: r.verticalSpeed,
    gpsAccuracy: r.gpsAccuracy,
    accumulatedPower: r.accumulatedPower,
    leftRightBalance: r.leftRightBalance,
    verticalOscillation: r.verticalOscillation,
    stanceTime: r.stanceTime,
    stanceTimePercent: r.stanceTimePercent,
    stepLength: r.stepLength,
    verticalRatio: r.verticalRatio,
    stanceTimeBalance: r.stanceTimeBalance,
    leftTorqueEffectiveness: r.leftTorqueEffectiveness,
    rightTorqueEffectiveness: r.rightTorqueEffectiveness,
    leftPedalSmoothness: r.leftPedalSmoothness,
    rightPedalSmoothness: r.rightPedalSmoothness,
    combinedPedalSmoothness: r.combinedPedalSmoothness,
    raw: r.raw,
  }));
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

  async downloadFitFile(url: string): Promise<Buffer> {
    const response = await this.fetchFn(url);
    if (!response.ok) {
      throw new Error(`Failed to download FIT file (${response.status})`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}

// ============================================================
// Provider implementation
// ============================================================

export function wahooOAuthConfig(): OAuthConfig | null {
  const clientId = process.env.WAHOO_CLIENT_ID;
  const clientSecret = process.env.WAHOO_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    authorizeUrl: `${WAHOO_API_BASE}/oauth/authorize`,
    tokenUrl: `${WAHOO_API_BASE}/oauth/token`,
    redirectUri: getOAuthRedirectUri(),
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
    if (!config) throw new Error("WAHOO_CLIENT_ID and WAHOO_CLIENT_SECRET are required");
    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeCodeForTokens(config, code),
      apiBaseUrl: WAHOO_API_BASE,
      getUserIdentity: async (accessToken: string): Promise<ProviderIdentity> => {
        const response = await this.fetchFn(`${WAHOO_API_BASE}/v1/user`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Wahoo user API error (${response.status}): ${text}`);
        }
        const user = (await response.json()) as {
          id: number;
          email?: string | null;
          first_name?: string | null;
          last_name?: string | null;
        };
        const nameParts = [user.first_name, user.last_name].filter(Boolean);
        return {
          providerAccountId: String(user.id),
          email: user.email ?? null,
          name: nameParts.length > 0 ? nameParts.join(" ") : null,
        };
      },
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
    if (!config)
      throw new Error("WAHOO_CLIENT_ID and WAHOO_CLIENT_SECRET are required to refresh tokens");
    if (!tokens.refreshToken) throw new Error("No refresh token for Wahoo");
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
          const [row] = await db
            .insert(activity)
            .values({
              providerId: this.id,
              externalId: workout.externalId,
              activityType: workout.activityType,
              startedAt: workout.startedAt,
              endedAt: workout.endedAt,
              name: workout.name,
            })
            .onConflictDoUpdate({
              target: [activity.providerId, activity.externalId],
              set: {
                activityType: workout.activityType,
                startedAt: workout.startedAt,
                endedAt: workout.endedAt,
                name: workout.name,
              },
            })
            .returning({ id: activity.id });

          recordsSynced++;

          // Download and parse FIT file for raw sensor data
          if (workout.fitFileUrl) {
            try {
              const fitBuffer = await client.downloadFitFile(workout.fitFileUrl);
              const fitData = await parseFitFile(fitBuffer);
              const activityId = row?.id;
              if (!activityId) continue;
              const metricRows = fitRecordsToMetricStream(fitData.records, this.id, activityId);

              if (metricRows.length > 0) {
                // Insert in batches of 500
                for (let i = 0; i < metricRows.length; i += 500) {
                  await db.insert(metricStream).values(metricRows.slice(i, i + 500));
                }
                console.log(
                  `[wahoo] Inserted ${metricRows.length} metric_stream records for workout ${workout.externalId}`,
                );
              }
            } catch (fitErr) {
              errors.push({
                message: `FIT file for ${workout.externalId}: ${fitErr instanceof Error ? fitErr.message : String(fitErr)}`,
                externalId: workout.externalId,
                cause: fitErr,
              });
            }
          }
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
