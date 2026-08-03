import {
  type LegacyActivityType,
  type ProviderActivityType,
  resolveProviderActivityType,
} from "@dofek/training/activity-types";
import { z } from "zod";
import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import { exchangeCodeForTokens, getOAuthRedirectUri } from "../auth/oauth.ts";
import { resolveOAuthTokens } from "../auth/resolve-tokens.ts";
import type { SyncDatabase } from "../db/index.ts";
import {
  finishProviderActivityListSync,
  upsertProviderActivity,
} from "../db/provider-activity-sync.ts";
import { PartialSyncError, withSyncLog } from "../db/sync-log.ts";
import { ensureProvider } from "../db/tokens.ts";
import { createProviderRateLimitFetch } from "../lib/provider-rate-limit-fetch.ts";
import { fetchProviderPages } from "../sync/pagination.ts";
import type { SyncDegradation } from "../sync/sync-degradation.ts";
import type { SyncRun } from "./sync-run.ts";
import type { ProviderAuthSetup, SyncError, SyncProvider, SyncResult } from "./types.ts";

// ============================================================
// Komoot API types
// ============================================================

const KOMOOT_API_BASE = "https://external-api.komoot.de/v007";
const _DEFAULT_REDIRECT_URI = "https://localhost:9876/callback";

const komootTourSchema = z.object({
  id: z.number(),
  name: z.string(),
  sport: z.string(),
  date: z.string(),
  distance: z.number(),
  duration: z.number(),
  elevation_up: z.number().nullable().optional(),
  elevation_down: z.number().nullable().optional(),
  status: z.string(),
  type: z.string(),
});

type KomootTour = z.infer<typeof komootTourSchema>;

const komootToursResponseSchema = z.object({
  _embedded: z
    .object({
      tours: z.array(komootTourSchema).optional().default([]),
    })
    .optional()
    .default({ tours: [] }),
  page: z.object({
    size: z.number(),
    totalElements: z.number(),
    totalPages: z.number(),
    number: z.number(),
  }),
});

// ============================================================
// Parsed types
// ============================================================

export interface ParsedKomootTour {
  externalId: string;
  activityType: ProviderActivityType;
  name: string;
  startedAt: Date;
  endedAt: Date;
  raw: Record<string, unknown>;
}

// ============================================================
// Sport type mapping
// ============================================================

const KOMOOT_SPORT_MAP: Record<string, LegacyActivityType> = {
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

export function mapKomootSport(sport: string): ProviderActivityType {
  return resolveProviderActivityType(sport, KOMOOT_SPORT_MAP[sport] ?? "other");
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
    this.#fetchFn = createProviderRateLimitFetch("komoot", fetchFn);
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
    const revokeAuthorization = async (tokens: TokenSet): Promise<void> => {
      if (!tokens.refreshToken) {
        throw new Error(
          "Reconnect Komoot before deleting your account so Dofek can durably revoke the Komoot authorization.",
        );
      }
      const url = new URL(
        `https://auth-api.main.komoot.net/v1/clients/${encodeURIComponent(config.clientId)}/refresh_tokens/`,
      );
      url.searchParams.set("refresh_token", tokens.refreshToken);
      const response = await fetchFn(url, {
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
        },
        method: "DELETE",
      });
      if (response.status !== 200) {
        throw new Error(`Komoot authorization revocation failed (${response.status})`);
      }
    };
    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeCodeForTokens(config, code, fetchFn),
      revokeExistingTokens: revokeAuthorization,
      revokeTokensForAccountErasure: revokeAuthorization,
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

  async sync(run: SyncRun): Promise<SyncResult> {
    const { db, window, options } = run;
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

    const since = window.since;
    const syncWindowEnd = window.until;
    const presentActivityExternalIds = new Set<string>();
    const degradations: SyncDegradation[] = [];
    try {
      const activityCount = await withSyncLog(
        db,
        this.id,
        "activity",
        async () => {
          let count = 0;
          const startDate = since.toISOString();

          try {
            const pages = await fetchProviderPages<KomootTour, number>({
              providerId: this.id,
              stepName: "activity_list",
              initialCursor: 0,
              fetchPage: async (page) => {
                const currentPage = page ?? 0;
                const url = `${KOMOOT_API_BASE}/users/me/tours/?type=RECORDED&start_date=${startDate}&page=${currentPage}&limit=50&sort_field=date&sort_direction=desc`;
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

                const data = komootToursResponseSchema.parse(await response.json());
                const nextPage = currentPage + 1;
                return {
                  items: data._embedded.tours,
                  nextCursor: nextPage < data.page.totalPages ? nextPage : null,
                };
              },
              onPage: async (page) => {
                for (const raw of page.items) {
                  const parsed = parseKomootTour(raw);
                  if (parsed.startedAt.getTime() > syncWindowEnd.getTime()) {
                    continue;
                  }
                  presentActivityExternalIds.add(parsed.externalId);
                  try {
                    await upsertProviderActivity(
                      db,
                      {
                        providerId: this.id,
                        externalId: parsed.externalId,
                        activityType: parsed.activityType,
                        name: parsed.name,
                        startedAt: parsed.startedAt,
                        endedAt: parsed.endedAt,
                        raw: parsed.raw,
                      },
                      {
                        activityType: parsed.activityType,
                        name: parsed.name,
                        startedAt: parsed.startedAt,
                        endedAt: parsed.endedAt,
                        raw: parsed.raw,
                      },
                    );
                    count++;
                  } catch (err) {
                    errors.push({
                      message: err instanceof Error ? err.message : String(err),
                      externalId: parsed.externalId,
                      cause: err,
                    });
                  }
                }
              },
            });
            degradations.push(...pages.degradations);
          } catch (err) {
            throw new PartialSyncError(
              `activity: ${err instanceof Error ? err.message : String(err)}`,
              count,
              err,
            );
          }

          if (degradations.length === 0) {
            await finishProviderActivityListSync(db, {
              providerId: this.id,
              userId: options?.userId,
              windowStart: since,
              windowEnd: syncWindowEnd,
              presentExternalIds: presentActivityExternalIds,
            });
          }
          return { recordCount: count, result: count, degradations };
        },
        options?.userId,
      );
      recordsSynced += activityCount;
    } catch (err) {
      if (err instanceof PartialSyncError) {
        recordsSynced += err.recordCount;
      }
      errors.push({
        message: err instanceof Error ? err.message : String(err),
        cause: err instanceof PartialSyncError ? err.cause : err,
      });
    }

    return { provider: this.id, recordsSynced, errors, degradations, duration: Date.now() - start };
  }
}
