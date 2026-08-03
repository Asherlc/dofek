import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { z } from "zod";
import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import { getOAuthRedirectUri } from "../auth/oauth.ts";
import type { SyncDatabase } from "../db/index.ts";
import { writeMetricStreamBatch } from "../db/metric-stream-writer.ts";
import { SOURCE_TYPE_API } from "../db/sensor-channels.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { deleteTokens, ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import { captureException } from "../lib/error-reporting.ts";
import { createProviderRateLimitFetch } from "../lib/provider-rate-limit-fetch.ts";
import { isRetryableInfraError } from "../lib/retryable-infra-error.ts";
import { logger } from "../logger.ts";
import { fetchProviderPages } from "../sync/pagination.ts";
import { ProviderAuthenticationFailedError, RefreshTokenRevokedError } from "./auth-errors.ts";
import type { SyncRun } from "./sync-run.ts";
import type {
  ProviderAuthSetup,
  SyncError,
  SyncResult,
  WebhookEvent,
  WebhookProvider,
} from "./types.ts";

// ============================================================
// Withings API types
// ============================================================

export interface WithingsMeasure {
  type: number;
  value: number;
  unit: number; // actual = value * 10^unit
}

export interface WithingsMeasureGroup {
  grpid: number;
  date: number; // Unix seconds
  category: number; // 1 = real measurement, 2 = user objective
  measures: WithingsMeasure[];
}

// ============================================================
// Measurement type IDs
// ============================================================

const MEAS_WEIGHT = 1;
const MEAS_FAT_FREE_MASS = 5;
const MEAS_FAT_RATIO = 6;
const MEAS_FAT_MASS = 8;
const MEAS_DIASTOLIC_BP = 9;
const MEAS_SYSTOLIC_BP = 10;
const MEAS_HEART_PULSE = 11;
const MEAS_BODY_TEMP = 71;
const MEAS_SKIN_TEMP = 73;
const MEAS_MUSCLE_MASS = 76;
const MEAS_BONE_MASS = 88;

// ============================================================
// Parsing — pure functions
// ============================================================

function realValue(measure: WithingsMeasure): number {
  return measure.value * 10 ** measure.unit;
}

export interface ParsedBodyMeasurement {
  externalId: string;
  recordedAt: Date;
  weightKg?: number;
  bodyFatPct?: number;
  muscleMassKg?: number;
  boneMassKg?: number;
  waterPct?: number;
  bmi?: number;
  systolicBp?: number;
  diastolicBp?: number;
  heartPulse?: number;
  temperatureC?: number;
}

export function parseMeasureGroup(group: WithingsMeasureGroup): ParsedBodyMeasurement {
  const result: ParsedBodyMeasurement = {
    externalId: String(group.grpid),
    recordedAt: new Date(group.date * 1000),
  };

  // Skip user objectives — only parse real measurements
  if (group.category !== 1) return result;

  for (const m of group.measures) {
    const val = realValue(m);
    switch (m.type) {
      case MEAS_WEIGHT:
        result.weightKg = val;
        break;
      case MEAS_FAT_RATIO:
        result.bodyFatPct = val;
        break;
      case MEAS_MUSCLE_MASS:
        result.muscleMassKg = val;
        break;
      case MEAS_BONE_MASS:
        result.boneMassKg = val;
        break;
      case MEAS_SYSTOLIC_BP:
        result.systolicBp = Math.round(val);
        break;
      case MEAS_DIASTOLIC_BP:
        result.diastolicBp = Math.round(val);
        break;
      case MEAS_HEART_PULSE:
        result.heartPulse = Math.round(val);
        break;
      case MEAS_BODY_TEMP:
      case MEAS_SKIN_TEMP:
        result.temperatureC = val;
        break;
    }
  }

  return result;
}

// ============================================================
// Withings OAuth — has a quirk: needs action=requesttoken
// ============================================================

const WITHINGS_API_BASE = "https://wbsapi.withings.net";
const WITHINGS_AUTH_BASE = "https://account.withings.com";

class WithingsTokenError extends Error {
  #status: number;

