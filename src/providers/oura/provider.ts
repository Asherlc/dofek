import { z } from "zod";
import { exchangeCodeForTokens } from "../../auth/oauth.ts";
import { resolveOAuthTokens } from "../../auth/resolve-tokens.ts";
import type { SyncDatabase } from "../../db/index.ts";
import { ensureProvider } from "../../db/tokens.ts";
import type {
  ProviderAuthSetup,
  ProviderIdentity,
  SyncError,
  SyncOptions,
  SyncResult,
  WebhookEvent,
  WebhookProvider,
} from "../types.ts";
import { OURA_API_BASE, OuraClient } from "./client.ts";
import { formatDate, ouraOAuthConfig } from "./oauth.ts";
import {
  syncCardiovascularAge,
  syncDailyMetricsComposite,
  syncDailyResilience,
  syncDailyResilienceWebhook,
  syncDailyStress,
  syncDailyStressWebhook,
  syncEnhancedTags,
  syncHeartRate,
  syncRestMode,
  syncSessions,
  syncSleep,
  syncSleepTime,
  syncTags,
  syncWorkouts,
} from "./sync-steps.ts";

export class OuraProvider implements WebhookProvider {
  readonly id = "oura";
  readonly name = "Oura";
  readonly webhookScope = "app" as const;
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = fetchFn;
  }

  validate(): string | null {
    if (!process.env.OURA_CLIENT_ID) return "OURA_CLIENT_ID is not set";
    if (!process.env.OURA_CLIENT_SECRET) return "OURA_CLIENT_SECRET is not set";
    return null;
  }

  // ── Webhook implementation ──

  async registerWebhook(
    callbackUrl: string,
    verifyToken: string,
  ): Promise<{ subscriptionId: string; signingSecret?: string; expiresAt?: Date }> {
    const clientId = process.env.OURA_CLIENT_ID;
    const clientSecret = process.env.OURA_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("OURA_CLIENT_ID and OURA_CLIENT_SECRET are required");
    }

    // Oura requires one subscription per data type. We register for all supported types.
    const dataTypes = [
      "daily_activity",
      "daily_readiness",
      "daily_sleep",
      "workout",
      "session",
      "daily_spo2",
      "daily_stress",
      "daily_resilience",
    ];

    let subscriptionId = "";
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // ~30 days

    for (const dataType of dataTypes) {
      const response = await this.#fetchFn("https://api.ouraring.com/v2/webhook/subscription", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-client-id": clientId,
          "x-client-secret": clientSecret,
        },
        body: JSON.stringify({
          callback_url: callbackUrl,
          verification_token: verifyToken,
          event_type: `create.${dataType}`,
          data_type: dataType,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        // 409 means subscription already exists — continue
        if (response.status !== 409) {
          throw new Error(
            `Oura webhook registration for ${dataType} failed (${response.status}): ${text}`,
          );
        }
      } else {
        const data: { id?: string } = await response.json();
        if (data.id && !subscriptionId) subscriptionId = data.id;
      }
    }

    return { subscriptionId: subscriptionId || "oura-multi-subscription", expiresAt };
  }

  async unregisterWebhook(subscriptionId: string): Promise<void> {
    const clientId = process.env.OURA_CLIENT_ID;
    const clientSecret = process.env.OURA_CLIENT_SECRET;
    if (!clientId || !clientSecret) return;

    await this.#fetchFn(`https://api.ouraring.com/v2/webhook/subscription/${subscriptionId}`, {
      method: "DELETE",
      headers: {
        "x-client-id": clientId,
        "x-client-secret": clientSecret,
      },
    });
  }

  verifyWebhookSignature(
    _rawBody: Buffer,
    _headers: Record<string, string | string[] | undefined>,
    _signingSecret: string,
  ): boolean {
    // Oura verifies via the verification_token challenge at registration time.
    // Incoming events are trusted after successful registration.
    return true;
  }

  parseWebhookPayload(body: unknown): WebhookEvent[] {
    // Oura sends a single event or a verification challenge
    const verificationCheck = z.object({ verification_token: z.string() }).safeParse(body);

    // Verification challenge — not a real event
    if (verificationCheck.success) return [];

    const parsed = z
      .object({
        event_type: z.string().optional(),
        data_type: z.string(),
        user_id: z.string(),
      })
      .safeParse(body);

    if (!parsed.success) return [];
    const event = parsed.data;

    return [
      {
        ownerExternalId: event.user_id,
        eventType: "create",
        objectType: event.data_type,
      },
    ];
  }

  handleValidationChallenge(_query: Record<string, string>, _verifyToken: string): unknown | null {
    // Oura uses POST for verification (sends verification_token in body).
    // This is handled in the POST path — parseWebhookPayload returns empty for verification.
    return null;
  }

  authSetup(options?: { host?: string }): ProviderAuthSetup {
    const config = ouraOAuthConfig(options?.host);
    if (!config) throw new Error("OURA_CLIENT_ID and OURA_CLIENT_SECRET are required");
    const fetchFn = this.#fetchFn;

    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeCodeForTokens(config, code, fetchFn),
      apiBaseUrl: OURA_API_BASE,
      getUserIdentity: async (accessToken: string): Promise<ProviderIdentity> => {
        const response = await fetchFn(`${OURA_API_BASE}/v2/usercollection/personal_info`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Oura personal info API error (${response.status}): ${text}`);
        }
        const ouraPersonalInfoSchema = z.object({
          id: z.string(),
          email: z.string().nullish(),
        });
        const data = ouraPersonalInfoSchema.parse(await response.json());
        return {
          providerAccountId: data.id,
          email: data.email ?? null,
          name: null,
        };
      },
    };
  }

  async #resolveAccessToken(db: SyncDatabase): Promise<string> {
    const tokens = await resolveOAuthTokens({
      db,
      providerId: this.id,
      providerName: this.name,
      getOAuthConfig: () => ouraOAuthConfig(),
      fetchFn: this.#fetchFn,
    });
    return tokens.accessToken;
  }

  async sync(db: SyncDatabase, since: Date, options?: SyncOptions): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, OURA_API_BASE);

    let accessToken: string;
    try {
      accessToken = await this.#resolveAccessToken(db);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const client = new OuraClient(accessToken, this.#fetchFn);
    const sinceDate = formatDate(since);
    const todayDate = formatDate(new Date());

    const context = {
      db,
      providerId: this.id,
      client,
      sinceDate,
      todayDate,
      errors,
      options,
    };

    // 1. Sync sleep sessions
    recordsSynced += await syncSleep(context);

    // 2. Sync workouts → activity table
    recordsSynced += await syncWorkouts(context);

    // 3. Sync sessions (meditation, breathing, etc.) → activity table
    recordsSynced += await syncSessions(context);

    // 4. Sync heart rate → sensor_sample table (batched)
    recordsSynced += await syncHeartRate(context, since);

    // 5. Sync daily stress → healthEvent table
    recordsSynced += await syncDailyStress(context);

    // 6. Sync daily resilience → healthEvent table
    recordsSynced += await syncDailyResilience(context);

    // 7. Sync daily cardiovascular age → healthEvent table
    recordsSynced += await syncCardiovascularAge(context);

    // 8. Sync tags → healthEvent table
    recordsSynced += await syncTags(context);

    // 9. Sync enhanced tags → healthEvent table
    recordsSynced += await syncEnhancedTags(context);

    // 10. Sync rest mode periods → healthEvent table
    recordsSynced += await syncRestMode(context);

    // 11. Sync sleep time recommendations → healthEvent table
    recordsSynced += await syncSleepTime(context);

    // 12. Sync daily metrics (readiness + activity + SpO2 + VO2 max + stress + resilience merged by day)
    recordsSynced += await syncDailyMetricsComposite(context, true);

    return {
      provider: this.id,
      recordsSynced,
      errors,
      duration: Date.now() - start,
    };
  }

  // ── Webhook-triggered targeted sync ──

  async syncWebhookEvent(
    db: SyncDatabase,
    event: WebhookEvent,
    options?: SyncOptions,
  ): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, OURA_API_BASE);

    let accessToken: string;
    try {
      accessToken = await this.#resolveAccessToken(db);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const client = new OuraClient(accessToken, this.#fetchFn);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const sinceDate = formatDate(yesterday);
    const todayDate = formatDate(new Date());
    const dataType = event.objectType;

    const context = {
      db,
      providerId: this.id,
      client,
      sinceDate,
      todayDate,
      errors,
      options,
    };

    // Sync the specific data type that the webhook reported
    switch (dataType) {
      case "workout": {
        recordsSynced += await syncWorkouts(context);
        break;
      }

      case "session": {
        recordsSynced += await syncSessions(context);
        break;
      }

      case "sleep":
      case "daily_sleep": {
        recordsSynced += await syncSleep(context);
        break;
      }

      case "daily_stress": {
        // Sync stress healthEvents
        recordsSynced += await syncDailyStressWebhook(context);

        // Also refresh daily metrics composite (stress columns merge into daily_metrics row)
        recordsSynced += await syncDailyMetricsComposite(context, false);
        break;
      }

      case "daily_resilience": {
        // Sync resilience healthEvents
        recordsSynced += await syncDailyResilienceWebhook(context);

        // Also refresh daily metrics composite (resilience columns merge into daily_metrics row)
        recordsSynced += await syncDailyMetricsComposite(context, false);
        break;
      }

      case "daily_activity":
      case "daily_readiness":
      case "daily_spo2": {
        // These types only contribute to the daily_metrics composite row
        recordsSynced += await syncDailyMetricsComposite(context, false);
        break;
      }

      default: {
        // Unknown data type — no-op, return empty result
        break;
      }
    }

    return {
      provider: this.id,
      recordsSynced,
      errors,
      duration: Date.now() - start,
    };
  }
}
