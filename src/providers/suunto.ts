import { createHmac, timingSafeEqual } from "node:crypto";
import type { CanonicalActivityType } from "@dofek/training/training";
import { z } from "zod";
import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import { exchangeCodeForTokens, getOAuthRedirectUri } from "../auth/oauth.ts";
import { resolveOAuthTokens } from "../auth/resolve-tokens.ts";
import type { SyncDatabase } from "../db/index.ts";
import { activity } from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider } from "../db/tokens.ts";
import type {
  ProviderAuthSetup,
  SyncError,
  SyncOptions,
  SyncResult,
  WebhookEvent,
  WebhookProvider,
} from "./types.ts";

// ============================================================
// Suunto API types
// ============================================================

const SUUNTO_API_BASE = "https://cloudapi.suunto.com";
const _DEFAULT_REDIRECT_URI = "https://localhost:9876/callback";

interface SuuntoWorkout {
  workoutKey: string;
  activityId: number;
  workoutName?: string;
  startTime: number; // UNIX milliseconds
  stopTime: number; // UNIX milliseconds
  totalTime: number; // seconds
  totalDistance: number; // meters
  totalAscent: number; // meters
  totalDescent: number; // meters
  avgSpeed: number; // m/s
  maxSpeed: number; // m/s
  energyConsumption: number; // kcal
  stepCount: number;
  hrdata?: {
    workoutAvgHR: number;
    workoutMaxHR: number;
  };
}

interface SuuntoWorkoutsResponse {
  payload: SuuntoWorkout[];
}

/**
 * Zod schema for validating SuuntoWorkout data from webhook payloads.
 * Used at the runtime boundary where TypeScript types can't guarantee shape.
 */
const suuntoWorkoutSchema = z.object({
  workoutKey: z.string(),
  activityId: z.number(),
  workoutName: z.string().optional(),
  startTime: z.number(),
  stopTime: z.number(),
  totalTime: z.number(),
  totalDistance: z.number(),
  totalAscent: z.number(),
  totalDescent: z.number(),
  avgSpeed: z.number(),
  maxSpeed: z.number(),
  energyConsumption: z.number(),
  stepCount: z.number(),
  hrdata: z
    .object({
      workoutAvgHR: z.number(),
      workoutMaxHR: z.number(),
    })
    .optional(),
});

// ============================================================
// Parsed types
// ============================================================

export interface ParsedSuuntoWorkout {
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

const SUUNTO_ACTIVITY_MAP: Record<number, CanonicalActivityType> = {
  1: "other",
  2: "running",
  3: "cycling",
  4: "cross_country_skiing",
  5: "other",
  11: "walking",
  12: "hiking",
  14: "strength",
  23: "yoga",
  27: "swimming",
  67: "trail_running",
  69: "rowing",
  82: "virtual_cycling",
  83: "running",
};

export function mapSuuntoActivityType(activityId: number): CanonicalActivityType {
  return SUUNTO_ACTIVITY_MAP[activityId] ?? "other";
}

export function parseSuuntoWorkout(workout: SuuntoWorkout): ParsedSuuntoWorkout {
  return {
    externalId: workout.workoutKey,
    activityType: mapSuuntoActivityType(workout.activityId),
    name: workout.workoutName ?? `Suunto ${mapSuuntoActivityType(workout.activityId)}`,
    startedAt: new Date(workout.startTime),
    endedAt: new Date(workout.stopTime),
    raw: {
      totalDistance: workout.totalDistance,
      totalTime: workout.totalTime,
      totalAscent: workout.totalAscent,
      totalDescent: workout.totalDescent,
      avgSpeed: workout.avgSpeed,
      maxSpeed: workout.maxSpeed,
      calories: workout.energyConsumption,
      steps: workout.stepCount,
      avgHeartRate: workout.hrdata?.workoutAvgHR,
      maxHeartRate: workout.hrdata?.workoutMaxHR,
    },
  };
}

// ============================================================
// OAuth configuration
// ============================================================

export function suuntoOAuthConfig(host?: string): OAuthConfig | null {
  const clientId = process.env.SUUNTO_CLIENT_ID;
  const clientSecret = process.env.SUUNTO_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  return {
    clientId,
    clientSecret,
    authorizeUrl: "https://cloudapi-oauth.suunto.com/oauth/authorize",
    tokenUrl: "https://cloudapi-oauth.suunto.com/oauth/token",
    redirectUri: getOAuthRedirectUri(host),
    scopes: ["workout"],
    tokenAuthMethod: "basic",
  };
}

// ============================================================
// Provider implementation
// ============================================================

export class SuuntoProvider implements WebhookProvider {
  readonly id = "suunto";
  readonly name = "Suunto";
  readonly webhookScope = "app" as const;
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = fetchFn;
  }

