import { isIndoorCycling } from "@dofek/training/endurance-types";
import {
  type CanonicalActivityType,
  createActivityTypeMapper,
  WAHOO_WORKOUT_TYPE_MAP,
} from "@dofek/training/training";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import { exchangeCodeForTokens, getOAuthRedirectUri } from "../auth/oauth.ts";
import { resolveOAuthTokens } from "../auth/resolve-tokens.ts";
import type { SyncDatabase } from "../db/index.ts";
import { activity, metricStream } from "../db/schema.ts";
import { SOURCE_TYPE_FILE } from "../db/sensor-channels.ts";
import { dualWriteToSensorSample } from "../db/sensor-sample-writer.ts";
import { type ParsedFitRecord, parseFitFile } from "../fit/parser.ts";
import { logger } from "../logger.ts";
import { ProviderHttpClient } from "./http-client.ts";
import type {
  ProviderAuthSetup,
  ProviderIdentity,
  SyncError,
  SyncOptions,
  SyncResult,
  WebhookEvent,
  WebhookProvider,
} from "./types.ts";

// ============================================================
// Wahoo API Zod schemas
// ============================================================

/**
 * Wahoo's API returns numeric fields as strings or null — coerce to number
 * or undefined so downstream code always sees `number | undefined`.
 */
const wahooNumeric = z.preprocess(
  (val) => (val === null || val === undefined ? undefined : Number(val)),
  z.number().optional(),
);

