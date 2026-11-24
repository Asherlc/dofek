import {
  ProviderRateLimitError,
  ProviderRequestTimeoutError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import { resolveProviderActivityType } from "@dofek/training/activity-types";
import { DrizzleQueryError } from "drizzle-orm";
import { DatabaseError } from "pg";
import type { TokenSet } from "../../auth/oauth.ts";
import { resolveOAuthTokens } from "../../auth/resolve-tokens.ts";
import type { SyncDatabase } from "../../db/index.ts";
import {
  type ProviderActivityConflictUpdate,
  type ProviderActivityInsert,
  upsertProviderActivity,
} from "../../db/provider-activity-sync.ts";
import { runWithTokenUser } from "../../db/token-user-context.ts";
import { captureException } from "../../lib/error-reporting.ts";
import { createProviderRateLimitFetch } from "../../lib/provider-rate-limit-fetch.ts";
import { redactProviderServiceUnavailableError } from "../../lib/provider-transport-error.ts";
import {
  ProviderAccessDeniedError,
  ProviderAuthError,
  RefreshTokenRevokedError,
} from "../auth-errors.ts";
import type { SyncRun } from "../sync-run.ts";
import type { ProviderAuthSetup, SyncError, SyncProvider, SyncResult } from "../types.ts";
import {
  createTrailforksAuthSetup,
  trailforksOAuthConfig,
  validateTrailforksAuthConfiguration,
} from "./auth.ts";
import { TrailforksActivityClient, TrailforksMcpToolError } from "./client.ts";
import {
  type ParsedTrailforksActivity,
  parseTrailforksActivityListResult,
  TrailforksActivityParseError,
} from "./parsing.ts";

type SyncPhase = "resolve" | "read" | "persist";

function isInWindow(date: Date, since: Date, until: Date): boolean {
  return date.getTime() >= since.getTime() && date.getTime() <= until.getTime();
}

function requireUserId(run: SyncRun): string {
  const userId = run.options.userId?.trim();
  if (!userId) throw new Error("Trailforks sync requires a user ID");
  return userId;
}

function rethrowRetryableFailure(error: unknown): void {
  if (error instanceof ProviderRateLimitError) {
    throw new ProviderRateLimitError({
      ...error,
      message: "Trailforks rate limit exceeded.",
      responseBody: "",
    });
  }
  if (error instanceof ProviderServiceUnavailableError) {
    throw redactProviderServiceUnavailableError(error, "Trailforks is temporarily unavailable");
  }
  if (error instanceof ProviderRequestTimeoutError) {
    throw new ProviderRequestTimeoutError({ ...error, cause: undefined });
  }
  if (error instanceof Error && error.name === "AbortError") throw error;
}

/** Continue only for positively known PostgreSQL data-exception SQLSTATEs (class 22). */
function isContinuableRowDataFailure(error: unknown): boolean {
  if (!(error instanceof DrizzleQueryError)) return false;
  const cause = error.cause;
  return (
    cause instanceof DatabaseError &&
    typeof cause.code === "string" &&
    /^22[0-9A-Z]{3}$/.test(cause.code)
  );
}

function fallbackMessage(phase: SyncPhase): string {
  if (phase === "resolve") return "Trailforks is not connected.";
  if (phase === "persist") return "Failed to save a Trailforks activity.";
  return "Trailforks sync failed.";
}

function sanitizedAuthCause(error: ProviderAuthError): ProviderAuthError {
  if (error instanceof RefreshTokenRevokedError) {
    return new RefreshTokenRevokedError("Trailforks");
  }
  return new ProviderAuthError(error.authFailureReason, error.message);
}

/** Map failures to UI-safe SyncErrors. Unexpected errors omit `cause` so raw DB/SDK bodies cannot leak. */
function toSyncError(error: unknown, phase: SyncPhase, externalId?: string): SyncError {
  if (error instanceof ProviderAuthError) {
    const cause = sanitizedAuthCause(error);
    return { message: cause.message, cause };
  }
  if (error instanceof ProviderAccessDeniedError) {
    const cause = new ProviderAccessDeniedError(error.message);
    return { message: cause.message, cause };
  }
  if (error instanceof TrailforksMcpToolError || error instanceof TrailforksActivityParseError) {
    return {
      message: error.message,
      cause: error,
      ...(externalId ? { externalId } : {}),
    };
  }
  captureException(new TrailforksMcpToolError(), {
    tags: { provider: "trailforks", mcpPhase: phase },
    extra: {
      errorName: error instanceof Error ? error.name : typeof error,
      ...(externalId ? { externalId } : {}),
    },
  });
  return {
    message: fallbackMessage(phase),
    ...(externalId ? { externalId } : {}),
  };
}

const FALLBACK_ACTIVITY_TYPE = resolveProviderActivityType("unknown", "other");

/**
 * Insert materializes defaults. Conflict update omits absent title/end/sport so
 * Drizzle skips them; explicit `null` title/end clear the stored source fields.
 */
function activityWriteValues(
  userId: string,
  providerId: string,
  providerName: string,
  activity: ParsedTrailforksActivity,
): { insert: ProviderActivityInsert; update: ProviderActivityConflictUpdate } {
  const { externalId, activityType, ...summary } = activity;
  const update = { ...summary, activityType, sourceName: providerName };
  return {
    insert: {
      ...update,
      userId,
      providerId,
      externalId,
      activityType: activityType ?? FALLBACK_ACTIVITY_TYPE,
    },
    update,
  };
}

/**
 * Trailforks MCP activity sync.
 *
 * Calls `list_my_activities` once with `{}`, filters locally to the exact sync
 * window, and upserts additive activity summaries. Does not paginate or
 * reconcile absence — a single listing is not treated as a complete inventory.
 * Field parsing is strict and unverified against a live Pro/Outside+ fixture.
 */
export class TrailforksProvider implements SyncProvider {
  readonly id = "trailforks";
  readonly name = "Trailforks";
  readonly scheduledSyncLookbackDays = 1;
  readonly #fetchFn: typeof globalThis.fetch;
  readonly #oauthFetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = fetchFn;
    this.#oauthFetchFn = createProviderRateLimitFetch(this.id, fetchFn);
  }

  validate(): string | null {
    return validateTrailforksAuthConfiguration();
  }

  activityUrl(externalId: string): string {
    return `https://www.trailforks.com/ridelog/view/${externalId}/`;
  }

  authSetup(options?: { host?: string }): ProviderAuthSetup | undefined {
    return createTrailforksAuthSetup(options, this.#oauthFetchFn);
  }

  async #resolveTokens(db: SyncDatabase, userId: string): Promise<TokenSet> {
    return runWithTokenUser(userId, () =>
      resolveOAuthTokens({
        db,
        providerId: this.id,
        providerName: this.name,
        getOAuthConfig: () => trailforksOAuthConfig(),
        fetchFn: this.#oauthFetchFn,
      }),
    );
  }

  async sync(run: SyncRun): Promise<SyncResult> {
    const signal = run.options.signal;
    signal?.throwIfAborted();
    const startedAtMs = Date.now();
    let recordsSynced = 0;
    const errors: SyncError[] = [];
    const userId = requireUserId(run);
    const { db, window } = run;
    let client: TrailforksActivityClient | null = null;
    let phase: SyncPhase = "resolve";
    let persistExternalId: string | undefined;

    try {
      const tokens = await this.#resolveTokens(db, userId);

      phase = "read";
      // MCP transport owns rate-limit wrapping; pass the raw fetch once.
      client = await TrailforksActivityClient.connect({
        accessToken: tokens.accessToken,
        fetchFn: this.#fetchFn,
        signal,
      });
      signal?.throwIfAborted();

      // Single default listing — do not invent undocumented filter/pagination args.
      const toolResult = await client.listMyActivities({});
      signal?.throwIfAborted();
      const activities = parseTrailforksActivityListResult(toolResult);
      const inWindow = activities.filter((activity) =>
        isInWindow(activity.startedAt, window.since, window.until),
      );

      phase = "persist";
      for (const activity of inWindow) {
        signal?.throwIfAborted();
        persistExternalId = activity.externalId;
        const { insert, update } = activityWriteValues(userId, this.id, this.name, activity);
        try {
          await upsertProviderActivity(db, insert, update);
          recordsSynced += 1;
        } catch (error: unknown) {
          signal?.throwIfAborted();
          rethrowRetryableFailure(error);
          if (!isContinuableRowDataFailure(error)) throw error;
          errors.push(toSyncError(error, "persist", activity.externalId));
        }
      }

      return {
        provider: this.id,
        recordsSynced,
        errors,
        duration: Date.now() - startedAtMs,
      };
    } catch (error: unknown) {
      signal?.throwIfAborted();
      rethrowRetryableFailure(error);
      return {
        provider: this.id,
        recordsSynced,
        errors: [
          ...errors,
          toSyncError(error, phase, phase === "persist" ? persistExternalId : undefined),
        ],
        duration: Date.now() - startedAtMs,
      };
    } finally {
      if (client) {
        try {
          await client.close();
        } catch (closeError: unknown) {
          captureException(new TrailforksMcpToolError(), {
            tags: { provider: "trailforks", mcpPhase: "close" },
            extra: {
              errorName: closeError instanceof Error ? closeError.name : typeof closeError,
            },
          });
        }
      }
    }
  }
}
