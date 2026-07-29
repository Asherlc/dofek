import {
  resolveProviderActivityType,
  type ProviderActivityType,
} from "@dofek/training/activity-types";
import { z } from "zod";
import type { TokenSet } from "../auth/oauth.ts";
import type { SyncDatabase } from "../db/index.ts";
import { writeMetricStreamBatch } from "../db/metric-stream-writer.ts";
import {
  finishProviderActivityListSync,
  upsertProviderActivity,
} from "../db/provider-activity-sync.ts";
import { SOURCE_TYPE_API } from "../db/sensor-channels.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { deleteTokens, ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import { createProviderRateLimitFetch } from "../lib/provider-rate-limit-fetch.ts";
import { fetchProviderPages } from "../sync/pagination.ts";
import { ProviderTokenRejectedError, RefreshTokenRevokedError } from "./auth-errors.ts";
import type { SyncRun } from "./sync-run.ts";
import type { ProviderAuthSetup, SyncError, SyncProvider, SyncResult } from "./types.ts";

// ============================================================
// Wger API types
// ============================================================

const WGER_API_BASE = "https://wger.de/api/v2";
const WGER_REFRESH_URL = `${WGER_API_BASE}/token/refresh`;

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

const wgerRefreshResponseSchema = z.object({
  access: z.string().min(1),
  refresh: z.string().min(1),
});

const jwtPayloadSchema = z.object({
  exp: z.number().int().positive(),
});

// ============================================================
// Parsed types
// ============================================================

export interface ParsedWgerWorkoutSession {
  externalId: string;
  activityType: ProviderActivityType;
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
    activityType: resolveProviderActivityType("strength", "strength"),
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
// Personal token authentication
// ============================================================

function jwtExpiration(token: string): Date {
  const encodedPayload = token.split(".")[1];
  if (!encodedPayload) {
    throw new Error("Wger returned an access token without a JWT payload");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch (error: unknown) {
    throw new Error("Wger returned an invalid access-token JWT payload", { cause: error });
  }
  const parsed = jwtPayloadSchema.parse(payload);
  return new Date(parsed.exp * 1000);
}

async function exchangeWgerRefreshToken(
  refreshToken: string,
  fetchFn: typeof globalThis.fetch,
): Promise<TokenSet> {
  const response = await fetchFn(WGER_REFRESH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ refresh: refreshToken }).toString(),
  });
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    throw new ProviderTokenRejectedError(
      "Wger",
      "Create a new JWT refresh token in Wger's API key settings and try again.",
    );
  }
  if (!response.ok) {
    throw new Error(`Wger token refresh failed (${response.status}). Try again.`);
  }

  const body: unknown = await response.json();
  const parsed = wgerRefreshResponseSchema.parse(body);
  return {
    accessToken: parsed.access,
    refreshToken: parsed.refresh,
    expiresAt: jwtExpiration(parsed.access),
    scopes: "read",
  };
}

