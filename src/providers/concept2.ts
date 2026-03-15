import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import { exchangeCodeForTokens, refreshAccessToken } from "../auth/oauth.ts";
import type { Database } from "../db/index.ts";
import { activity } from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import type { Provider, ProviderAuthSetup, SyncError, SyncResult } from "./types.ts";

// ============================================================
// Concept2 Logbook API types
// ============================================================

const CONCEPT2_API_BASE = "https://log.concept2.com";
const DEFAULT_REDIRECT_URI = "https://localhost:9876/callback";

interface Concept2Result {
  id: number;
  type: string; // "rower", "skierg", "bikerg"
  date: string; // "YYYY-MM-DD HH:mm:ss"
  distance: number; // meters
  time: number; // tenths of a second
  time_formatted: string;
  stroke_rate: number;
  stroke_count: number;
  heart_rate?: {
    average?: number;
    max?: number;
    min?: number;
  };
  calories_total?: number;
  drag_factor?: number;
  weight_class: string;
  workout_type: string;
  comments?: string;
  privacy: string;
  splits?: Array<{
    distance: number;
    time: number;
    stroke_rate: number;
    heart_rate?: number;
  }>;
}

interface Concept2ResultsResponse {
  data: Concept2Result[];
  meta: {
    pagination: {
      total: number;
      count: number;
      per_page: number;
      current_page: number;
      total_pages: number;
    };
  };
}

// ============================================================
// Parsed types
// ============================================================

export interface ParsedConcept2Result {
  externalId: string;
  activityType: string;
  name: string;
  startedAt: Date;
  endedAt: Date;
  raw: Record<string, unknown>;
}

// ============================================================
// Parsing
// ============================================================

export function mapConcept2Type(type: string): string {
  switch (type.toLowerCase()) {
    case "rower":
      return "rowing";
    case "skierg":
      return "skiing";
    case "bikerg":
      return "cycling";
    default:
      return "rowing";
  }
}

export function parseConcept2Result(result: Concept2Result): ParsedConcept2Result {
  const startedAt = new Date(result.date);
  const durationMs = (result.time / 10) * 1000; // tenths of a second to ms
  const endedAt = new Date(startedAt.getTime() + durationMs);

  return {
    externalId: String(result.id),
    activityType: mapConcept2Type(result.type),
    name: `${result.type.charAt(0).toUpperCase() + result.type.slice(1)} ${result.workout_type}`,
    startedAt,
    endedAt,
    raw: {
      type: result.type,
      distance: result.distance,
      timeFormatted: result.time_formatted,
      strokeRate: result.stroke_rate,
      strokeCount: result.stroke_count,
      avgHeartRate: result.heart_rate?.average,
      maxHeartRate: result.heart_rate?.max,
      calories: result.calories_total,
      dragFactor: result.drag_factor,
      workoutType: result.workout_type,
      weightClass: result.weight_class,
    },
  };
}

// ============================================================
// OAuth configuration
// ============================================================

export function concept2OAuthConfig(): OAuthConfig | null {
  const clientId = process.env.CONCEPT2_CLIENT_ID;
  const clientSecret = process.env.CONCEPT2_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const redirectUri = process.env.OAUTH_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;

  return {
    clientId,
    clientSecret,
    authorizeUrl: `${CONCEPT2_API_BASE}/oauth/authorize`,
    tokenUrl: `${CONCEPT2_API_BASE}/oauth/access_token`,
    redirectUri,
    scopes: ["user:read", "results:read"],
  };
}

// ============================================================
// Provider implementation
// ============================================================

export class Concept2Provider implements Provider {
  readonly id = "concept2";
  readonly name = "Concept2";
  private fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.fetchFn = fetchFn;
  }

  validate(): string | null {
    if (!process.env.CONCEPT2_CLIENT_ID) return "CONCEPT2_CLIENT_ID is not set";
    if (!process.env.CONCEPT2_CLIENT_SECRET) return "CONCEPT2_CLIENT_SECRET is not set";
    return null;
  }

  authSetup(): ProviderAuthSetup {
    const config = concept2OAuthConfig();
    if (!config) throw new Error("CONCEPT2_CLIENT_ID and CLIENT_SECRET required");
    const fetchFn = this.fetchFn;
    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeCodeForTokens(config, code, fetchFn),
      apiBaseUrl: CONCEPT2_API_BASE,
    };
  }

  private async resolveTokens(db: Database): Promise<TokenSet> {
    const tokens = await loadTokens(db, this.id);
    if (!tokens) throw new Error("No OAuth tokens for Concept2. Run: health-data auth concept2");
    if (tokens.expiresAt > new Date()) return tokens;

    console.log("[concept2] Token expired, refreshing...");
    const config = concept2OAuthConfig();
    if (!config || !tokens.refreshToken) throw new Error("Cannot refresh Concept2 tokens");
    const refreshed = await refreshAccessToken(config, tokens.refreshToken, this.fetchFn);
    await saveTokens(db, this.id, refreshed);
    return refreshed;
  }

  async sync(db: Database, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, CONCEPT2_API_BASE);

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
        let page = 1;
        let totalPages = 1;
        const sinceDate = since.toISOString().slice(0, 10);

        while (page <= totalPages) {
          const url = `${CONCEPT2_API_BASE}/api/users/me/results?from=${sinceDate}&page=${page}`;
          const response = await this.fetchFn(url, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: "application/json",
            },
          });

          if (!response.ok) {
            const text = await response.text();
            throw new Error(`Concept2 API error (${response.status}): ${text}`);
          }

          const data = (await response.json()) as Concept2ResultsResponse;
          totalPages = data.meta.pagination.total_pages;

          for (const raw of data.data) {
            const parsed = parseConcept2Result(raw);
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
