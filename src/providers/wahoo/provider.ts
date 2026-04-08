import type { OAuthConfig, TokenSet } from "../../auth/oauth.ts";
import { exchangeCodeForTokens, getOAuthRedirectUri } from "../../auth/oauth.ts";
import { resolveOAuthTokens } from "../../auth/resolve-tokens.ts";
import type { SyncDatabase } from "../../db/index.ts";
import { logger } from "../../logger.ts";
import type {
  ProviderAuthSetup,
  ProviderIdentity,
  SyncError,
  SyncOptions,
  SyncResult,
  WebhookEvent,
  WebhookProvider,
} from "../types.ts";
import { WahooActivityPersister } from "./activity-persister.ts";
import {
  WAHOO_API_BASE,
  WahooClient,
  type WahooWorkout,
  wahooWebhookPayloadSchema,
} from "./client.ts";
import { parseWorkoutList, parseWorkoutSummary } from "./parsers.ts";

export function wahooOAuthConfig(host?: string): OAuthConfig | null {
  const clientId = process.env.WAHOO_CLIENT_ID;
  const clientSecret = process.env.WAHOO_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    authorizeUrl: `${WAHOO_API_BASE}/oauth/authorize`,
    tokenUrl: `${WAHOO_API_BASE}/oauth/token`,
    redirectUri: getOAuthRedirectUri(host),
    scopes: ["email", "user_read", "workouts_read", "offline_data"],
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
    const client = new WahooClient("", this.#fetchFn);
    const persister = new WahooActivityPersister(this.id, client, db);
    const result = await persister.persist(parsed, {
      deleteExistingSamples: true,
      formatLogMessage: (rowCount, externalId) =>
        `[wahoo] Webhook: inserted ${rowCount} sensor sample rows for workout ${externalId}`,
    });

    if (result.synced) {
      recordsSynced++;
    }
    errors.push(...result.errors);

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

  authSetup(options?: { host?: string }): ProviderAuthSetup {
    const config = wahooOAuthConfig(options?.host);
    if (!config) throw new Error("WAHOO_CLIENT_ID and WAHOO_CLIENT_SECRET are required");
    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeCodeForTokens(config, code),
      revokeExistingTokens: async (tokens) => {
        const client = new WahooClient(tokens.accessToken, this.#fetchFn);
        await client.revokeAuthorization();
      },
      apiBaseUrl: WAHOO_API_BASE,
      identityCapabilities: { providesEmail: false },
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
          email: null,
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
    const persister = new WahooActivityPersister(this.id, client, db);

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

        const result = await persister.persist(workout);

        if (result.synced) {
          recordsSynced++;
          // no-mutate: Progress reporting is UX-only and can't fail in a testable way
          if (onProgress && total > 0) {
            // no-mutate
            onProgress(
              Math.round((recordsSynced / total) * 100),
              `${recordsSynced}/${total} workouts`,
            );
          }
        }
        errors.push(...result.errors);
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
