import {
  resolveProviderActivityType,
  type ProviderActivityType,
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
import { ProviderTokenRejectedError } from "./auth-errors.ts";
import type { SyncRun } from "./sync-run.ts";
import type { ProviderAuthSetup, SyncError, SyncProvider, SyncResult } from "./types.ts";

// ============================================================
// Cycling Analytics API types
// ============================================================

const CYCLING_ANALYTICS_API_BASE = "https://www.cyclinganalytics.com/api";
const _DEFAULT_REDIRECT_URI = "https://localhost:9876/callback";

const parseableIsoDateTimeSchema = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid ISO datetime");

const cyclingAnalyticsRideSchema = z.object({
  id: z.number(),
  title: z.string(),
  date: parseableIsoDateTimeSchema,
  duration: z.number(),
  distance: z.number().optional(),
  average_power: z.number().optional(),
  normalized_power: z.number().optional(),
  max_power: z.number().optional(),
  average_heart_rate: z.number().optional(),
  max_heart_rate: z.number().optional(),
  average_cadence: z.number().optional(),
  max_cadence: z.number().optional(),
  elevation_gain: z.number().optional(),
  elevation_loss: z.number().optional(),
  average_speed: z.number().optional(),
  max_speed: z.number().optional(),
  training_stress_score: z.number().optional(),
  intensity_factor: z.number().optional(),
});

type CyclingAnalyticsRide = z.infer<typeof cyclingAnalyticsRideSchema>;

const cyclingAnalyticsRidesResponseSchema = z.object({
  rides: z.preprocess((value) => value ?? [], z.array(cyclingAnalyticsRideSchema)),
});

// ============================================================
// Parsed types
// ============================================================

export interface ParsedCyclingAnalyticsRide {
  externalId: string;
  activityType: ProviderActivityType;
  name: string;
  startedAt: Date;
  endedAt: Date;
  raw: Record<string, unknown>;
}

// ============================================================
// Parsing functions
// ============================================================

export function parseCyclingAnalyticsRide(ride: CyclingAnalyticsRide): ParsedCyclingAnalyticsRide {
  const startedAt = new Date(ride.date);
  const endedAt = new Date(startedAt.getTime() + ride.duration * 1000);

  return {
    externalId: String(ride.id),
    activityType: resolveProviderActivityType("cycling", "cycling"),
    name: ride.title,
    startedAt,
    endedAt,
    raw: {
      duration: ride.duration,
      distance: ride.distance,
      averagePower: ride.average_power,
      normalizedPower: ride.normalized_power,
      maxPower: ride.max_power,
      averageHeartRate: ride.average_heart_rate,
      maxHeartRate: ride.max_heart_rate,
      averageCadence: ride.average_cadence,
      maxCadence: ride.max_cadence,
      elevationGain: ride.elevation_gain,
      elevationLoss: ride.elevation_loss,
      averageSpeed: ride.average_speed,
      maxSpeed: ride.max_speed,
      trainingStressScore: ride.training_stress_score,
      intensityFactor: ride.intensity_factor,
    },
  };
}

// ============================================================
// OAuth configuration
// ============================================================

export function cyclingAnalyticsOAuthConfig(host?: string): OAuthConfig | null {
  const clientId = process.env.CYCLING_ANALYTICS_CLIENT_ID;
  const clientSecret = process.env.CYCLING_ANALYTICS_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  return {
    clientId,
    clientSecret,
    authorizeUrl: "https://www.cyclinganalytics.com/api/auth",
    tokenUrl: "https://www.cyclinganalytics.com/api/token",
    redirectUri: getOAuthRedirectUri(host),
    scopes: ["read_rides"],
    scopeSeparator: ",",
  };
}

// ============================================================
// Provider implementation
// ============================================================

export class CyclingAnalyticsProvider implements SyncProvider {
  readonly id = "cycling_analytics";
  readonly name = "Cycling Analytics";
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = createProviderRateLimitFetch("cycling_analytics", fetchFn);
  }

  validate(): string | null {
    return null;
  }

  activityUrl(externalId: string): string {
    return `https://www.cyclinganalytics.com/ride/${externalId}`;
  }

  authSetup(options?: { host?: string }): ProviderAuthSetup {
    const config = cyclingAnalyticsOAuthConfig(options?.host);
    const fetchFn = this.#fetchFn;
    const manualToken = {
      label: "Personal API token",
      instructionsUrl: "https://www.cyclinganalytics.com/developer/api/authentication",
      exchangeToken: async (token: string): Promise<TokenSet> => {
        const response = await fetchFn(`${CYCLING_ANALYTICS_API_BASE}/me/rides?limit=1`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
        });
        if (response.status === 401 || response.status === 403) {
          throw new ProviderTokenRejectedError(
            this.name,
            "Create a personal token with read_rides permission and try again.",
          );
        }
        if (!response.ok) {
          throw new Error(
            `Cycling Analytics token validation failed (${response.status}). Try again.`,
          );
        }
        return {
          accessToken: token,
          refreshToken: null,
          expiresAt: new Date("2099-12-31T00:00:00.000Z"),
          scopes: "read_rides",
        };
      },
    } satisfies NonNullable<ProviderAuthSetup["manualToken"]>;

    if (!config) {
      return {
        manualToken,
        apiBaseUrl: CYCLING_ANALYTICS_API_BASE,
      };
    }

    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeCodeForTokens(config, code, fetchFn),
      manualToken,
      apiBaseUrl: CYCLING_ANALYTICS_API_BASE,
    };
  }

  async #resolveTokens(db: SyncDatabase): Promise<TokenSet> {
    return resolveOAuthTokens({
      db,
      providerId: this.id,
      providerName: this.name,
      getOAuthConfig: () => cyclingAnalyticsOAuthConfig(),
      fetchFn: this.#fetchFn,
    });
  }

  async sync(run: SyncRun): Promise<SyncResult> {
    const { db, window, options } = run;
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, CYCLING_ANALYTICS_API_BASE);

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

          try {
            const pages = await fetchProviderPages<CyclingAnalyticsRide, number>({
              providerId: this.id,
              stepName: "activity_list",
              initialCursor: 0,
              fetchPage: async (page) => {
                const currentPage = page ?? 0;
                const url = `${CYCLING_ANALYTICS_API_BASE}/me/rides?start_date=${since.toISOString()}&page=${currentPage}&limit=50`;
                const response = await this.#fetchFn(url, {
                  headers: {
                    Authorization: `Bearer ${accessToken}`,
                    Accept: "application/json",
                  },
                });

                if (response.status === 401 || response.status === 403) {
                  throw new ProviderTokenRejectedError(
                    this.name,
                    "Create a personal token with read_rides permission and reconnect.",
                  );
                }
                if (!response.ok) {
                  const text = await response.text();
                  throw new Error(`Cycling Analytics API error (${response.status}): ${text}`);
                }

                const data = cyclingAnalyticsRidesResponseSchema.parse(await response.json());
                return {
                  items: data.rides,
                  nextCursor: data.rides.length > 0 ? currentPage + 1 : null,
                };
              },
              onPage: async (page) => {
                for (const raw of page.items) {
                  const parsed = parseCyclingAnalyticsRide(raw);
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
