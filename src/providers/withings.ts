import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import { getOAuthRedirectUri } from "../auth/oauth.ts";
import type { SyncDatabase } from "../db/index.ts";
import { bodyMeasurement } from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import type { Provider, ProviderAuthSetup, SyncError, SyncResult } from "./types.ts";

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

export function withingsOAuthConfig(): OAuthConfig | null {
  const clientId = process.env.WITHINGS_CLIENT_ID;
  const clientSecret = process.env.WITHINGS_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    authorizeUrl: `${WITHINGS_AUTH_BASE}/oauth2_user/authorize2`,
    tokenUrl: `${WITHINGS_API_BASE}/v2/oauth2`,
    redirectUri: getOAuthRedirectUri(),
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

  const json: { status: number; body: Record<string, unknown> } = await response.json();
  if (json.status !== 0) {
    throw new Error(`Withings token error (status ${json.status})`);
  }

  const data = json.body;
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 10800;

  return {
    accessToken: String(data.access_token),
    refreshToken: String(data.refresh_token),
    expiresAt: new Date(Date.now() + expiresIn * 1000),
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
  private accessToken: string;
  private fetchFn: typeof globalThis.fetch;

  constructor(accessToken: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.accessToken = accessToken;
    this.fetchFn = fetchFn;
  }

  private async post<T>(path: string, params: Record<string, string>): Promise<T> {
    const body = new URLSearchParams(params);

    const response = await this.fetchFn(`${WITHINGS_API_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
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
      throw new Error(`Withings API error (status ${json.status})`);
    }

    return json.body;
  }

  async getMeas(
    startdate: number,
    enddate: number,
    offset = 0,
  ): Promise<{ measuregrps: WithingsMeasureGroup[]; more: number; offset: number }> {
    return this.post("/measure", {
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

export class WithingsProvider implements Provider {
  readonly id = "withings";
  readonly name = "Withings";
  private fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.fetchFn = fetchFn;
  }

  validate(): string | null {
    if (!process.env.WITHINGS_CLIENT_ID) return "WITHINGS_CLIENT_ID is not set";
    if (!process.env.WITHINGS_CLIENT_SECRET) return "WITHINGS_CLIENT_SECRET is not set";
    return null;
  }

  authSetup(): ProviderAuthSetup {
    const config = withingsOAuthConfig();
    if (!config) throw new Error("WITHINGS_CLIENT_ID and WITHINGS_CLIENT_SECRET are required");
    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeWithingsCode(config, code),
      apiBaseUrl: WITHINGS_API_BASE,
    };
  }

  private async resolveTokens(db: SyncDatabase): Promise<TokenSet> {
    const tokens = await loadTokens(db, this.id);
    if (!tokens) {
      throw new Error("No OAuth tokens found for Withings. Run: health-data auth withings");
    }

    if (tokens.expiresAt > new Date()) {
      return tokens;
    }

    console.log("[withings] Access token expired, refreshing...");
    const config = withingsOAuthConfig();
    if (!config)
      throw new Error(
        "WITHINGS_CLIENT_ID and WITHINGS_CLIENT_SECRET are required to refresh tokens",
      );
    if (!tokens.refreshToken) throw new Error("No refresh token for Withings");
    const refreshed = await refreshWithingsToken(config, tokens.refreshToken, this.fetchFn);
    await saveTokens(db, this.id, refreshed);
    return refreshed;
  }

  async sync(db: SyncDatabase, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, WITHINGS_API_BASE);

    let tokens: TokenSet;
    try {
      tokens = await this.resolveTokens(db);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const client = new WithingsClient(tokens.accessToken, this.fetchFn);
    const sinceUnix = Math.floor(since.getTime() / 1000);
    const nowUnix = Math.floor(Date.now() / 1000);

    try {
      const measCount = await withSyncLog(db, this.id, "body_measurement", async () => {
        let count = 0;
        let offset = 0;
        let more = 1;

        while (more) {
          const response = await client.getMeas(sinceUnix, nowUnix, offset);

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
              await db
                .insert(bodyMeasurement)
                .values({
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
                })
                .onConflictDoUpdate({
                  target: [bodyMeasurement.providerId, bodyMeasurement.externalId],
                  set: {
                    weightKg: parsed.weightKg,
                    bodyFatPct: parsed.bodyFatPct,
                    muscleMassKg: parsed.muscleMassKg,
                    boneMassKg: parsed.boneMassKg,
                    systolicBp: parsed.systolicBp,
                    diastolicBp: parsed.diastolicBp,
                    heartPulse: parsed.heartPulse,
                    temperatureC: parsed.temperatureC,
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

          more = response.more;
          offset = response.offset;
        }

        return { recordCount: count, result: count };
      });
      recordsSynced += measCount;
    } catch (err) {
      errors.push({
        message: `body_measurement: ${err instanceof Error ? err.message : String(err)}`,
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
