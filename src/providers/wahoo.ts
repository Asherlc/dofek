import {
  type CanonicalActivityType,
  createActivityTypeMapper,
  WAHOO_WORKOUT_TYPE_MAP,
} from "@dofek/training/training";
import { z } from "zod";
import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import { exchangeCodeForTokens, getOAuthRedirectUri } from "../auth/oauth.ts";
import { resolveOAuthTokens } from "../auth/resolve-tokens.ts";
import type { SyncDatabase } from "../db/index.ts";
import { activity, metricStream } from "../db/schema.ts";
import { type ParsedFitRecord, parseFitFile } from "../fit/parser.ts";
import { logger } from "../logger.ts";
import { ProviderHttpClient } from "./http-client.ts";
import type {
  ProviderAuthSetup,
  ProviderIdentity,
  SyncError,
  SyncProvider,
  SyncResult,
} from "./types.ts";

// ============================================================
// Wahoo API Zod schemas
// ============================================================

export const wahooWorkoutSummarySchema = z.object({
  id: z.number(),
  ascent_accum: z.number().optional(),
  cadence_avg: z.number().optional(),
  calories_accum: z.number().optional(),
  distance_accum: z.number().optional(),
  duration_active_accum: z.number().optional(),
  duration_paused_accum: z.number().optional(),
  duration_total_accum: z.number().optional(),
  heart_rate_avg: z.number().optional(),
  power_bike_np_last: z.number().optional(),
  power_bike_tss_last: z.number().optional(),
  power_avg: z.number().optional(),
  speed_avg: z.number().optional(),
  work_accum: z.number().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  file: z.object({ url: z.string() }).optional(),
});

export type WahooWorkoutSummary = z.infer<typeof wahooWorkoutSummarySchema>;

export const wahooWorkoutSchema = z.object({
  id: z.number(),
  name: z.string().optional(),
  workout_token: z.string().optional(),
  workout_type_id: z.number(),
  starts: z.string(),
  minutes: z.number().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  workout_summary: wahooWorkoutSummarySchema.optional(),
});

export type WahooWorkout = z.infer<typeof wahooWorkoutSchema>;

const wahooWorkoutListResponseSchema = z.object({
  workouts: z.array(wahooWorkoutSchema),
  total: z.number(),
  page: z.number(),
  per_page: z.number(),
  order: z.string(),
  sort: z.string(),
});

type WahooWorkoutListResponse = z.infer<typeof wahooWorkoutListResponseSchema>;

const wahooSingleWorkoutResponseSchema = z.object({
  workout: wahooWorkoutSchema,
});

// ============================================================
// Activity type mapping
// ============================================================

const mapWahooWorkoutType = createActivityTypeMapper(WAHOO_WORKOUT_TYPE_MAP);

function mapWorkoutType(typeId: number): CanonicalActivityType {
  return mapWahooWorkoutType(typeId);
}

// ============================================================
// Parsing / mapping (pure functions, easy to test)
// ============================================================

export interface ParsedCardioActivity {
  externalId: string;
  activityType: CanonicalActivityType;
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
    grade: r.grade,
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

export class WahooClient extends ProviderHttpClient {
  constructor(accessToken: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    super(accessToken, WAHOO_API_BASE, fetchFn);
  }

  async getWorkouts(page = 1, perPage = 30): Promise<WahooWorkoutListResponse> {
    return this.get("/v1/workouts", wahooWorkoutListResponseSchema, {
      page: String(page),
      per_page: String(perPage),
    });
  }

  async getWorkout(id: number): Promise<z.infer<typeof wahooSingleWorkoutResponseSchema>> {
    return this.get(`/v1/workouts/${id}`, wahooSingleWorkoutResponseSchema);
  }

  async downloadFitFile(url: string): Promise<Buffer> {
    // FIT file URLs are pre-signed CDN/S3 URLs — do not send auth headers,
    // as it causes 403 errors and leaks the OAuth token to a third party.
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

export class WahooProvider implements SyncProvider {
  readonly id = "wahoo";
  readonly name = "Wahoo";
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = fetchFn;
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
        const response = await this.#fetchFn(`${WAHOO_API_BASE}/v1/user`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Wahoo user API error (${response.status}): ${text}`);
        }
        const user: {
          id: number;
          email?: string | null;
          first_name?: string | null;
          last_name?: string | null;
        } = await response.json();
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
  async #resolveTokens(db: SyncDatabase): Promise<TokenSet> {
    return resolveOAuthTokens({
      db,
      providerId: this.id,
      providerName: this.name,
      getOAuthConfig: () => wahooOAuthConfig(),
      fetchFn: this.#fetchFn,
    });
  }

  async sync(
    db: SyncDatabase,
    since: Date,
    options?: import("./types.ts").SyncOptions,
  ): Promise<SyncResult> {
    const onProgress = options?.onProgress;
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

    const client = new WahooClient(tokens.accessToken, this.#fetchFn);

    // Paginate through all workouts
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await client.getWorkouts(page);
      const parsed = parseWorkoutList(response);

      const total = parsed.total;

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
          // no-mutate: Progress reporting is UX-only and can't fail in a testable way
          if (onProgress && total > 0) {
            // no-mutate
            onProgress(
              Math.round((recordsSynced / total) * 100),
              `${recordsSynced}/${total} workouts`,
            );
          }

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
                logger.info(
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
