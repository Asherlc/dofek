import { z } from "zod";
import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import { getOAuthRedirectUri } from "../auth/oauth.ts";
import { resolveOAuthTokens } from "../auth/resolve-tokens.ts";
import type { SyncDatabase } from "../db/index.ts";
import { activity } from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider } from "../db/tokens.ts";
import type { ProviderAuthSetup, SyncError, SyncProvider, SyncResult } from "./types.ts";

// ============================================================
// Xert API types
// ============================================================

const XERT_API_BASE = "https://www.xertonline.com";

interface XertActivity {
  id: number;
  name: string;
  sport: string;
  startTimestamp: number; // Unix timestamp (seconds)
  endTimestamp: number; // Unix timestamp (seconds)
  duration: number; // seconds
  distance: number; // meters
  power_avg: number; // watts
  power_max: number; // watts
  power_normalized: number; // watts
  heartrate_avg: number; // bpm
  heartrate_max: number; // bpm
  cadence_avg: number; // rpm
  cadence_max: number; // rpm
  calories: number;
  elevation_gain: number; // meters
  elevation_loss: number; // meters
  xss: number; // Xert Strain Score
  focus: number; // focus (power duration)
  difficulty: number;
}

// ============================================================
// Parsed types
// ============================================================

export interface ParsedXertActivity {
  externalId: string;
  activityType: string;
  name: string;
  startedAt: Date;
  endedAt: Date;
  raw: Record<string, unknown>;
}

// ============================================================
// Sport type mapping
// ============================================================

const XERT_SPORT_MAP: Record<string, string> = {
  Cycling: "cycling",
  Running: "running",
  Swimming: "swimming",
  Walking: "walking",
  Hiking: "hiking",
  Rowing: "rowing",
  Skiing: "skiing",
  "Virtual Cycling": "cycling",
  "Mountain Biking": "mountain_biking",
  "Trail Running": "trail_running",
  "Cross Country Skiing": "cross_country_skiing",
};

export function mapXertSport(sport: string): string {
  return XERT_SPORT_MAP[sport] ?? "other";
}

export function parseXertActivity(raw: XertActivity): ParsedXertActivity {
  const startedAt = new Date(raw.startTimestamp * 1000);
  const endedAt = new Date(raw.endTimestamp * 1000);

  return {
    externalId: String(raw.id),
    activityType: mapXertSport(raw.sport),
    name: raw.name,
    startedAt,
    endedAt,
    raw: {
      sport: raw.sport,
      duration: raw.duration,
      distance: raw.distance,
      powerAvg: raw.power_avg,
      powerMax: raw.power_max,
      powerNormalized: raw.power_normalized,
      heartrateAvg: raw.heartrate_avg,
      heartrateMax: raw.heartrate_max,
      cadenceAvg: raw.cadence_avg,
      cadenceMax: raw.cadence_max,
      calories: raw.calories,
      elevationGain: raw.elevation_gain,
      elevationLoss: raw.elevation_loss,
      xss: raw.xss,
      focus: raw.focus,
      difficulty: raw.difficulty,
    },
  };
}

// ============================================================
// Token response schema (Zod — runtime boundary)
// ============================================================

const XertTokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  token_type: z.string().optional(),
});

/** Default expiry when the provider omits `expires_in` — 1 year. */
const DEFAULT_EXPIRES_IN_SECONDS = 365 * 24 * 60 * 60;

/**
 * Sign in to Xert using the password grant.
 * Xert does not support the OAuth authorization code flow —
 * it only supports `grant_type=password` with Basic auth.
 */
export async function signInToXert(
  email: string,
  password: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<TokenSet> {
  const clientId = process.env.XERT_CLIENT_ID ?? "xert_public";
  const clientSecret = process.env.XERT_CLIENT_SECRET ?? "xert_public";

  const params = new URLSearchParams({
    grant_type: "password",
    username: email,
    password: password,
  });

  const response = await fetchFn(`${XERT_API_BASE}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Xert sign-in failed (${response.status}): ${text}`);
  }

  const data: unknown = await response.json();
  const parsed = XertTokenResponseSchema.parse(data);

  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? null,
    expiresAt: new Date(Date.now() + (parsed.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS) * 1000),
    scopes: null,
  };
}

// ============================================================
// OAuth configuration (used for token refresh)
// ============================================================

export function xertOAuthConfig(): OAuthConfig | null {
  const clientId = process.env.XERT_CLIENT_ID ?? "xert_public";
  const clientSecret = process.env.XERT_CLIENT_SECRET ?? "xert_public";
  const redirectUri = getOAuthRedirectUri();

  return {
    clientId,
    clientSecret,
    authorizeUrl: `${XERT_API_BASE}/oauth/authorize`,
    tokenUrl: `${XERT_API_BASE}/oauth/token`,
    redirectUri,
    scopes: [],
    tokenAuthMethod: "basic",
  };
}

// ============================================================
// Provider implementation
// ============================================================

export class XertProvider implements SyncProvider {
  readonly id = "xert";
  readonly name = "Xert";
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = fetchFn;
  }

  validate(): string | null {
    // Xert uses public client credentials by default, so no env vars strictly required.
    // But we still need OAuth tokens to have been obtained via the auth flow.
    return null;
  }

  authSetup(): ProviderAuthSetup {
    const config = xertOAuthConfig();
    if (!config) throw new Error("Failed to create Xert OAuth config");
    const fetchFn = this.#fetchFn;
    return {
      oauthConfig: config,
      automatedLogin: (email, password) => signInToXert(email, password, fetchFn),
      exchangeCode: async () => {
        throw new Error("Xert uses automated login, not OAuth code exchange");
      },
      apiBaseUrl: XERT_API_BASE,
    };
  }

  async #resolveTokens(db: SyncDatabase): Promise<TokenSet> {
    return resolveOAuthTokens({
      db,
      providerId: this.id,
      providerName: this.name,
      getOAuthConfig: () => xertOAuthConfig(),
      fetchFn: this.#fetchFn,
    });
  }

  async sync(db: SyncDatabase, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, XERT_API_BASE);

    let accessToken: string;
    try {
      const tokens = await this.#resolveTokens(db);
      accessToken = tokens.accessToken;
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    try {
      const activityCount = await withSyncLog(db, this.id, "activity", async () => {
        let count = 0;
        let page = 0;
        let hasMore = true;
        const pageSize = 50;

        while (hasMore) {
          const url = `${XERT_API_BASE}/oauth/activity/?from=${Math.floor(since.getTime() / 1000)}&page=${page}&limit=${pageSize}`;
          const response = await this.#fetchFn(url, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: "application/json",
            },
          });

          if (!response.ok) {
            const text = await response.text();
            throw new Error(`Xert API error (${response.status}): ${text}`);
          }

          const data: XertActivity[] = await response.json();
          hasMore = data.length >= pageSize;

          for (const rawActivity of data) {
            const parsed = parseXertActivity(rawActivity);
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

          page++;
        }

        return { recordCount: count, result: count };
      });
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
