import type { CanonicalActivityType } from "@dofek/training/training";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import { exchangeCodeForTokens } from "../auth/oauth.ts";
import { resolveOAuthTokens } from "../auth/resolve-tokens.ts";
import type { SyncDatabase } from "../db/index.ts";
import { activity } from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { getTokenUserId } from "../db/token-user-context.ts";
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
// Concept2 Logbook API Zod schemas
// ============================================================

const CONCEPT2_API_BASE = "https://log.concept2.com";
const DEFAULT_REDIRECT_URI = "https://localhost:9876/callback";

const concept2ResultSchema = z.object({
  id: z.number(),
  type: z.string(),
  date: z.string(),
  distance: z.number(),
  time: z.number(),
  time_formatted: z.string(),
  stroke_rate: z.number(),
  stroke_count: z.number(),
  heart_rate: z
    .object({
      average: z.number().optional(),
      max: z.number().optional(),
      min: z.number().optional(),
    })
    .optional(),
  calories_total: z.number().optional(),
  drag_factor: z.number().optional(),
  weight_class: z.string(),
  workout_type: z.string(),
  comments: z.string().optional(),
  privacy: z.string(),
  splits: z
    .array(
      z.object({
        distance: z.number(),
        time: z.number(),
        stroke_rate: z.number(),
        heart_rate: z.number().optional(),
      }),
    )
    .optional(),
});

type Concept2Result = z.infer<typeof concept2ResultSchema>;

const concept2ResultsResponseSchema = z.object({
  data: z.array(concept2ResultSchema),
  meta: z.object({
    pagination: z.object({
      total: z.number(),
      count: z.number(),
      per_page: z.number(),
      current_page: z.number(),
      total_pages: z.number(),
    }),
  }),
});

function resolveScopedUserId(userId?: string): string {
  const scopedUserId = userId ?? getTokenUserId();
  if (!scopedUserId) {
    throw new Error("concept2 webhook sync requires userId");
  }
  return scopedUserId;
}

// ============================================================
// Parsed types
// ============================================================

export interface ParsedConcept2Result {
  externalId: string;
  activityType: CanonicalActivityType;
  name: string;
  startedAt: Date;
  endedAt: Date;
  raw: Record<string, unknown>;
}

// ============================================================
// Parsing
// ============================================================

export function mapConcept2Type(type: string): CanonicalActivityType {
  switch (type.toLowerCase()) {
    case "rower":
      return "rowing";
    case "skierg":
      return "skiing";
    case "bikerg":
      return "cycling";
    default:
      return "rowing";
  }
}

export function parseConcept2Result(result: Concept2Result): ParsedConcept2Result {
  const startedAt = new Date(result.date);
  const durationMs = (result.time / 10) * 1000; // tenths of a second to ms
  const endedAt = new Date(startedAt.getTime() + durationMs);

  return {
    externalId: String(result.id),
    activityType: mapConcept2Type(result.type),
    name: `${result.type.charAt(0).toUpperCase() + result.type.slice(1)} ${result.workout_type}`,
    startedAt,
    endedAt,
    raw: {
      type: result.type,
      distance: result.distance,
      timeFormatted: result.time_formatted,
      strokeRate: result.stroke_rate,
      strokeCount: result.stroke_count,
      avgHeartRate: result.heart_rate?.average,
      maxHeartRate: result.heart_rate?.max,
      calories: result.calories_total,
      dragFactor: result.drag_factor,
      workoutType: result.workout_type,
      weightClass: result.weight_class,
    },
  };
}

// ============================================================
// OAuth configuration
// ============================================================

export function concept2OAuthConfig(): OAuthConfig | null {
  const clientId = process.env.CONCEPT2_CLIENT_ID;
  const clientSecret = process.env.CONCEPT2_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const redirectUri = process.env.OAUTH_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;

  return {
    clientId,
    clientSecret,
    authorizeUrl: `${CONCEPT2_API_BASE}/oauth/authorize`,
    tokenUrl: `${CONCEPT2_API_BASE}/oauth/access_token`,
    redirectUri,
    scopes: ["user:read", "results:read"],
  };
}

// ============================================================
// Concept2 API client
// ============================================================

export class Concept2Client extends ProviderHttpClient {
  constructor(accessToken: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    super(accessToken, CONCEPT2_API_BASE, fetchFn);
  }

  protected override getHeaders(): Record<string, string> {
    return { ...super.getHeaders(), Accept: "application/json" };
  }

  async getResults(
    sinceDate: string,
    page = 1,
  ): Promise<z.infer<typeof concept2ResultsResponseSchema>> {
    return this.get(
      `/api/users/me/results?from=${sinceDate}&page=${page}`,
      concept2ResultsResponseSchema,
    );
  }
}

// ============================================================
// Provider implementation
// ============================================================