  constructor(status: number, details?: string) {
    super(
      details
        ? `Withings token error (status ${status}): ${details}`
        : `Withings token error (status ${status})`,
    );
    this.name = "WithingsTokenError";
    this.#status = status;
  }

  get status(): number {
    return this.#status;
  }
}

class WithingsApiError extends Error {
  #status: number;

  constructor(status: number) {
    super(`Withings API error (status ${status})`);
    this.name = "WithingsApiError";
    this.#status = status;
  }

  get status(): number {
    return this.#status;
  }
}

function isWithingsAccessTokenRejected(error: unknown): boolean {
  return error instanceof WithingsApiError && error.status === 401;
}

function throwIfProviderSyncAbortError(error: unknown): void {
  if (isRetryableInfraError(error) || error instanceof ProviderRateLimitError) throw error;
}

export function withingsOAuthConfig(host?: string): OAuthConfig | null {
  const clientId = process.env.WITHINGS_CLIENT_ID;
  const clientSecret = process.env.WITHINGS_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    authorizeUrl: `${WITHINGS_AUTH_BASE}/oauth2_user/authorize2`,
    tokenUrl: `${WITHINGS_API_BASE}/v2/oauth2`,
    redirectUri: getOAuthRedirectUri(host),
    scopes: ["user.metrics"],
  };
}

/**
 * Withings token exchange requires action=requesttoken in the body.
 */
