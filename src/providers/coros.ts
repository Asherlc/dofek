import type { CanonicalActivityType } from "@dofek/training/training";
import { z } from "zod";
import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import { exchangeCodeForTokens } from "../auth/oauth.ts";
import { resolveOAuthTokens } from "../auth/resolve-tokens.ts";
import type { SyncDatabase } from "../db/index.ts";
import { activity, dailyMetrics, sleepSession } from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider } from "../db/tokens.ts";
import { ProviderHttpClient } from "./http-client.ts";
import type {
  ProviderAuthSetup,
  SyncError,
  SyncOptions,
  SyncResult,
  WebhookEvent,
  WebhookProvider,
} from "./types.ts";

// ============================================================
// COROS API Zod schemas
// ============================================================

const COROS_API_BASE = "https://open.coros.com";
const DEFAULT_REDIRECT_URI = "https://localhost:9876/callback";

const corosWorkoutSchema = z.object({
  labelId: z.string(),
  mode: z.number(),
  subMode: z.number(),
  startTime: z.number(),
  endTime: z.number(),
  duration: z.number(),
  distance: z.number(),
  avgHeartRate: z.number(),
  maxHeartRate: z.number(),
  avgSpeed: z.number(),
  maxSpeed: z.number(),
  totalCalories: z.number(),
  avgCadence: z.number().optional(),
  avgPower: z.number().optional(),
  maxPower: z.number().optional(),
  totalAscent: z.number().optional(),
  totalDescent: z.number().optional(),
  avgStrokeRate: z.number().optional(),
  fitUrl: z.string().optional(),
});

type CorosWorkout = z.infer<typeof corosWorkoutSchema>;

const corosWorkoutsResponseSchema = z.object({
  data: z.array(corosWorkoutSchema),
  message: z.string(),
  result: z.string(),
});

const corosDailyDataSchema = z.object({
  date: z.string(),
  steps: z.number().optional(),
  distance: z.number().optional(),
  calories: z.number().optional(),
  restingHr: z.number().optional(),
  avgHr: z.number().optional(),
  maxHr: z.number().optional(),
  sleepDuration: z.number().optional(),
  deepSleep: z.number().optional(),
  lightSleep: z.number().optional(),
  remSleep: z.number().optional(),
  awakeDuration: z.number().optional(),
  spo2Avg: z.number().optional(),
  hrv: z.number().optional(),
});

const corosDailyResponseSchema = z.object({
  data: z.array(corosDailyDataSchema),
  message: z.string(),
  result: z.string(),
});

// ============================================================
// Parsed types
// ============================================================

export interface ParsedCorosWorkout {
  externalId: string;
  activityType: CanonicalActivityType;
  name: string;
  startedAt: Date;
  endedAt: Date;
  raw: Record<string, unknown>;
}

// ============================================================
// Activity type mapping
// ============================================================

const COROS_SPORT_MAP: Record<number, CanonicalActivityType> = {
  8: "running",
  9: "cycling",
  10: "swimming",
  13: "strength",
  14: "walking",
  15: "hiking",
  17: "rowing",
  18: "yoga",
  22: "trail_running",
  23: "skiing",
  27: "triathlon",
  100: "other",
};

export function mapCorosSportType(mode: number): CanonicalActivityType {
  return COROS_SPORT_MAP[mode] ?? "other";
}

export function parseCorosWorkout(workout: CorosWorkout): ParsedCorosWorkout {
  return {
    externalId: workout.labelId,
    activityType: mapCorosSportType(workout.mode),
    name: `COROS ${mapCorosSportType(workout.mode)}`,
    startedAt: new Date(workout.startTime * 1000),
    endedAt: new Date(workout.endTime * 1000),
    raw: {
      distance: workout.distance,
      duration: workout.duration,
      avgHeartRate: workout.avgHeartRate,
      maxHeartRate: workout.maxHeartRate,
      avgSpeed: workout.avgSpeed,
      maxSpeed: workout.maxSpeed,
      calories: workout.totalCalories,
      avgCadence: workout.avgCadence,
      avgPower: workout.avgPower,
      maxPower: workout.maxPower,
      totalAscent: workout.totalAscent,
      totalDescent: workout.totalDescent,
      mode: workout.mode,
      subMode: workout.subMode,
    },
  };
}

