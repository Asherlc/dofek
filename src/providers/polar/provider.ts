import { exchangeCodeForTokens } from "../../auth/oauth.ts";
import type { SyncDatabase } from "../../db/index.ts";
import type {
  ProviderAuthSetup,
  SyncOptions,
  SyncResult,
  WebhookEvent,
  WebhookProvider,
} from "../types.ts";
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

    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeCodeForTokens(config, code),
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