async function withingsTokenExchange(
  config: OAuthConfig,
  params: Record<string, string>,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<TokenSet> {
  const bodyParams: Record<string, string> = {
    action: "requesttoken",
    client_id: config.clientId,
    ...params,
  };
  if (config.clientSecret) bodyParams.client_secret = config.clientSecret;
  const body = new URLSearchParams(bodyParams);

  const response = await fetchFn(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Withings token request failed (${response.status}): ${text}`);
  }

  const json: { status: number; body: Record<string, unknown>; error?: unknown } =
    await response.json();
  if (json.status !== 0) {
    throw new WithingsTokenError(
      json.status,
      typeof json.error === "string" ? json.error : undefined,
    );
  }

  const data = json.body;
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 10800;
  const providerAccountId = z
    .union([z.string().min(1), z.number().int().nonnegative()])
    .safeParse(data.userid);

  return {
    accessToken: String(data.access_token),
    refreshToken: String(data.refresh_token),
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    ...(providerAccountId.success
      ? {
          providerAccountId: String(providerAccountId.data),
        }
      : {}),
    scopes: typeof data.scope === "string" ? data.scope : "",
  };
}

export async function exchangeWithingsCode(
  config: OAuthConfig,
  code: string,
  fetchFn?: typeof globalThis.fetch,
): Promise<TokenSet> {
  return withingsTokenExchange(
    config,
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
    },
    fetchFn,
  );
}

export async function refreshWithingsToken(
  config: OAuthConfig,
  refreshToken: string,
  fetchFn?: typeof globalThis.fetch,
): Promise<TokenSet> {
  return withingsTokenExchange(
    config,
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    },
    fetchFn,
  );
}

// ============================================================
// Withings API client
// ============================================================

export class WithingsClient {
  #accessToken: string;
  #fetchFn: typeof globalThis.fetch;

  constructor(accessToken: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#accessToken = accessToken;
    this.#fetchFn = fetchFn;
  }

  async #post<T>(path: string, params: Record<string, string>): Promise<T> {
    const body = new URLSearchParams(params);

    const response = await this.#fetchFn(`${WITHINGS_API_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Withings API error (${response.status}): ${text}`);
    }

    const json: { status: number; body: T } = await response.json();
    if (json.status !== 0) {
      throw new WithingsApiError(json.status);
    }

    return json.body;
  }

  async getMeas(
    startdate: number,
    enddate: number,
    offset = 0,
  ): Promise<{ measuregrps: WithingsMeasureGroup[]; more: number; offset: number }> {
    return this.#post("/measure", {
      action: "getmeas",
      meastype: [
        MEAS_WEIGHT,
        MEAS_FAT_RATIO,
        MEAS_FAT_FREE_MASS,
        MEAS_FAT_MASS,
        MEAS_MUSCLE_MASS,
        MEAS_BONE_MASS,
        MEAS_SYSTOLIC_BP,
        MEAS_DIASTOLIC_BP,
        MEAS_HEART_PULSE,
        MEAS_BODY_TEMP,
        MEAS_SKIN_TEMP,
      ].join(","),
      category: "1",
      startdate: String(startdate),
      enddate: String(enddate),
      offset: String(offset),
    });
  }
}

// ============================================================
// Provider implementation
// ============================================================

export class WithingsProvider implements WebhookProvider {
  readonly id = "withings";
  readonly name = "Withings";
  readonly webhookScope = "user" as const;
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = createProviderRateLimitFetch("withings", fetchFn);
  }

  validate(): string | null {
    if (!process.env.WITHINGS_CLIENT_ID) return "WITHINGS_CLIENT_ID is not set";
    if (!process.env.WITHINGS_CLIENT_SECRET) return "WITHINGS_CLIENT_SECRET is not set";
    return null;
  }

  // ── Webhook implementation ──

  async registerWebhook(
    _callbackUrl: string,
    _verifyToken: string,
  ): Promise<{ subscriptionId: string; signingSecret?: string; expiresAt?: Date }> {
    // Withings notification subscriptions are per-user and require the user's access token.
    // Registration happens via POST to /notify?action=subscribe.
    // This is a stub — actual per-user registration happens during sync setup.
    return { subscriptionId: "withings-user-subscription" };
  }

  async unregisterWebhook(_subscriptionId: string): Promise<void> {
    // Per-user subscriptions are revoked when the user disconnects
  }

  verifyWebhookSignature(
    _rawBody: Buffer,
    _headers: Record<string, string | string[] | undefined>,
    _signingSecret: string,
  ): boolean {
    // Withings does not sign webhook payloads.
    // Verification happens via the callback URL validation during subscription.
    return true;
  }

  parseWebhookPayload(body: unknown): WebhookEvent[] {
    // Withings sends form-encoded data that Express raw middleware captures.
    // The payload contains: userid, appli (data type), startdate, enddate
    const parsed = z
      .object({
        userid: z.coerce.string(),
        appli: z.number().optional(),
        startdate: z.number().optional(),
        enddate: z.number().optional(),
      })
      .safeParse(body);

    if (!parsed.success) return [];
    const event = parsed.data;

    // appli codes: 1=weight, 4=blood_pressure, 16=activity, 44=sleep, 54=spo2
    const appliTypeMap: Record<number, string> = {
      1: "weight",
      4: "blood_pressure",
      16: "activity",
      44: "sleep",
      54: "spo2",
    };

    return [
      {
        ownerExternalId: String(event.userid),
        eventType: "update",
        objectType: event.appli ? (appliTypeMap[event.appli] ?? "unknown") : "unknown",
      },
    ];
  }

  authSetup(options?: { host?: string }): ProviderAuthSetup {
    const config = withingsOAuthConfig(options?.host);
    if (!config) throw new Error("WITHINGS_CLIENT_ID and WITHINGS_CLIENT_SECRET are required");
    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeWithingsCode(config, code, this.#fetchFn),
      apiBaseUrl: WITHINGS_API_BASE,
    };
  }

  async #refreshTokens(db: SyncDatabase, tokens: TokenSet): Promise<TokenSet> {
    const config = withingsOAuthConfig();
    if (!config)
      throw new Error(
        "WITHINGS_CLIENT_ID and WITHINGS_CLIENT_SECRET are required to refresh tokens",
      );
    if (!tokens.refreshToken) throw new Error("No refresh token for Withings");
    try {
      const refreshed = await refreshWithingsToken(config, tokens.refreshToken, this.#fetchFn);
      await saveTokens(db, this.id, refreshed);
      return refreshed;
    } catch (error: unknown) {
      if (error instanceof WithingsTokenError && error.status === 503) {
        logger.warn(
          "[withings] Refresh token rejected by Withings, deleting stored tokens. " +
            "User must re-authorize Withings.",
        );
        await deleteTokens(db, this.id);
        throw new RefreshTokenRevokedError("Withings", { cause: error });
      }
      throw error;
    }
  }

  async #resolveTokens(db: SyncDatabase): Promise<TokenSet> {
    const tokens = await loadTokens(db, this.id);
    if (!tokens) {
      throw new ProviderAuthenticationFailedError(this.name);
    }

    if (tokens.expiresAt > new Date()) {
      return tokens;
    }

    logger.info("[withings] Access token expired, refreshing...");
    return this.#refreshTokens(db, tokens);
  }

  async sync(run: SyncRun): Promise<SyncResult> {
    const { db, window, options } = run;
    const since = window.since;
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, WITHINGS_API_BASE);

    let tokens: TokenSet;
    try {
      tokens = await this.#resolveTokens(db);
    } catch (err) {
      throwIfProviderSyncAbortError(err);
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    let client = new WithingsClient(tokens.accessToken, this.#fetchFn);
    const sinceUnix = Math.floor(since.getTime() / 1000);
    const nowUnix = Math.floor(Date.now() / 1000);
    let metricStreamRecordsSynced = 0;

    try {
      const measCount = await withSyncLog(
        db,
        this.id,
        "metric_stream",
        async () => {
          let count = 0;
          let refreshedAfterAccessTokenRejection = false;

          const pageResult = await fetchProviderPages<WithingsMeasureGroup, number>({
            providerId: this.id,
            stepName: "metric_stream",
            initialCursor: 0,
            fetchPage: async (offset) => {
              let response: Awaited<ReturnType<WithingsClient["getMeas"]>>;
              try {
                response = await client.getMeas(sinceUnix, nowUnix, offset ?? 0);
              } catch (err) {
                if (!refreshedAfterAccessTokenRejection && isWithingsAccessTokenRejected(err)) {
                  logger.info(
                    "[withings] Access token rejected by API, refreshing and retrying...",
                  );
                  tokens = await this.#refreshTokens(db, tokens);
                  client = new WithingsClient(tokens.accessToken, this.#fetchFn);
                  refreshedAfterAccessTokenRejection = true;
                  response = await client.getMeas(sinceUnix, nowUnix, offset ?? 0);
                } else {
                  throw err;
                }
              }

              for (const group of response.measuregrps) {
                const parsed = parseMeasureGroup(group);

                // Skip empty groups (objectives or unknown types)
                if (
                  parsed.weightKg === undefined &&
                  parsed.systolicBp === undefined &&
                  parsed.temperatureC === undefined
                ) {
                  continue;
                }

                try {
                  await writeMetricStreamBatch(
                    db,
                    [
                      {
                        providerId: this.id,
                        externalId: parsed.externalId,
                        recordedAt: parsed.recordedAt,
                        weightKg: parsed.weightKg,
                        bodyFatPct: parsed.bodyFatPct,
                        muscleMassKg: parsed.muscleMassKg,
                        boneMassKg: parsed.boneMassKg,
                        systolicBp: parsed.systolicBp,
                        diastolicBp: parsed.diastolicBp,
                        heartPulse: parsed.heartPulse,
                        temperatureC: parsed.temperatureC,
                      },
                    ],
                    SOURCE_TYPE_API,
                    undefined,
                    options?.metricStreamPublisher,
                  );
                  count++;
                  metricStreamRecordsSynced = count;
                } catch (err) {
                  throwIfProviderSyncAbortError(err);
                  captureException(err);
                  errors.push({
                    message: err instanceof Error ? err.message : String(err),
                    externalId: parsed.externalId,
                    cause: err,
                  });
                }
              }

              return {
                items: response.measuregrps,
                nextCursor: response.more ? response.offset : null,
              };
            },
          });

          return {
            recordCount: count,
            result: count,
            degradations: pageResult.degradations,
          };
        },
        options?.userId,
      );
      recordsSynced += measCount;
    } catch (err) {
      throwIfProviderSyncAbortError(err);
      recordsSynced += metricStreamRecordsSynced;
      errors.push({
        message: `metric_stream: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    return {
      provider: this.id,
      recordsSynced,
      errors,
      duration: Date.now() - start,
    };
  }
}