// ============================================================
// OAuth configuration
// ============================================================

export function corosOAuthConfig(): OAuthConfig | null {
  const clientId = process.env.COROS_CLIENT_ID;
  const clientSecret = process.env.COROS_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const redirectUri = process.env.OAUTH_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;

  return {
    clientId,
    clientSecret,
    authorizeUrl: `${COROS_API_BASE}/oauth2/authorize`,
    tokenUrl: `${COROS_API_BASE}/oauth2/token`,
    redirectUri,
    scopes: [],
  };
}

// ============================================================
// Helper
// ============================================================

function formatDateCompact(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

// ============================================================
// COROS API client
// ============================================================

export class CorosClient extends ProviderHttpClient {
  constructor(accessToken: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    super(accessToken, COROS_API_BASE, fetchFn);
  }

  protected override getHeaders(): Record<string, string> {
    return { ...super.getHeaders(), Accept: "application/json" };
  }

  async getWorkouts(
    sinceDate: string,
    toDate: string,
  ): Promise<z.infer<typeof corosWorkoutsResponseSchema>> {
    return this.get(
      `/v2/coros/sport/list?startDate=${sinceDate}&endDate=${toDate}`,
      corosWorkoutsResponseSchema,
    );
  }

  async getDailyData(
    sinceDate: string,
    toDate: string,
  ): Promise<z.infer<typeof corosDailyResponseSchema>> {
    return this.get(
      `/v2/coros/daily/list?startDate=${sinceDate}&endDate=${toDate}`,
      corosDailyResponseSchema,
    );
  }
}

// ============================================================
// Provider implementation
// ============================================================

export class CorosProvider implements WebhookProvider {
  readonly id = "coros";
  readonly name = "COROS";
  readonly webhookScope = "app" as const;
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = fetchFn;
  }

  validate(): string | null {
    if (!process.env.COROS_CLIENT_ID) return "COROS_CLIENT_ID is not set";
    if (!process.env.COROS_CLIENT_SECRET) return "COROS_CLIENT_SECRET is not set";
    return null;
  }

  // ── Webhook implementation ──

  async registerWebhook(
    _callbackUrl: string,
    _verifyToken: string,
  ): Promise<{ subscriptionId: string; signingSecret?: string; expiresAt?: Date }> {
    // COROS webhooks are configured during API partner onboarding.
    return { subscriptionId: "coros-partner-subscription" };
  }

  async unregisterWebhook(_subscriptionId: string): Promise<void> {
    // Managed via COROS partner agreement
  }

  verifyWebhookSignature(
    _rawBody: Buffer,
    _headers: Record<string, string | string[] | undefined>,
    _signingSecret: string,
  ): boolean {
    // COROS webhook verification is handled per partner agreement
    return true;
  }

  parseWebhookPayload(body: unknown): WebhookEvent[] {
    const sportDataItemSchema = z.object({
      openId: z.string(),
      labelId: z.coerce.string().optional(),
    });

    const listParsed = z
      .object({
        sportDataList: z.array(z.unknown()),
      })
      .safeParse(body);

    // COROS may send a list of sport data updates
    if (listParsed.success) {
      return listParsed.data.sportDataList
        .map((item) => sportDataItemSchema.safeParse(item))
        .filter(
          (result): result is z.SafeParseSuccess<z.infer<typeof sportDataItemSchema>> =>
            result.success,
        )
        .map((result) => ({
          ownerExternalId: result.data.openId,
          eventType: "create" as const,
          objectType: "workout",
          objectId: result.data.labelId ?? undefined,
        }));
    }

    const singleParsed = z.object({ openId: z.string() }).safeParse(body);

    if (!singleParsed.success) return [];

    return [
      {
        ownerExternalId: singleParsed.data.openId,
        eventType: "create",
        objectType: "workout",
      },
    ];
  }

  authSetup(): ProviderAuthSetup {
    const config = corosOAuthConfig();
    if (!config) throw new Error("COROS_CLIENT_ID and CLIENT_SECRET required");
    const fetchFn = this.#fetchFn;
    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeCodeForTokens(config, code, fetchFn),
      apiBaseUrl: COROS_API_BASE,
    };
  }

  async #resolveTokens(db: SyncDatabase): Promise<TokenSet> {
    return resolveOAuthTokens({
      db,
      providerId: this.id,
      providerName: this.name,
      getOAuthConfig: () => corosOAuthConfig(),
      fetchFn: this.#fetchFn,
    });
  }

  async sync(db: SyncDatabase, since: Date, options?: SyncOptions): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, COROS_API_BASE);

    let client: CorosClient;
    try {
      const tokens = await this.#resolveTokens(db);
      client = new CorosClient(tokens.accessToken, this.#fetchFn);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const sinceDate = formatDateCompact(since);
    const toDate = formatDateCompact(new Date());

    // 1. Sync workouts
    try {
      const activityCount = await withSyncLog(
        db,
        this.id,
        "activity",
        async () => {
          const data = await client.getWorkouts(sinceDate, toDate);
          let count = 0;

          for (const raw of data.data ?? []) {
            const parsed = parseCorosWorkout(raw);
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
                  target: [activity.userId, activity.providerId, activity.externalId],
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

          return { recordCount: count, result: count };
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

    // 2. Sync daily data (sleep, HR, steps)
    try {
      const dailyCount = await withSyncLog(
        db,
        this.id,
        "daily_metrics",
        async () => {
          const data = await client.getDailyData(sinceDate, toDate);
          let count = 0;

          for (const raw of data.data ?? []) {
            const dateStr = `${raw.date.slice(0, 4)}-${raw.date.slice(4, 6)}-${raw.date.slice(6, 8)}`;
            try {
              // Daily metrics
              if (raw.steps || raw.restingHr || raw.hrv) {
                await db
                  .insert(dailyMetrics)
                  .values({
                    date: dateStr,
                    providerId: this.id,
                    steps: raw.steps,
                    restingHr: raw.restingHr,
                    hrv: raw.hrv,
                    spo2Avg: raw.spo2Avg,
                    activeEnergyKcal: raw.calories,
                    distanceKm: raw.distance ? raw.distance / 1000 : undefined,
                  })
                  .onConflictDoUpdate({
                    target: [dailyMetrics.date, dailyMetrics.providerId, dailyMetrics.sourceName],
                    set: {
                      steps: raw.steps,
                      restingHr: raw.restingHr,
                      hrv: raw.hrv,
                      spo2Avg: raw.spo2Avg,
                      activeEnergyKcal: raw.calories,
                      distanceKm: raw.distance ? raw.distance / 1000 : undefined,
                    },
                  });
                count++;
              }

              // Sleep
              if (raw.sleepDuration) {
                const externalId = `coros-sleep-${raw.date}`;
                await db
                  .insert(sleepSession)
                  .values({
                    providerId: this.id,
                    externalId,
                    startedAt: new Date(`${dateStr}T00:00:00Z`),
                    endedAt: new Date(`${dateStr}T08:00:00Z`),
                    durationMinutes: raw.sleepDuration,
                    deepMinutes: raw.deepSleep,
                    lightMinutes: raw.lightSleep,
                    remMinutes: raw.remSleep,
                    awakeMinutes: raw.awakeDuration,
                  })
                  .onConflictDoUpdate({
                    target: [sleepSession.userId, sleepSession.providerId, sleepSession.externalId],
                    set: {
                      durationMinutes: raw.sleepDuration,
                      deepMinutes: raw.deepSleep,
                      lightMinutes: raw.lightSleep,
                      remMinutes: raw.remSleep,
                      awakeMinutes: raw.awakeDuration,
                    },
                  });
                count++;
              }
            } catch (err) {
              errors.push({
                message: `daily ${dateStr}: ${err instanceof Error ? err.message : String(err)}`,
                cause: err,
              });
            }
          }

          return { recordCount: count, result: count };
        },
        options?.userId,
      );
      recordsSynced += dailyCount;
    } catch (err) {
      errors.push({
        message: `daily_metrics: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
  }
}
