import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import { exchangeCodeForTokens, refreshAccessToken } from "../auth/oauth.ts";
import type { SyncDatabase } from "../db/index.ts";
import { activity } from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import type { Provider, ProviderAuthSetup, SyncError, SyncResult } from "./types.ts";

// ============================================================
// Decathlon API types
// ============================================================

const DECATHLON_API_BASE = "https://api.decathlon.net/sportstrackingdata/v2";
const DEFAULT_REDIRECT_URI = "https://localhost:9876/callback";

interface DecathlonActivity {
  id: string;
  name: string;
  sport: string; // e.g. "/v2/sports/{id}"
  startdate: string; // ISO datetime
  duration: number; // seconds
  dataSummaries: DecathlonDataSummary[];
}

interface DecathlonDataSummary {
  id: number;
  value: number;
  // Common datatype IDs:
  // 5 = distance (km), 9 = calories (kcal),
  // 1 = avg HR, 2 = max HR, 24 = duration (s)
}

interface DecathlonActivitiesResponse {
  data: DecathlonActivity[];
  links?: {
    next?: string;
  };
}

// ============================================================
// Parsed types
// ============================================================

export interface ParsedDecathlonActivity {
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

// Decathlon sport IDs mapped to normalized activity types
const DECATHLON_SPORT_MAP: Record<string, string> = {
  "381": "running",
  "121": "cycling",
  "153": "mountain_biking",
  "320": "walking",
  "110": "hiking",
  "274": "trail_running",
  "260": "swimming",
  "79": "cross_country_skiing",
  "173": "rowing",
  "263": "open_water_swimming",
  "91": "skiing",
  "174": "indoor_rowing",
  "395": "yoga",
  "105": "gym",
  "264": "triathlon",
  "292": "skating",
  "160": "climbing",
  "100": "cross_training",
  "367": "elliptical",
  "176": "strength_training",
};

export function mapDecathlonSport(sportUri: string): string {
  // Sport URI is like "/v2/sports/381" — extract the ID
  const sportId = sportUri.split("/").pop() ?? "";
  return DECATHLON_SPORT_MAP[sportId] ?? "other";
}

export function parseDecathlonActivity(act: DecathlonActivity): ParsedDecathlonActivity {
  const startedAt = new Date(act.startdate);
  const endedAt = new Date(startedAt.getTime() + act.duration * 1000);

  const summaries: Record<string, number> = {};
  for (const summary of act.dataSummaries ?? []) {
    summaries[String(summary.id)] = summary.value;
  }

  return {
    externalId: String(act.id),
    activityType: mapDecathlonSport(act.sport),
    name: act.name,
    startedAt,
    endedAt,
    raw: {
      sport: act.sport,
      duration: act.duration,
      distanceKm: summaries["5"],
      calories: summaries["9"],
      avgHeartRate: summaries["1"],
      maxHeartRate: summaries["2"],
      dataSummaries: act.dataSummaries,
    },
  };
}

// ============================================================
// OAuth configuration
// ============================================================

export function decathlonOAuthConfig(): OAuthConfig | null {
  const clientId = process.env.DECATHLON_CLIENT_ID;
  const clientSecret = process.env.DECATHLON_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const redirectUri = process.env.OAUTH_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;

  return {
    clientId,
    clientSecret,
    authorizeUrl: "https://api.decathlon.net/connect/oauth/authorize",
    tokenUrl: "https://api.decathlon.net/connect/oauth/token",
    redirectUri,
    scopes: ["openid", "profile"],
  };
}

// ============================================================
// Provider implementation
// ============================================================

export class DecathlonProvider implements Provider {
  readonly id = "decathlon";
  readonly name = "Decathlon";
  private fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.fetchFn = fetchFn;
  }

  validate(): string | null {
    if (!process.env.DECATHLON_CLIENT_ID) return "DECATHLON_CLIENT_ID is not set";
    if (!process.env.DECATHLON_CLIENT_SECRET) return "DECATHLON_CLIENT_SECRET is not set";
    return null;
  }

  authSetup(): ProviderAuthSetup {
    const config = decathlonOAuthConfig();
    if (!config) throw new Error("DECATHLON_CLIENT_ID and CLIENT_SECRET required");
    const fetchFn = this.fetchFn;
    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeCodeForTokens(config, code, fetchFn),
      apiBaseUrl: DECATHLON_API_BASE,
    };
  }

  private async resolveTokens(db: SyncDatabase): Promise<TokenSet> {
    const tokens = await loadTokens(db, this.id);
    if (!tokens) throw new Error("No OAuth tokens for Decathlon. Run: health-data auth decathlon");
    if (tokens.expiresAt > new Date()) return tokens;

    console.log("[decathlon] Token expired, refreshing...");
    const config = decathlonOAuthConfig();
    if (!config || !tokens.refreshToken) throw new Error("Cannot refresh Decathlon tokens");
    const refreshed = await refreshAccessToken(config, tokens.refreshToken, this.fetchFn);
    await saveTokens(db, this.id, refreshed);
    return refreshed;
  }

  async sync(db: SyncDatabase, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, DECATHLON_API_BASE);

    let accessToken: string;
    try {
      const tokens = await this.resolveTokens(db);
      accessToken = tokens.accessToken;
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const clientId = process.env.DECATHLON_CLIENT_ID;

    try {
      const activityCount = await withSyncLog(db, this.id, "activity", async () => {
        let count = 0;
        let nextUrl: string | undefined =
          `${DECATHLON_API_BASE}/activities?after=${since.toISOString()}&limit=50`;

        while (nextUrl) {
          const response = await this.fetchFn(nextUrl, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: "application/json",
              ...(clientId ? { "x-api-key": clientId } : {}),
            },
          });

          if (!response.ok) {
            const text = await response.text();
            throw new Error(`Decathlon API error (${response.status}): ${text}`);
          }

          const data: DecathlonActivitiesResponse = await response.json();
          const activities = data.data ?? [];
          nextUrl = data.links?.next;

          for (const raw of activities) {
            const parsed = parseDecathlonActivity(raw);
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