  validate(): string | null {
    if (!process.env.SUUNTO_CLIENT_ID) return "SUUNTO_CLIENT_ID is not set";
    if (!process.env.SUUNTO_CLIENT_SECRET) return "SUUNTO_CLIENT_SECRET is not set";
    if (!process.env.SUUNTO_SUBSCRIPTION_KEY) return "SUUNTO_SUBSCRIPTION_KEY is not set";
    return null;
  }

  activityUrl(externalId: string): string {
    return `https://www.sports-tracker.com/workout/${externalId}`;
  }

  // ── Webhook implementation ──

  async registerWebhook(
    _callbackUrl: string,
    _verifyToken: string,
  ): Promise<{ subscriptionId: string; signingSecret?: string; expiresAt?: Date }> {
    // Suunto webhooks are configured via the APIzone developer portal.
    return { subscriptionId: "suunto-portal-subscription" };
  }

  async unregisterWebhook(_subscriptionId: string): Promise<void> {
    // Managed via Suunto APIzone portal
  }

  verifyWebhookSignature(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    signingSecret: string,
  ): boolean {
    // Suunto signs with HMAC-SHA256 in the X-HMAC-SHA256-Signature header
    const signature = headers["x-hmac-sha256-signature"];
    if (!signature || typeof signature !== "string") return false;

    const hmac = createHmac("sha256", signingSecret);
    hmac.update(rawBody);
    const expected = hmac.digest("hex");
    try {
      return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  parseWebhookPayload(body: unknown): WebhookEvent[] {
    // Suunto WORKOUT_CREATED webhooks include the full workout summary inline
    const parsed = z
      .object({
        type: z.string().optional(),
        username: z.string(),
        workout_id: z.coerce.string().optional(),
      })
      .safeParse(body);

    if (!parsed.success) return [];
    const event = parsed.data;

    return [
      {
        ownerExternalId: event.username,
        eventType: "create",
        objectType: event.type ?? "workout",
        objectId: event.workout_id ?? undefined,
        metadata: { payload: body },
      },
    ];
  }

  async syncWebhookEvent(
    db: SyncDatabase,
    event: WebhookEvent,
    options?: SyncOptions,
  ): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    if (event.objectType !== "workout") {
      return { provider: this.id, recordsSynced: 0, errors: [], duration: Date.now() - start };
    }

    // Extract and validate the workout data from the webhook metadata
    const workoutResult = suuntoWorkoutSchema.safeParse(event.metadata?.payload);
    if (!workoutResult.success) {
      errors.push({
        message: `Invalid workout in webhook metadata: ${workoutResult.error.message}`,
      });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    await ensureProvider(db, this.id, this.name, SUUNTO_API_BASE);

    const parsed = parseSuuntoWorkout(workoutResult.data);

    try {
      await withSyncLog(
        db,
        this.id,
        "activity",
        async () => {
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
          return { recordCount: 1, result: 1 };
        },
        options?.userId,
      );
      recordsSynced = 1;
    } catch (err) {
      errors.push({
        message: err instanceof Error ? err.message : String(err),
        externalId: parsed.externalId,
        cause: err,
      });
    }

    return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
  }

  authSetup(options?: { host?: string }): ProviderAuthSetup {
    const config = suuntoOAuthConfig(options?.host);
    if (!config) throw new Error("SUUNTO_CLIENT_ID and CLIENT_SECRET required");
    const fetchFn = this.#fetchFn;
    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeCodeForTokens(config, code, fetchFn),
      apiBaseUrl: SUUNTO_API_BASE,
    };
  }

  async #resolveTokens(db: SyncDatabase): Promise<TokenSet> {
    return resolveOAuthTokens({
      db,
      providerId: this.id,
      providerName: this.name,
      getOAuthConfig: () => suuntoOAuthConfig(),
      fetchFn: this.#fetchFn,
    });
  }

  async sync(db: SyncDatabase, since: Date, options?: SyncOptions): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, SUUNTO_API_BASE);

    let accessToken: string;
    try {
      const tokens = await this.#resolveTokens(db);
      accessToken = tokens.accessToken;
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const subscriptionKey = process.env.SUUNTO_SUBSCRIPTION_KEY ?? "";

    try {
      const activityCount = await withSyncLog(
        db,
        this.id,
        "activity",
        async () => {
          const sinceMs = since.getTime();
          const url = `${SUUNTO_API_BASE}/v2/workouts?since=${sinceMs}`;
          const response = await this.#fetchFn(url, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Ocp-Apim-Subscription-Key": subscriptionKey,
              Accept: "application/json",
            },
          });

          if (!response.ok) {
            const text = await response.text();
            throw new Error(`Suunto API error (${response.status}): ${text}`);
          }

          const data: SuuntoWorkoutsResponse = await response.json();
          let count = 0;

          for (const raw of data.payload ?? []) {
            const parsed = parseSuuntoWorkout(raw);
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

    return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
  }
}
