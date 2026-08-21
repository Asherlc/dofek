import { z } from "zod";
import type { TokenSet } from "../../auth/oauth.ts";
import { logger } from "../../logger.ts";
import type { SyncRun } from "../sync-run.ts";
import type { ProviderAuthSetup, SyncResult, WebhookEvent, WebhookProvider } from "../types.ts";
import { PolarClient } from "./client.ts";
import { POLAR_API_BASE, POLAR_TOKEN_URL, polarOAuthConfig } from "./oauth.ts";
import { PolarSyncService } from "./sync-service.ts";
import { PolarWebhookService } from "./webhook-service.ts";

/** Default expiry when Polar omits expires_in — 1 year (conservative). */
const DEFAULT_EXPIRES_IN_SECONDS = 365 * 24 * 60 * 60;
const polarTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  x_user_id: z
    .union([z.number().int().positive(), z.string().regex(/^[1-9][0-9]*$/)])
    .transform(String),
});

export class PolarProvider implements WebhookProvider {
  readonly id = "polar";
  readonly name = "Polar";
  readonly webhookScope = "app" as const;

  readonly #fetchFn: typeof globalThis.fetch;
  readonly #webhookService: PolarWebhookService;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = fetchFn;
    this.#webhookService = new PolarWebhookService(this.#fetchFn);
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
      reconnectStrategy: "revoke-then-replace",
      exchangeCode: async (code) => {
        // Inline token exchange to capture Polar's x_user_id (needed for
        // AccessLink registration). The shared exchangeCodeForTokens drops it.
        const params = new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: config.redirectUri,
        });
        const response = await fetchFn(POLAR_TOKEN_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
          },
          body: params.toString(),
        });
        if (!response.ok) {
          throw new Error(
            `Polar token exchange failed (${response.status}): ${await response.text()}`,
          );
        }

        const rawData: unknown = await response.json();
        if (typeof rawData !== "object" || rawData === null || !("x_user_id" in rawData)) {
          throw new Error(
            "Polar token response missing x_user_id — cannot complete AccessLink registration",
          );
        }
        const data = polarTokenResponseSchema.parse(rawData);
        const expiresIn =
          typeof data.expires_in === "number" ? data.expires_in : DEFAULT_EXPIRES_IN_SECONDS;
        const tokens: TokenSet = {
          accessToken: String(data.access_token),
          refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : null,
          expiresAt: new Date(Date.now() + expiresIn * 1000),
          providerAccountId: data.x_user_id,
          scopes: typeof data.scope === "string" ? data.scope : null,
        };

        // Polar AccessLink requires user registration (POST /v3/users)
        // after OAuth before data endpoints will work. The x_user_id from
        // the token response identifies the Polar user.
        //
        // Note: deregistration of the OLD user (to free the token slot) is
        // handled by revokeExistingTokens, which runs before exchangeCode
        // in the callback handler. We must NOT deregister with the NEW token
        // here — DELETE /v3/users/{id} revokes the calling token.
        const polarUserId = data.x_user_id;
        const client = new PolarClient(tokens.accessToken, fetchFn);
        await client.registerUser(polarUserId);
        logger.info(`[polar] Registered user ${polarUserId} with Polar AccessLink`);

        return tokens;
      },
      revokeExistingTokens: async (tokens) => {
        // Polar limits the number of active tokens per app+user. Before
        // exchanging a new code, deregister the old user to revoke the
        // existing token. This mirrors what Wahoo does.
        try {
          const client = new PolarClient(tokens.accessToken, fetchFn);
          const polarUserId = tokens.providerAccountId ?? (await client.getCurrentUserId());
          if (polarUserId) {
            await client.deregisterUser(polarUserId);
            logger.info(`[polar] Deregistered user ${polarUserId} to revoke old token`);
          } else {
            throw new Error(
              "Could not discover Polar user ID for deregistration; existing authorization was not confirmed revoked",
            );
          }
        } catch (revokeError) {
          logger.warn(
            `[polar] Token revocation failed: ${revokeError instanceof Error ? revokeError.message : String(revokeError)}`,
          );
          throw revokeError;
        }
      },
      revokeTokensForAccountErasure: async (tokens) => {
        if (!tokens.providerAccountId) {
          throw new Error(
            "Polar account erasure requires the provider account ID captured during OAuth.",
          );
        }
        const client = new PolarClient(tokens.accessToken, fetchFn);
        await client.deregisterUserForAccountErasure(tokens.providerAccountId);
        logger.info("[polar] Polar authorization revoked for account erasure");
      },
      apiBaseUrl: POLAR_API_BASE,
    };
  }

  async sync(run: SyncRun): Promise<SyncResult> {
    const { db, window, options } = run;
    const startTime = Date.now();
    const syncService = new PolarSyncService({
      db,
      providerId: this.id,
      providerName: this.name,
      fetchFn: this.#fetchFn,
      userId: options?.userId,
      metricStreamPublisher: options?.metricStreamPublisher,
    });

    const result = await syncService.run(window);
    return {
      provider: this.id,
      recordsSynced: result.recordsSynced,
      errors: result.errors,
      duration: Date.now() - startTime,
    };
  }
}