export class Concept2Provider implements WebhookProvider {
  readonly id = "concept2";
  readonly name = "Concept2";
  readonly webhookScope = "app" as const;
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = fetchFn;
  }

  validate(): string | null {
    if (!process.env.CONCEPT2_CLIENT_ID) return "CONCEPT2_CLIENT_ID is not set";
    if (!process.env.CONCEPT2_CLIENT_SECRET) return "CONCEPT2_CLIENT_SECRET is not set";
    return null;
  }

  activityUrl(externalId: string): string {
    return `https://log.concept2.com/results/${externalId}`;
  }

  // ── Webhook implementation ──

  async registerWebhook(
    _callbackUrl: string,
    _verifyToken: string,
  ): Promise<{ subscriptionId: string; signingSecret?: string; expiresAt?: Date }> {
    // Concept2 webhooks are registered via the developer portal.
    return { subscriptionId: "concept2-portal-subscription" };
  }

  async unregisterWebhook(_subscriptionId: string): Promise<void> {
    // Managed via Concept2 developer portal
  }

  verifyWebhookSignature(
    _rawBody: Buffer,
    _headers: Record<string, string | string[] | undefined>,
    _signingSecret: string,
  ): boolean {
    // Concept2 webhook signature verification not publicly documented.
    return true;
  }

  parseWebhookPayload(body: unknown): WebhookEvent[] {
    // Concept2 sends: { event: "result-added"|"result-updated"|"result-deleted", result: { ... } }
    // Use a permissive record schema for the result to capture the full payload.
    // The full result is re-validated against concept2ResultSchema in syncWebhookEvent().
    const parsed = z
      .object({
        event: z.string(),
        user_id: z.coerce.string(),
        result: z.object({ id: z.coerce.string() }).passthrough().optional(),
      })
      .safeParse(body);

    if (!parsed.success) return [];
    const event = parsed.data;

    const eventTypeMap: Record<string, WebhookEvent["eventType"]> = {
      "result-added": "create",
      "result-updated": "update",
      "result-deleted": "delete",
    };

    const resultId = event.result?.id;

    return [
      {
        ownerExternalId: String(event.user_id),
        eventType: eventTypeMap[event.event] ?? "update",
        objectType: "result",
        objectId: resultId ?? undefined,
        metadata: event.result ? { payload: event.result } : undefined,
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

    if (event.objectType !== "result") {
      return { provider: this.id, recordsSynced: 0, errors: [], duration: Date.now() - start };
    }

    // Handle delete events
    if (event.eventType === "delete" && event.objectId) {
      const scopedUserId = resolveScopedUserId(options?.userId);
      await db
        .delete(activity)
        .where(
          and(
            eq(activity.userId, scopedUserId),
            eq(activity.providerId, this.id),
            eq(activity.externalId, event.objectId),
          ),
        );
      return { provider: this.id, recordsSynced: 0, errors: [], duration: Date.now() - start };
    }

    // Extract the full result from webhook metadata
    const rawPayload = event.metadata?.payload;
    if (!rawPayload) {
      return { provider: this.id, recordsSynced: 0, errors: [], duration: Date.now() - start };
    }

    const parseResult = concept2ResultSchema.safeParse(rawPayload);
    if (!parseResult.success) {
      errors.push({
        message: `Failed to parse webhook result payload: ${parseResult.error.message}`,
      });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    await ensureProvider(db, this.id, this.name, CONCEPT2_API_BASE);

    try {
      const activityCount = await withSyncLog(
        db,
        this.id,
        "activity",
        async () => {
          const parsed = parseConcept2Result(parseResult.data);
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
          return { recordCount: 1, result: 1 };
        },
        options?.userId,
      );
      recordsSynced += activityCount;
    } catch (err) {
      errors.push({
        message: `activity: ${err instanceof Error ? err.message : String(err)}`,
        externalId: event.objectId,
        cause: err,
      });
    }

    return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
  }

  authSetup(): ProviderAuthSetup {
    const config = concept2OAuthConfig();
    if (!config) throw new Error("CONCEPT2_CLIENT_ID and CLIENT_SECRET required");
    const fetchFn = this.#fetchFn;
    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeCodeForTokens(config, code, fetchFn),
      apiBaseUrl: CONCEPT2_API_BASE,
    };
  }

  async #resolveTokens(db: SyncDatabase): Promise<TokenSet> {
    return resolveOAuthTokens({
      db,
      providerId: this.id,
      providerName: this.name,
      getOAuthConfig: () => concept2OAuthConfig(),
      fetchFn: this.#fetchFn,
    });
  }

  async sync(db: SyncDatabase, since: Date, options?: SyncOptions): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, CONCEPT2_API_BASE);

    let client: Concept2Client;
    try {
      const tokens = await this.#resolveTokens(db);
      client = new Concept2Client(tokens.accessToken, this.#fetchFn);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    try {
      const activityCount = await withSyncLog(
        db,
        this.id,
        "activity",
        async () => {
          let count = 0;
          let page = 1;
          let totalPages = 1;
          const sinceDate = since.toISOString().slice(0, 10);

          while (page <= totalPages) {
            const data = await client.getResults(sinceDate, page);
            totalPages = data.meta.pagination.total_pages;

            for (const raw of data.data) {
              const parsed = parseConcept2Result(raw);
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

            page++;
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
