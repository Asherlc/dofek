import { exchangeCodeForTokens } from "../../auth/oauth.ts";
import type { SyncDatabase } from "../../db/index.ts";
import { logger } from "../../logger.ts";
import type {
  ProviderAuthSetup,
  SyncOptions,
  SyncResult,
  WebhookEvent,
  WebhookProvider,
} from "../types.ts";
import { PolarClient } from "./client.ts";
import { POLAR_API_BASE, polarOAuthConfig } from "./oauth.ts";
import { PolarSyncService } from "./sync-service.ts";
import { PolarWebhookService } from "./webhook-service.ts";

export class PolarProvider implements WebhookProvider {
  readonly id = "polar";
  readonly name = "Polar";
  readonly webhookScope = "app" as const;

  readonly #fetchFn: typeof globalThis.fetch;
  readonly #webhookService: PolarWebhookService;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = fetchFn;
    this.#webhookService = new PolarWebhookService(fetchFn);
  }

  validate(): string | null {
    if (!process.env.POLAR_CLIENT_ID) return "POLAR_CLIENT_ID is not set";
    if (!process.env.POLAR_CLIENT_SECRET) return "POLAR_CLIENT_SECRET is not set";
    return null;
  }

  activityUrl(externalId: string): string {
    return `https://flow.polar.com/training/analysis/${externalId}`;
  }

  async registerWebhook(
    callbackUrl: string,
    _verifyToken: string,
  ): Promise<{ subscriptionId: string; signingSecret?: string; expiresAt?: Date }> {
    return this.#webhookService.registerWebhook(callbackUrl);
  }

  async unregisterWebhook(subscriptionId: string): Promise<void> {
    await this.#webhookService.unregisterWebhook(subscriptionId);
  }

  verifyWebhookSignature(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    signingSecret: string,
  ): boolean {
    return this.#webhookService.verifyWebhookSignature(rawBody, headers, signingSecret);
  }

  parseWebhookPayload(body: unknown): WebhookEvent[] {
    return this.#webhookService.parseWebhookPayload(body);
  }

  authSetup(options?: { host?: string }): ProviderAuthSetup {
    const config = polarOAuthConfig(options?.host);
    if (!config) throw new Error("POLAR_CLIENT_ID and POLAR_CLIENT_SECRET are required");
    const fetchFn = this.#fetchFn;

    return {
      oauthConfig: config,
      exchangeCode: async (code) => {
        const tokens = await exchangeCodeForTokens(config, code, fetchFn);

        // Polar AccessLink requires user registration (POST /v3/users)
        // after OAuth before data endpoints will work. Discover the Polar
        // user ID via GET /v3/users, then register.
        try {
          const client = new PolarClient(tokens.accessToken, fetchFn);
          const polarUserId = await client.getCurrentUserId();
          if (polarUserId) {
            await client.registerUser(polarUserId);
            logger.info(`[polar] Registered user ${polarUserId} with Polar AccessLink`);
          } else {
            logger.warn("[polar] Could not discover Polar user ID for post-auth registration");
          }
        } catch (registrationError) {
          // Registration is best-effort — log but don't fail the auth flow.
          // The user may already be registered from a previous authorization.
          logger.warn(
            `[polar] Post-auth user registration failed: ${registrationError instanceof Error ? registrationError.message : String(registrationError)}`,
          );
        }

        return tokens;
      },
      revokeExistingTokens: async (tokens) => {
        // Polar limits the number of active tokens per app+user. Before
        // exchanging a new code, deregister the old user to revoke the
        // existing token. This mirrors what Wahoo does.
        try {
          const client = new PolarClient(tokens.accessToken, fetchFn);
          const polarUserId = await client.getCurrentUserId();
          if (polarUserId) {
            await client.deregisterUser(polarUserId);
            logger.info(`[polar] Deregistered user ${polarUserId} to revoke old token`);
          } else {
            logger.warn(
              "[polar] Could not discover Polar user ID for deregistration — old token may be expired",
            );
          }
        } catch (revokeError) {
          // Best-effort — if the old token is completely dead, we can't revoke.
          // The user may need to contact Polar support.
          logger.warn(
            `[polar] Token revocation failed: ${revokeError instanceof Error ? revokeError.message : String(revokeError)}`,
          );
        }
      },
      apiBaseUrl: POLAR_API_BASE,
    };
  }

  async sync(db: SyncDatabase, since: Date, options?: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();
    const syncService = new PolarSyncService({
      db,
      providerId: this.id,
      providerName: this.name,
      fetchFn: this.#fetchFn,
      userId: options?.userId,
    });

    const result = await syncService.run(since);
    return {
      provider: this.id,
      recordsSynced: result.recordsSynced,
      errors: result.errors,
      duration: Date.now() - startTime,
    };
  }
}
