import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import { exchangeCodeForTokens, refreshAccessToken } from "../auth/oauth.ts";
import type { Database } from "../db/index.ts";
import { activity } from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import type { Provider, ProviderAuthSetup, SyncError, SyncResult } from "./types.ts";

// ============================================================
// Suunto API types
// ============================================================

const SUUNTO_API_BASE = "https://cloudapi.suunto.com";
const DEFAULT_REDIRECT_URI = "https://localhost:9876/callback";

interface SuuntoWorkout {
  workoutKey: string;
  activityId: number;
  workoutName?: string;
  startTime: number; // UNIX milliseconds
  stopTime: number; // UNIX milliseconds
  totalTime: number; // seconds
  totalDistance: number; // meters
  totalAscent: number; // meters
  totalDescent: number; // meters
  avgSpeed: number; // m/s
  maxSpeed: number; // m/s
  energyConsumption: number; // kcal
  stepCount: number;
  hrdata?: {
    workoutAvgHR: number;
    workoutMaxHR: number;
  };
}

interface SuuntoWorkoutsResponse {
  payload: SuuntoWorkout[];
}

// ============================================================
// Parsed types
// ============================================================

interface ParsedSuuntoWorkout {
  externalId: string;
  activityType: string;
  name: string;
  startedAt: Date;
  endedAt: Date;
  raw: Record<string, unknown>;
}

// ============================================================
// Activity type mapping
// ============================================================

const SUUNTO_ACTIVITY_MAP: Record<number, string> = {
  1: "other",
  2: "running",
  3: "cycling",
  4: "cross_country_skiing",
  5: "other",
  11: "walking",
  12: "hiking",
  14: "strength",
  23: "yoga",
  27: "swimming",
  67: "trail_running",
  69: "rowing",
  82: "virtual_cycling",
  83: "virtual_running",
};

export function mapSuuntoActivityType(activityId: number): string {
  return SUUNTO_ACTIVITY_MAP[activityId] ?? "other";
}

export function parseSuuntoWorkout(workout: SuuntoWorkout): ParsedSuuntoWorkout {
  return {
    externalId: workout.workoutKey,
    activityType: mapSuuntoActivityType(workout.activityId),
    name: workout.workoutName ?? `Suunto ${mapSuuntoActivityType(workout.activityId)}`,
    startedAt: new Date(workout.startTime),
    endedAt: new Date(workout.stopTime),
    raw: {
      totalDistance: workout.totalDistance,
      totalTime: workout.totalTime,
      totalAscent: workout.totalAscent,
      totalDescent: workout.totalDescent,
      avgSpeed: workout.avgSpeed,
      maxSpeed: workout.maxSpeed,
      calories: workout.energyConsumption,
      steps: workout.stepCount,
      avgHeartRate: workout.hrdata?.workoutAvgHR,
      maxHeartRate: workout.hrdata?.workoutMaxHR,
    },
  };
}

// ============================================================
// OAuth configuration
// ============================================================

export function suuntoOAuthConfig(): OAuthConfig | null {
  const clientId = process.env.SUUNTO_CLIENT_ID;
  const clientSecret = process.env.SUUNTO_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const redirectUri = process.env.OAUTH_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;

  return {
    clientId,
    clientSecret,
    authorizeUrl: "https://cloudapi-oauth.suunto.com/oauth/authorize",
    tokenUrl: "https://cloudapi-oauth.suunto.com/oauth/token",
    redirectUri,
    scopes: ["workout"],
    tokenAuthMethod: "basic",
  };
}

// ============================================================
// Provider implementation
// ============================================================

export class SuuntoProvider implements Provider {
  readonly id = "suunto";
  readonly name = "Suunto";
  private fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.fetchFn = fetchFn;
  }

  validate(): string | null {
    if (!process.env.SUUNTO_CLIENT_ID) return "SUUNTO_CLIENT_ID is not set";
    if (!process.env.SUUNTO_CLIENT_SECRET) return "SUUNTO_CLIENT_SECRET is not set";
    if (!process.env.SUUNTO_SUBSCRIPTION_KEY) return "SUUNTO_SUBSCRIPTION_KEY is not set";
    return null;
  }

  authSetup(): ProviderAuthSetup {
    const config = suuntoOAuthConfig();
    if (!config) throw new Error("SUUNTO_CLIENT_ID and CLIENT_SECRET required");
    const fetchFn = this.fetchFn;
    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeCodeForTokens(config, code, fetchFn),
      apiBaseUrl: SUUNTO_API_BASE,
    };
  }

  private async resolveTokens(db: Database): Promise<TokenSet> {
    const tokens = await loadTokens(db, this.id);
    if (!tokens) throw new Error("No OAuth tokens for Suunto. Run: health-data auth suunto");
    if (tokens.expiresAt > new Date()) return tokens;

    console.log("[suunto] Token expired, refreshing...");
    const config = suuntoOAuthConfig();
    if (!config || !tokens.refreshToken) throw new Error("Cannot refresh Suunto tokens");
    const refreshed = await refreshAccessToken(config, tokens.refreshToken, this.fetchFn);
    await saveTokens(db, this.id, refreshed);
    return refreshed;
  }

  async sync(db: Database, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, SUUNTO_API_BASE);

    let accessToken: string;
    try {
      const tokens = await this.resolveTokens(db);
      accessToken = tokens.accessToken;
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const subscriptionKey = process.env.SUUNTO_SUBSCRIPTION_KEY ?? "";

    try {
      const activityCount = await withSyncLog(db, this.id, "activity", async () => {
        const sinceMs = since.getTime();
        const url = `${SUUNTO_API_BASE}/v2/workouts?since=${sinceMs}`;
        const response = await this.fetchFn(url, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Ocp-Apim-Subscription-Key": subscriptionKey,
            Accept: "application/json",
          },
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Suunto API error (${response.status}): ${text}`);
        }

        const data = (await response.json()) as SuuntoWorkoutsResponse;
        let count = 0;

        for (const raw of data.payload ?? []) {
          const parsed = parseSuuntoWorkout(raw);
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