async function assertWgerDataResponse(response: Response): Promise<void> {
  if (response.status === 401 || response.status === 403) {
    throw new ProviderTokenRejectedError(
      "Wger",
      "Create a new JWT refresh token in Wger's API key settings and reconnect.",
    );
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Wger API error (${response.status}): ${text}`);
  }
}

// ============================================================
// Provider implementation
// ============================================================

export class WgerProvider implements SyncProvider {
  readonly id = "wger";
  readonly name = "Wger";
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = createProviderRateLimitFetch("wger", fetchFn);
  }

  validate(): string | null {
    return null;
  }

  authSetup(): ProviderAuthSetup {
    const fetchFn = this.#fetchFn;
    return {
      manualToken: {
        label: "JWT refresh token",
        instructionsUrl: "https://wger.readthedocs.io/en/latest/api/api.html#jwt-tokens",
        exchangeToken: (token) => exchangeWgerRefreshToken(token, fetchFn),
      },
      apiBaseUrl: WGER_API_BASE,
    };
  }

  async #resolveTokens(db: SyncDatabase): Promise<TokenSet> {
    const tokens = await loadTokens(db, this.id);
    if (!tokens) {
      throw new Error(`No tokens found for ${this.name}. Connect ${this.name} in Data Sources.`);
    }
    if (tokens.expiresAt > new Date()) {
      return tokens;
    }
    if (!tokens.refreshToken) {
      throw new RefreshTokenRevokedError(this.name);
    }

    try {
      const refreshed = await exchangeWgerRefreshToken(tokens.refreshToken, this.#fetchFn);
      // Persist before using the rotated access token. If this write fails, the
      // provider may already have blacklisted the prior refresh token; surface
      // the failure and leave the stale row intact so a later rejected refresh
      // records the normal reconnect-required state.
      await saveTokens(db, this.id, refreshed);
      return refreshed;
    } catch (error: unknown) {
      if (error instanceof ProviderTokenRejectedError) {
        await deleteTokens(db, this.id);
        throw new RefreshTokenRevokedError(this.name, { cause: error });
      }
      throw error;
    }
  }

  async sync(run: SyncRun): Promise<SyncResult> {
    const { db, window, options } = run;
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
    const since = window.since;
    const syncWindowEnd = window.until;
    const presentActivityExternalIds = new Set<string>();
    try {
      const activityCount = await withSyncLog(
        db,
        this.id,
        "activity",
        async () => {
          let count = 0;
          const initialUrl = `${WGER_API_BASE}/workoutsession/?format=json&ordering=-date&offset=0&limit=50`;

          const pages = await fetchProviderPages<WgerWorkoutSession, string>({
            providerId: this.id,
            stepName: "activity",
            initialCursor: initialUrl,
            fetchPage: async (url) => {
              if (!url) throw new Error("Wger workout pagination missing page URL");
              const response = await this.#fetchFn(url, {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  Accept: "application/json",
                },
              });
              await assertWgerDataResponse(response);
              const data: WgerPaginatedResponse<WgerWorkoutSession> = await response.json();
              return {
                items: data.results ?? [],
                nextCursor: data.next,
              };
            },
            shouldStopAfterPage: (page) =>
              page.items.some((session) => new Date(session.date) < since),
          });

          for (const raw of pages.items) {
            const sessionDate = new Date(raw.date);
            if (sessionDate < since || sessionDate >= syncWindowEnd) {
              continue;
            }

            const parsed = parseWgerWorkoutSession(raw);
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
                  raw: parsed.raw,
                },
                {
                  activityType: parsed.activityType,
                  name: parsed.name,
                  startedAt: parsed.startedAt,
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

          if (pages.degradations.length === 0) {
            await finishProviderActivityListSync(db, {
              providerId: this.id,
              userId: options?.userId,
              windowStart: since,
              windowEnd: syncWindowEnd,
              presentExternalIds: presentActivityExternalIds,
            });
          }
          return { recordCount: count, result: count, degradations: pages.degradations };
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

    // Sync body weight into metric stream body channels.
    try {
      const weightCount = await withSyncLog(
        db,
        this.id,
        "metric_stream",
        async () => {
          let count = 0;
          const initialUrl = `${WGER_API_BASE}/weightentry/?format=json&ordering=-date&offset=0&limit=50`;
          const pages = await fetchProviderPages<WgerWeightEntry, string>({
            providerId: this.id,
            stepName: "metric_stream",
            initialCursor: initialUrl,
            fetchPage: async (url) => {
              if (!url) throw new Error("Wger weight pagination missing page URL");
              const response = await this.#fetchFn(url, {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  Accept: "application/json",
                },
              });
              await assertWgerDataResponse(response);
              const data: WgerPaginatedResponse<WgerWeightEntry> = await response.json();
              return {
                items: data.results ?? [],
                nextCursor: data.next,
              };
            },
            shouldStopAfterPage: (page) => page.items.some((entry) => new Date(entry.date) < since),
          });

          for (const raw of pages.items) {
            const entryDate = new Date(raw.date);
            if (entryDate < since || entryDate >= syncWindowEnd) {
              continue;
            }

            const parsed = parseWgerWeightEntry(raw);
            try {
              await writeMetricStreamBatch(
                db,
                [
                  {
                    providerId: this.id,
                    externalId: parsed.externalId,
                    recordedAt: parsed.recordedAt,
                    weightKg: parsed.weightKg,
                  },
                ],
                SOURCE_TYPE_API,
                undefined,
                options?.metricStreamPublisher,
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

          return { recordCount: count, result: count, degradations: pages.degradations };
        },
        options?.userId,
      );
      recordsSynced += weightCount;
    } catch (err) {
      errors.push({
        message: `metric_stream: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
  }
}
