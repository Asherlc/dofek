import type { CanonicalActivityType } from "@dofek/training/training";
import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import { exchangeCodeForTokens } from "../auth/oauth.ts";
import { resolveOAuthTokens } from "../auth/resolve-tokens.ts";
import type { SyncDatabase } from "../db/index.ts";
import { activity, bodyMeasurement } from "../db/schema.ts";
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
// Wger API types
// ============================================================

const WGER_API_BASE = "https://wger.de/api/v2";
const DEFAULT_REDIRECT_URI = "https://localhost:9876/callback";

interface WgerWorkoutSession {
  id: number;
  date: string; // YYYY-MM-DD
  comment: string;
  impression: string; // e.g. "1" = general, "2" = neutral, etc.
  time_start: string | null;
  time_end: string | null;
}

interface WgerWeightEntry {
  id: number;
  date: string; // YYYY-MM-DD
  weight: string; // decimal as string
}

interface WgerPaginatedResponse<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

// ============================================================
// Parsed types
// ============================================================

export interface ParsedWgerWorkoutSession {
  externalId: string;
  activityType: CanonicalActivityType;
  name: string;
  startedAt: Date;
  raw: Record<string, unknown>;
}

export interface ParsedWgerWeightEntry {
  externalId: string;
  recordedAt: Date;
  weightKg: number;
}

// ============================================================
// Pure parsing functions (exported for testing)
// ============================================================

export function parseWgerWorkoutSession(session: WgerWorkoutSession): ParsedWgerWorkoutSession {
  return {
    externalId: String(session.id),
    activityType: "strength",
    name: session.comment || "Workout",
    startedAt: new Date(session.date),
    raw: {
      comment: session.comment,
      impression: session.impression,
      timeStart: session.time_start,
      timeEnd: session.time_end,
    },
  };
}

export function parseWgerWeightEntry(entry: WgerWeightEntry): ParsedWgerWeightEntry {
  return {
    externalId: String(entry.id),
    recordedAt: new Date(entry.date),
    weightKg: Number.parseFloat(entry.weight),
  };
}

// ============================================================
// OAuth configuration
// ============================================================

export function wgerOAuthConfig(host?: string): OAuthConfig | null {
  const clientId = process.env.WGER_CLIENT_ID;
  const clientSecret = process.env.WGER_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const redirectUri = process.env.OAUTH_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;

  return {
    clientId,
    clientSecret,
    authorizeUrl: "https://wger.de/en/user/authorize",
    tokenUrl: "https://wger.de/api/v2/token",
    redirectUri,
    scopes: ["read"],
  };
}

// ============================================================
// Provider implementation
// ============================================================

export class WgerProvider implements SyncProvider {
  readonly id = "wger";
  readonly name = "Wger";
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = fetchFn;
  }

  validate(): string | null {
    if (!process.env.WGER_CLIENT_ID) return "WGER_CLIENT_ID is not set";
    if (!process.env.WGER_CLIENT_SECRET) return "WGER_CLIENT_SECRET is not set";
    return null;
  }

  authSetup(options?: { host?: string }): ProviderAuthSetup {
    const config = wgerOAuthConfig(options?.host);
    if (!config) throw new Error("WGER_CLIENT_ID and CLIENT_SECRET required");
    const fetchFn = this.#fetchFn;
    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeCodeForTokens(config, code, fetchFn),
      apiBaseUrl: WGER_API_BASE,
    };
  }

  async #resolveTokens(db: SyncDatabase): Promise<TokenSet> {
    return resolveOAuthTokens({
      db,
      providerId: this.id,
      providerName: this.name,
      getOAuthConfig: () => wgerOAuthConfig(),
      fetchFn: this.#fetchFn,
    });
  }

  async sync(db: SyncDatabase, since: Date, options?: SyncOptions): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, WGER_API_BASE);

    let accessToken: string;
    try {
      const tokens = await this.#resolveTokens(db);
      accessToken = tokens.accessToken;
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    // Sync workout sessions → activity table
    try {
      const activityCount = await withSyncLog(
        db,
        this.id,
        "activity",
        async () => {
          let count = 0;
          let url: string | null =
            `${WGER_API_BASE}/workoutsession/?format=json&ordering=-date&offset=0&limit=50`;

          while (url) {
            const response = await this.#fetchFn(url, {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/json",
              },
            });

            if (!response.ok) {
              const text = await response.text();
              throw new Error(`Wger API error (${response.status}): ${text}`);
            }

            const data: WgerPaginatedResponse<WgerWorkoutSession> = await response.json();
            const sessions = data.results ?? [];

            for (const raw of sessions) {
              const sessionDate = new Date(raw.date);
              if (sessionDate < since) {
                url = null;
                break;
              }

              const parsed = parseWgerWorkoutSession(raw);
              try {
                await db
                  .insert(activity)
                  .values({
                    providerId: this.id,
                    externalId: parsed.externalId,
                    activityType: parsed.activityType,
                    name: parsed.name,
                    startedAt: parsed.startedAt,
                    raw: parsed.raw,
                  })
                  .onConflictDoUpdate({
                    target: [activity.providerId, activity.externalId],
                    set: {
                      activityType: parsed.activityType,
                      name: parsed.name,
                      startedAt: parsed.startedAt,
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

            if (url) {
              url = data.next;
            }
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

    // Sync body weight → bodyMeasurement table
    try {
      const weightCount = await withSyncLog(
        db,
        this.id,
        "bodyMeasurement",
        async () => {
          let count = 0;
          let url: string | null =
            `${WGER_API_BASE}/weightentry/?format=json&ordering=-date&offset=0&limit=50`;

          while (url) {
            const response = await this.#fetchFn(url, {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/json",
              },
            });

            if (!response.ok) {
              const text = await response.text();
              throw new Error(`Wger API error (${response.status}): ${text}`);
            }

            const data: WgerPaginatedResponse<WgerWeightEntry> = await response.json();
            const entries = data.results ?? [];

            for (const raw of entries) {
              const entryDate = new Date(raw.date);
              if (entryDate < since) {
                url = null;
                break;
              }

              const parsed = parseWgerWeightEntry(raw);
              try {
                await db
                  .insert(bodyMeasurement)
                  .values({
                    providerId: this.id,
                    externalId: parsed.externalId,
                    recordedAt: parsed.recordedAt,
                    weightKg: parsed.weightKg,
                  })
                  .onConflictDoUpdate({
                    target: [bodyMeasurement.providerId, bodyMeasurement.externalId],
                    set: {
                      recordedAt: parsed.recordedAt,
                      weightKg: parsed.weightKg,
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

            if (url) {
              url = data.next;
            }
          }

          return { recordCount: count, result: count };
        },
        options?.userId,
      );
      recordsSynced += weightCount;
    } catch (err) {
      errors.push({
        message: `bodyMeasurement: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
  }
}