export const wahooWorkoutSummarySchema = z.object({
  id: z.number(),
  ascent_accum: wahooNumeric,
  cadence_avg: wahooNumeric,
  calories_accum: wahooNumeric,
  distance_accum: wahooNumeric,
  duration_active_accum: wahooNumeric,
  duration_paused_accum: wahooNumeric,
  duration_total_accum: wahooNumeric,
  heart_rate_avg: wahooNumeric,
  power_bike_np_last: wahooNumeric,
  power_bike_tss_last: wahooNumeric,
  power_avg: wahooNumeric,
  speed_avg: wahooNumeric,
  work_accum: wahooNumeric,
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

/**
 * Wahoo webhook payload schema. The payload contains the full workout and
 * workout_summary data inline, so we can upsert directly without API calls.
 */
export const wahooWebhookPayloadSchema = z.object({
  event_type: z.string().optional(),
  webhook_token: z.string().optional(),
  user: z.object({ id: z.number() }),
  workout_summary: wahooWorkoutSummarySchema.optional(),
  workout: wahooWorkoutSchema.optional(),
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
  activityType?: string,
): (typeof metricStream.$inferInsert)[] {
  const indoor = activityType ? isIndoorCycling(activityType) : false;
  return records.map((r) => ({
    providerId,
    activityId,
    recordedAt: r.recordedAt,
    heartRate: r.heartRate,
    power: r.power,
    cadence: r.cadence,
    speed: indoor ? undefined : r.speed,
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

export class WahooProvider implements WebhookProvider {
  readonly id = "wahoo";
  readonly name = "Wahoo";
  readonly webhookScope = "app" as const;
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = fetchFn;
  }

  validate(): string | null {
    if (!process.env.WAHOO_CLIENT_ID) return "WAHOO_CLIENT_ID is not set";
    if (!process.env.WAHOO_CLIENT_SECRET) return "WAHOO_CLIENT_SECRET is not set";
    return null;
  }

  activityUrl(externalId: string): string {
    return `https://cloud.wahoo.com/workouts/${externalId}`;
  }

  // ── Webhook implementation ──

  async registerWebhook(
    _callbackUrl: string,
    _verifyToken: string,
  ): Promise<{ subscriptionId: string; signingSecret?: string; expiresAt?: Date }> {
    // Wahoo webhooks are registered via the developer portal, not via API.
    // Configure the webhook URL at https://developers.wahooligan.com
    return { subscriptionId: "wahoo-portal-subscription" };
  }

  async unregisterWebhook(_subscriptionId: string): Promise<void> {
    // Managed via Wahoo developer portal
  }

  verifyWebhookSignature(
    _rawBody: Buffer,
    _headers: Record<string, string | string[] | undefined>,
    _signingSecret: string,
  ): boolean {
    // Wahoo webhook signature verification is not publicly documented.
    // Webhooks are registered via the developer portal with a specific URL.
    return true;
  }

  parseWebhookPayload(body: unknown): WebhookEvent[] {
    const parsed = wahooWebhookPayloadSchema.safeParse(body);

    if (!parsed.success) return [];
    const event = parsed.data;

    return [
      {
        ownerExternalId: String(event.user.id),
        eventType: event.event_type === "workout_summary.updated" ? "update" : "create",
        objectType: "workout",
        objectId: event.workout_summary?.id ? String(event.workout_summary.id) : undefined,
        metadata: { payload: event },
      },
    ];
  }

  /**
   * Sync a single workout from a webhook event. The Wahoo webhook payload
   * contains the full workout + workout_summary data, so we can upsert
   * directly without any API calls (except downloading the FIT file).
   */
  async syncWebhookEvent(
    db: SyncDatabase,
    event: WebhookEvent,
    _options?: SyncOptions,
  ): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    if (event.objectType !== "workout") {
      return { provider: this.id, recordsSynced: 0, errors: [], duration: Date.now() - start };
    }

    // Extract the full workout from the webhook metadata
    const webhookPayload = wahooWebhookPayloadSchema.safeParse(event.metadata?.payload);
    if (!webhookPayload.success) {
      errors.push({
        message: `Invalid webhook payload: ${webhookPayload.error.message}`,
        externalId: event.objectId,
      });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const payload = webhookPayload.data;

    // Build a WahooWorkout from the payload. The webhook may provide the
    // workout object directly, or we can reconstruct it from the
    // workout_summary + top-level fields.
    let workout: WahooWorkout | undefined = payload.workout;
    if (!workout && payload.workout_summary) {
      // When only workout_summary is present (e.g. workout_summary.created
      // events), we don't have enough data for a full workout record.
      // Fall back: log and skip — the full sync will pick it up.
      logger.warn(
        `[wahoo] Webhook payload has workout_summary but no workout object for event ${event.objectId}`,
      );
      return { provider: this.id, recordsSynced: 0, errors: [], duration: Date.now() - start };
    }

    if (!workout) {
      errors.push({
        message: "Webhook payload missing workout data",
        externalId: event.objectId,
      });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    // If the payload includes a standalone workout_summary that's richer than
    // the one nested inside the workout, merge it in.
    if (payload.workout_summary && !workout.workout_summary) {
      workout = { ...workout, workout_summary: payload.workout_summary };
    }

    const parsed = parseWorkoutSummary(workout);

    try {
      const [row] = await db
        .insert(activity)
        .values({
          providerId: this.id,
          externalId: parsed.externalId,
          activityType: parsed.activityType,
          startedAt: parsed.startedAt,
          endedAt: parsed.endedAt,
          name: parsed.name,
        })
        .onConflictDoUpdate({
          target: [activity.providerId, activity.externalId],
          set: {
            activityType: parsed.activityType,
            startedAt: parsed.startedAt,
            endedAt: parsed.endedAt,
            name: parsed.name,
          },
        })
        .returning({ id: activity.id });

      recordsSynced++;

      const activityId = row?.id;
      if (!activityId) {
        return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
      }

      // Download and parse FIT file if a URL is present
      if (parsed.fitFileUrl) {
        try {
          const fitBuffer = await new WahooClient("", this.#fetchFn).downloadFitFile(
            parsed.fitFileUrl,
          );
          const fitData = await parseFitFile(fitBuffer);
          const metricRows = fitRecordsToMetricStream(
            fitData.records,
            this.id,
            activityId,
            parsed.activityType,
          );

          if (metricRows.length > 0) {
            // Delete existing metric_stream rows before re-inserting
            await db.delete(metricStream).where(eq(metricStream.activityId, activityId));

            // Insert in batches of 500
            for (let i = 0; i < metricRows.length; i += 500) {
              await db.insert(metricStream).values(metricRows.slice(i, i + 500));
            }
            await dualWriteToSensorSample(db, metricRows, SOURCE_TYPE_FILE);
            logger.info(
              `[wahoo] Webhook: inserted ${metricRows.length} metric_stream records for workout ${parsed.externalId}`,
            );
          }
        } catch (fitErr) {
          errors.push({
            message: `FIT file for ${parsed.externalId}: ${fitErr instanceof Error ? fitErr.message : String(fitErr)}`,
            externalId: parsed.externalId,
            cause: fitErr,
          });
        }
      }
    } catch (err) {
      errors.push({
        message: err instanceof Error ? err.message : String(err),
        externalId: parsed.externalId,
        cause: err,
      });
    }

    logger.info(
      `[wahoo] Webhook sync complete: ${recordsSynced} records, ${errors.length} errors (${Date.now() - start}ms)`,
    );

    return {
      provider: this.id,
      recordsSynced,
      errors,
      duration: Date.now() - start,
    };
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

  async sync(db: SyncDatabase, since: Date, options?: SyncOptions): Promise<SyncResult> {
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
              const metricRows = fitRecordsToMetricStream(
                fitData.records,
                this.id,
                activityId,
                workout.activityType,
              );

              if (metricRows.length > 0) {
                // Insert in batches of 500
                for (let i = 0; i < metricRows.length; i += 500) {
                  await db.insert(metricStream).values(metricRows.slice(i, i + 500));
                }
                await dualWriteToSensorSample(db, metricRows, SOURCE_TYPE_FILE);
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
