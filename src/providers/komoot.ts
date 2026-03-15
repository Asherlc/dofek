import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import { exchangeCodeForTokens, refreshAccessToken } from "../auth/oauth.ts";
import type { Database } from "../db/index.ts";
import { activity } from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import type { Provider, ProviderAuthSetup, SyncError, SyncResult } from "./types.ts";

// ============================================================
// Komoot API types
// ============================================================

const KOMOOT_API_BASE = "https://external-api.komoot.de/v007";
const DEFAULT_REDIRECT_URI = "https://localhost:9876/callback";

interface KomootTour {
  id: number;
  name: string;
  sport: string;
  date: string; // ISO datetime
  distance: number; // meters
  duration: number; // seconds
  elevation_up?: number; // meters
  elevation_down?: number; // meters
  status: string; // "public", "private"
  type: string; // "tour_recorded", "tour_planned"
}

interface KomootToursResponse {
  _embedded: {
    tours: KomootTour[];
  };
  page: {
    size: number;
    totalElements: number;
    totalPages: number;
    number: number;
  };
}

// ============================================================
// Parsed types
// ============================================================

interface ParsedKomootTour {
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

const KOMOOT_SPORT_MAP: Record<string, string> = {
  BIKING: "cycling",
  E_BIKING: "cycling",
  ROAD_CYCLING: "cycling",
  MT_BIKING: "mountain_biking",
  E_MT_BIKING: "mountain_biking",
  GRAVEL_BIKING: "cycling",
  E_BIKE_TOURING: "cycling",
  RUNNING: "running",
  TRAIL_RUNNING: "trail_running",
  HIKING: "hiking",
  WALKING: "walking",
  CLIMBING: "climbing",
  SKIING: "skiing",
  CROSS_COUNTRY_SKIING: "cross_country_skiing",
  SNOWSHOEING: "snowshoeing",
  PADDLING: "paddling",
  INLINE_SKATING: "skating",
};

export function mapKomootSport(sport: string): string {
  return KOMOOT_SPORT_MAP[sport] ?? "other";
}

export function parseKomootTour(tour: KomootTour): ParsedKomootTour {
  const startedAt = new Date(tour.date);
  const endedAt = new Date(startedAt.getTime() + tour.duration * 1000);

  return {
    externalId: String(tour.id),
    activityType: mapKomootSport(tour.sport),
    name: tour.name,
    startedAt,
    endedAt,
    raw: {
      sport: tour.sport,
      distance: tour.distance,
      duration: tour.duration,
      elevationUp: tour.elevation_up,
      elevationDown: tour.elevation_down,
      status: tour.status,
      type: tour.type,
    },
  };
}

// ============================================================
// OAuth configuration
// ============================================================

export function komootOAuthConfig(): OAuthConfig | null {
  const clientId = process.env.KOMOOT_CLIENT_ID;
  const clientSecret = process.env.KOMOOT_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const redirectUri = process.env.OAUTH_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;

  return {
    clientId,
    clientSecret,
    authorizeUrl: "https://auth.komoot.de/oauth/authorize",
    tokenUrl: "https://auth.komoot.de/oauth/token",
    redirectUri,
    scopes: ["profile"],
    tokenAuthMethod: "basic",
  };
}

// ============================================================
// Provider implementation
// ============================================================

export class KomootProvider implements Provider {
  readonly id = "komoot";
  readonly name = "Komoot";
  private fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.fetchFn = fetchFn;
  }

  validate(): string | null {
    if (!process.env.KOMOOT_CLIENT_ID) return "KOMOOT_CLIENT_ID is not set";
    if (!process.env.KOMOOT_CLIENT_SECRET) return "KOMOOT_CLIENT_SECRET is not set";
    return null;
  }

  authSetup(): ProviderAuthSetup {
    const config = komootOAuthConfig();
    if (!config) throw new Error("KOMOOT_CLIENT_ID and CLIENT_SECRET required");
    const fetchFn = this.fetchFn;
    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeCodeForTokens(config, code, fetchFn),
      apiBaseUrl: KOMOOT_API_BASE,
    };
  }

  private async resolveTokens(db: Database): Promise<TokenSet> {
    const tokens = await loadTokens(db, this.id);
    if (!tokens) throw new Error("No OAuth tokens for Komoot. Run: health-data auth komoot");
    if (tokens.expiresAt > new Date()) return tokens;

    console.log("[komoot] Token expired, refreshing...");
    const config = komootOAuthConfig();
    if (!config || !tokens.refreshToken) throw new Error("Cannot refresh Komoot tokens");
    const refreshed = await refreshAccessToken(config, tokens.refreshToken, this.fetchFn);
    await saveTokens(db, this.id, refreshed);
    return refreshed;
  }

  async sync(db: Database, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, KOMOOT_API_BASE);

    let accessToken: string;
    try {
      const tokens = await this.resolveTokens(db);
      accessToken = tokens.accessToken;
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    try {
      const activityCount = await withSyncLog(db, this.id, "activity", async () => {
        let count = 0;
        let page = 0;
        let totalPages = 1;
        const startDate = since.toISOString();

        while (page < totalPages) {
          const url = `${KOMOOT_API_BASE}/users/me/tours/?type=RECORDED&start_date=${startDate}&page=${page}&limit=50&sort_field=date&sort_direction=desc`;
          const response = await this.fetchFn(url, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: "application/hal+json",
            },
          });

          if (!response.ok) {
            const text = await response.text();
            throw new Error(`Komoot API error (${response.status}): ${text}`);
          }

          const data = (await response.json()) as KomootToursResponse;
          totalPages = data.page.totalPages;
          const tours = data._embedded?.tours ?? [];

          for (const raw of tours) {
            const parsed = parseKomootTour(raw);
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
