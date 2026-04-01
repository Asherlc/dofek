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
// Cycling Analytics API types
// ============================================================

const CYCLING_ANALYTICS_API_BASE = "https://www.cyclinganalytics.com/api";
const _DEFAULT_REDIRECT_URI = "https://localhost:9876/callback";

interface CyclingAnalyticsRide {
  id: number;
  title: string;
  date: string; // ISO datetime
  duration: number; // seconds
  distance?: number; // meters
  average_power?: number; // watts
  normalized_power?: number; // watts
  max_power?: number; // watts
  average_heart_rate?: number; // bpm
  max_heart_rate?: number; // bpm
  average_cadence?: number; // rpm
  max_cadence?: number; // rpm
  elevation_gain?: number; // meters
  elevation_loss?: number; // meters
  average_speed?: number; // m/s
  max_speed?: number; // m/s
  calories?: number;
  training_stress_score?: number;
  intensity_factor?: number;
}

interface CyclingAnalyticsRidesResponse {
  rides: CyclingAnalyticsRide[];
}

// ============================================================
// Parsed types
// ============================================================

export interface ParsedCyclingAnalyticsRide {
  externalId: string;
  activityType: CanonicalActivityType;
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
    activityType: "cycling",
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
      calories: ride.calories,
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
    scopes: [],
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
    this.#fetchFn = fetchFn;
  }

  validate(): string | null {
    if (!process.env.CYCLING_ANALYTICS_CLIENT_ID) return "CYCLING_ANALYTICS_CLIENT_ID is not set";
    if (!process.env.CYCLING_ANALYTICS_CLIENT_SECRET)
      return "CYCLING_ANALYTICS_CLIENT_SECRET is not set";
    return null;
  }

  activityUrl(externalId: string): string {
    return `https://www.cyclinganalytics.com/ride/${externalId}`;
  }

  authSetup(options?: { host?: string }): ProviderAuthSetup {
    const config = cyclingAnalyticsOAuthConfig(options?.host);
    if (!config) throw new Error("CYCLING_ANALYTICS_CLIENT_ID and CLIENT_SECRET required");
    const fetchFn = this.#fetchFn;
    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeCodeForTokens(config, code, fetchFn),
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

  async sync(db: SyncDatabase, since: Date, options?: SyncOptions): Promise<SyncResult> {
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

    try {
      const activityCount = await withSyncLog(
        db,
        this.id,
        "activity",
        async () => {
          let count = 0;
          let page = 0;
          let hasMore = true;

          while (hasMore) {
            const url = `${CYCLING_ANALYTICS_API_BASE}/me/rides?start_date=${since.toISOString()}&page=${page}&limit=50`;
            const response = await this.#fetchFn(url, {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/json",
              },
            });

            if (!response.ok) {
              const text = await response.text();
              throw new Error(`Cycling Analytics API error (${response.status}): ${text}`);
            }

            const data: CyclingAnalyticsRidesResponse = await response.json();
            const rides = data.rides ?? [];

            if (rides.length === 0) {
              hasMore = false;
              break;
            }

            for (const raw of rides) {
              const parsed = parseCyclingAnalyticsRide(raw);
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
