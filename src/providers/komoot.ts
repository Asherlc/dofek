import type { CanonicalActivityType } from "@dofek/training/training";
import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import { exchangeCodeForTokens, getOAuthRedirectUri } from "../auth/oauth.ts";
import { resolveOAuthTokens } from "../auth/resolve-tokens.ts";
import type { SyncDatabase } from "../db/index.ts";
import { activity } from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider } from "../db/tokens.ts";
import type {
  ProviderAuthSetup,
  SyncError,
  SyncOptions,
  SyncProvider,
  SyncResult,
} from "./types.ts";

// ============================================================
// Komoot API types
// ============================================================

const KOMOOT_API_BASE = "https://external-api.komoot.de/v007";
const _DEFAULT_REDIRECT_URI = "https://localhost:9876/callback";

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

export interface ParsedKomootTour {
  externalId: string;
  activityType: CanonicalActivityType;
  name: string;
  startedAt: Date;
  endedAt: Date;
  raw: Record<string, unknown>;
}

// ============================================================
// Sport type mapping
// ============================================================

const KOMOOT_SPORT_MAP: Record<string, CanonicalActivityType> = {
  BIKING: "cycling",
  E_BIKING: "e_bike_cycling",
  ROAD_CYCLING: "road_cycling",
  MT_BIKING: "mountain_biking",
  E_MT_BIKING: "mountain_biking",
  GRAVEL_BIKING: "gravel_cycling",
  E_BIKE_TOURING: "e_bike_cycling",
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

export function mapKomootSport(sport: string): CanonicalActivityType {
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

export function komootOAuthConfig(host?: string): OAuthConfig | null {
  const clientId = process.env.KOMOOT_CLIENT_ID;
  const clientSecret = process.env.KOMOOT_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  return {
    clientId,
    clientSecret,
    authorizeUrl: "https://auth.komoot.de/oauth/authorize",
    tokenUrl: "https://auth.komoot.de/oauth/token",
    redirectUri: getOAuthRedirectUri(host),
    scopes: ["profile"],
    tokenAuthMethod: "basic",
  };
}

// ============================================================
// Provider implementation
// ============================================================

export class KomootProvider implements SyncProvider {
  readonly id = "komoot";
  readonly name = "Komoot";
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = fetchFn;
  }

  validate(): string | null {
    if (!process.env.KOMOOT_CLIENT_ID) return "KOMOOT_CLIENT_ID is not set";
    if (!process.env.KOMOOT_CLIENT_SECRET) return "KOMOOT_CLIENT_SECRET is not set";
    return null;
  }

  activityUrl(externalId: string): string {
    return `https://www.komoot.com/tour/${externalId}`;
  }

  authSetup(options?: { host?: string }): ProviderAuthSetup {
    const config = komootOAuthConfig(options?.host);
    if (!config) throw new Error("KOMOOT_CLIENT_ID and CLIENT_SECRET required");
    const fetchFn = this.#fetchFn;
    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeCodeForTokens(config, code, fetchFn),
      apiBaseUrl: KOMOOT_API_BASE,
    };
  }

  async #resolveTokens(db: SyncDatabase): Promise<TokenSet> {
    return resolveOAuthTokens({
      db,
      providerId: this.id,
      providerName: this.name,
      getOAuthConfig: () => komootOAuthConfig(),
      fetchFn: this.#fetchFn,
    });
  }

  async sync(db: SyncDatabase, since: Date, options?: SyncOptions): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, KOMOOT_API_BASE);

    let accessToken: string;
    try {
      const tokens = await this.#resolveTokens(db);
      accessToken = tokens.accessToken;
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    try {
      const activityCount = await withSyncLog(
        db,
        this.id,
        "activity",
        async () => {
          let count = 0;
          let page = 0;
          let totalPages = 1;
          const startDate = since.toISOString();

          while (page < totalPages) {
            const url = `${KOMOOT_API_BASE}/users/me/tours/?type=RECORDED&start_date=${startDate}&page=${page}&limit=50&sort_field=date&sort_direction=desc`;
            const response = await this.#fetchFn(url, {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/hal+json",
              },
            });

            if (!response.ok) {
              const text = await response.text();
              throw new Error(`Komoot API error (${response.status}): ${text}`);
            }

            const data: KomootToursResponse = await response.json();
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
                    target: [activity.userId, activity.providerId, activity.externalId],
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
        },
        options?.userId,
      );
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
