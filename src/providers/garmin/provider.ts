import { z } from "zod";
import { refreshAccessToken, type TokenSet } from "../../auth/oauth.ts";
import type { SyncDatabase } from "../../db/index.ts";
import { deleteProviderAuthorization, loadTokens, saveTokens } from "../../db/tokens.ts";
import { createProviderRateLimitFetch } from "../../lib/provider-rate-limit-fetch.ts";
import {
  createProviderArtifactStorageFromEnv,
  type ProviderArtifactStorage,
} from "../../provider-artifact-storage.ts";
import { RefreshTokenRevokedError } from "../auth-errors.ts";
import type {
  ProviderAuthSetup,
  PushProvider,
  SyncOptions,
  SyncResult,
  SyncRun,
  WebhookEvent,
} from "../types.ts";
import { syncGarminActivityRecord } from "./activities.ts";
import { readGarminDeliveryState } from "./authorization.ts";
import { syncGarminHealthRecord } from "./health.ts";
import { createGarminAuthSetup, GARMIN_API_BASE } from "./oauth.ts";
import { parseGarminWebhookPayload } from "./payloads.ts";

const deliverySchema = z.object({
  authorizationId: z.uuid(),
  providerDataGeneration: z.number().int().nonnegative(),
  payload: z.record(z.string(), z.unknown()),
});
const permissionsSchema = z.object({ permissions: z.array(z.string()) });

export class GarminProvider implements PushProvider {
  readonly id = "garmin";
  readonly name = "Garmin Connect";
  readonly pushOnly = true;
  readonly #fetchFn: typeof globalThis.fetch;
  readonly #artifacts: () => ProviderArtifactStorage;

  constructor(
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
    artifacts: () => ProviderArtifactStorage = createProviderArtifactStorageFromEnv,
  ) {
    this.#fetchFn = createProviderRateLimitFetch(this.id, fetchFn);
    this.#artifacts = artifacts;
  }

  validate(): string | null {
    const missing = ["GARMIN_CLIENT_ID", "GARMIN_CLIENT_SECRET"].filter(
      (key) => !process.env[key]?.trim(),
    );
    if (Buffer.byteLength(process.env.GARMIN_WEBHOOK_SECRET ?? "") < 32)
      missing.push("GARMIN_WEBHOOK_SECRET");
    return missing.length > 0 ? `Required Garmin configuration: ${missing.join(", ")}` : null;
  }

  activityUrl(externalId: string): string {
    return `https://connect.garmin.com/modern/activity/${encodeURIComponent(externalId)}`;
  }

  authSetup(options?: { host?: string }): ProviderAuthSetup | undefined {
    if (!process.env.GARMIN_CLIENT_ID?.trim() || !process.env.GARMIN_CLIENT_SECRET?.trim())
      return undefined;
    return createGarminAuthSetup(this.#fetchFn, options?.host);
  }

  parseWebhookPayload(body: unknown): WebhookEvent[] {
    return parseGarminWebhookPayload(body);
  }

  async sync(_run: SyncRun): Promise<SyncResult> {
    throw new Error("Garmin sends new data automatically. Sync your device in Garmin Connect.");
  }

  async #refresh(db: SyncDatabase, userId: string, tokens: TokenSet): Promise<TokenSet> {
    if (tokens.expiresAt.getTime() > Date.now()) return tokens;
    const config = this.authSetup()?.oauthConfig;
    if (!config || !tokens.refreshToken)
      throw new Error("Garmin authorization expired. Reconnect Garmin.");
    const refreshed = await refreshAccessToken(config, tokens.refreshToken, async (input, init) => {
      const response = await this.#fetchFn(input, init);
      if (!response.ok && response.headers.get("content-type")?.includes("application/json")) {
        const failure = z.object({ error: z.string() }).safeParse(await response.clone().json());
        if (failure.success && failure.data.error === "invalid_grant")
          throw new RefreshTokenRevokedError(this.name);
      }
      return response;
    });
    // Partner token scopes are transport scopes; retain the user's actual export permissions.
    const current = { ...tokens, ...refreshed, scopes: tokens.scopes };
    await saveTokens(db, this.id, current, userId);
    return current;
  }

  async syncWebhookEvent(
    db: SyncDatabase,
    event: WebhookEvent,
    options: SyncOptions = {},
  ): Promise<SyncResult> {
    const start = Date.now();
    const result = (recordsSynced = 0): SyncResult => ({
      provider: this.id,
      recordsSynced,
      errors: [],
      duration: Date.now() - start,
    });
    const userId = options.userId?.trim();
    if (!userId) throw new Error("Garmin notification processing requires userId");
    const delivery = deliverySchema.parse(event.metadata);
    let tokens = await loadTokens(db, this.id, userId);
    if (
      !tokens ||
      tokens.providerAccountId !== event.ownerExternalId ||
      tokens.authorizationId !== delivery.authorizationId
    )
      return result();
    const state = await readGarminDeliveryState(db, userId);
    if (state.generation !== delivery.providerDataGeneration) return result();
    if (state.pendingDeletion)
      throw new Error(
        "Garmin provider data deletion must complete before this notification can run",
      );

    if (event.objectType === "userPermissionsChange" || event.objectType === "deregistrations") {
      // Read current consent: notifications from a prior grant can arrive after reconnect.
      try {
        tokens = await this.#refresh(db, userId, tokens);
      } catch (error) {
        if (event.objectType !== "deregistrations" || !(error instanceof RefreshTokenRevokedError))
          throw error;
        await deleteProviderAuthorization(db, this.id, userId);
        return result();
      }
      const response = await this.#fetchFn(`${GARMIN_API_BASE}/user/permissions`, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      });
      if (
        event.objectType === "deregistrations" &&
        (response.status === 401 || response.status === 403)
      ) {
        await deleteProviderAuthorization(db, this.id, userId);
        return result();
      }
      if (!response.ok) throw new Error(`Garmin permissions request failed (${response.status})`);
      const { permissions } = permissionsSchema.parse(await response.json());
      await saveTokens(db, this.id, { ...tokens, scopes: permissions.join(" ") }, userId);
      return result();
    }

    const granted = new Set(tokens.scopes?.split(" ") ?? []);
    switch (event.objectType) {
      case "dailies":
      case "sleeps":
      case "hrv":
      case "pulseox":
      case "allDayRespiration":
        if (!granted.has("HEALTH_EXPORT")) return result();
        return result(
          await syncGarminHealthRecord(db, event.objectType, delivery.payload, options),
        );
      case "activities":
      case "manuallyUpdatedActivities":
      case "activityFiles":
        if (!granted.has("ACTIVITY_EXPORT")) return result();
        if (event.objectType === "activityFiles") tokens = await this.#refresh(db, userId, tokens);
        return result(
          await syncGarminActivityRecord(db, event.objectType, delivery.payload, options, {
            artifacts: this.#artifacts(),
            fetchFn: this.#fetchFn,
            accessToken: tokens.accessToken,
          }),
        );
      default:
        throw new Error(`Unsupported Garmin notification: ${event.objectType}`);
    }
  }
}
