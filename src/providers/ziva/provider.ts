import { formatDateYmdInTimeZone } from "@dofek/format/format";
import {
  ProviderRateLimitError,
  ProviderRequestTimeoutError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import type { TokenSet } from "../../auth/oauth.ts";
import { resolveOAuthTokens } from "../../auth/resolve-tokens.ts";
import type { Database, SyncDatabase } from "../../db/index.ts";
import { getProviderIngestContext } from "../../db/provider-ingest-context.ts";
import { deleteTokens, deriveProviderAccountKey } from "../../db/tokens.ts";
import { captureException } from "../../lib/error-reporting.ts";
import { createProviderRateLimitFetch } from "../../lib/provider-rate-limit-fetch.ts";
import {
  ProviderAuthError,
  ProviderAuthorizationFailedError,
  RefreshTokenRevokedError,
} from "../auth-errors.ts";
import type { SyncCheckpointStore, SyncRun } from "../sync-run.ts";
import type { ProviderAuthSetup, SyncError, SyncProvider, SyncResult } from "../types.ts";
import {
  createZivaAuthSetup,
  validateZivaAuthConfiguration,
  validateZivaRefreshedIdentity,
  zivaSubjectFromAccessToken,
} from "./auth.ts";
import {
  ZivaMcpAuthenticationError,
  ZivaMcpClient,
  ZivaMcpInvalidDateError,
  ZivaMcpMalformedResponseError,
  ZivaMcpTimeoutError,
  ZivaMcpToolError,
  ZivaMcpTransportError,
} from "./client.ts";
import { upsertZivaMealsForDate } from "./nutrition-writer.ts";
import { normalizeZivaMeal } from "./schemas.ts";
import {
  advanceZivaSyncCheckpoint,
  planZivaSyncChunk,
  type ZivaSyncCheckpoint,
} from "./sync-plan.ts";

type TransactionalSyncDatabase = SyncDatabase & Pick<Database, "transaction">;

function isTransactionalDatabase(db: SyncDatabase): db is TransactionalSyncDatabase {
  return "transaction" in db && typeof db.transaction === "function";
}

function requireUserId(run: SyncRun): string {
  const userId = run.options.userId?.trim();
  if (!userId) throw new Error("Ziva sync requires a user ID");
  return userId;
}

function requireCheckpoint(run: SyncRun): SyncCheckpointStore {
  const checkpoint = run.options.checkpoint;
  if (!checkpoint) throw new Error("Ziva sync requires checkpoint storage");
  return checkpoint;
}

function requireContinuationEnqueue(run: SyncRun): (checkpoint: unknown) => Promise<void> {
  const enqueue = run.options.enqueueSyncContinuation;
  if (!enqueue) throw new Error("Ziva sync requires continuation enqueue support");
  return enqueue;
}

function requireTransactionalDatabase(db: SyncDatabase): TransactionalSyncDatabase {
  if (!isTransactionalDatabase(db)) {
    throw new Error("Ziva sync requires a transactional database");
  }
  return db;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isTerminalProviderError(error: unknown): boolean {
  return (
    error instanceof ProviderAuthError ||
    error instanceof ProviderRequestTimeoutError ||
    error instanceof ProviderServiceUnavailableError ||
    error instanceof ZivaMcpInvalidDateError ||
    error instanceof ZivaMcpMalformedResponseError ||
    error instanceof ZivaMcpTimeoutError ||
    error instanceof ZivaMcpToolError ||
    error instanceof ZivaMcpTransportError ||
    isAbortError(error)
  );
}

function abortReason(signal: AbortSignal | undefined, fallback?: unknown): unknown {
  if (isAbortError(fallback)) return fallback;
  if (signal?.reason !== undefined) return signal.reason;
  return new DOMException("The operation was aborted", "AbortError");
}

function terminalSyncError(error: unknown, date?: string): SyncError {
  if (isAbortError(error)) {
    return {
      message: "Ziva sync was cancelled.",
      cause: error,
    };
  }
  const message = error instanceof Error ? error.message : "Ziva sync failed.";
  return {
    message: date ? `Date ${date}: ${message}` : message,
    cause: error,
    ...(date ? { context: { date } } : {}),
  };
}

function closeFailure(error: unknown): ZivaMcpTransportError {
  const sanitizedError = new ZivaMcpTransportError();
  captureException(sanitizedError, {
    tags: { provider: "ziva", mcpPhase: "close" },
    extra: { errorName: error instanceof Error ? error.name : typeof error },
  });
  return sanitizedError;
}

function calendarEndDateForRun(run: SyncRun): string | undefined {
  const timezone = getProviderIngestContext()?.homeTimezone ?? "UTC";
  if (run.window.kind === "full") {
    return formatDateYmdInTimeZone(run.window.until, timezone);
  }
  if (!run.options.relativeWindow) return undefined;
  if (!run.options.requestedAt) {
    throw new Error("Relative Ziva sync requires a fixed request time");
  }
  return formatDateYmdInTimeZone(run.options.requestedAt, timezone);
}

export class ZivaProvider implements SyncProvider {
  readonly id = "ziva";
  readonly name = "Ziva";
  readonly scheduledSyncLookbackDays = 1;
  readonly #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = createProviderRateLimitFetch(this.id, fetchFn);
  }

  validate(): string | null {
    return validateZivaAuthConfiguration();
  }

  authSetup(options?: { host?: string }): ProviderAuthSetup | undefined {
    return createZivaAuthSetup(options, this.#fetchFn);
  }

  async #resolveValidatedTokens(
    db: SyncDatabase,
    forceRefresh: boolean,
    onRefresh: () => void,
  ): Promise<TokenSet> {
    try {
      const tokens = await resolveOAuthTokens({
        db,
        providerId: this.id,
        providerName: this.name,
        getOAuthConfig: () => this.authSetup()?.oauthConfig,
        fetchFn: this.#fetchFn,
        forceRefresh,
        validateRefreshedTokens: (currentTokens, refreshedTokens) => {
          onRefresh();
          validateZivaRefreshedIdentity(currentTokens, refreshedTokens);
        },
      });
      const storedSubject = tokens.providerAccountId?.trim();
      if (!storedSubject || zivaSubjectFromAccessToken(tokens.accessToken) !== storedSubject) {
        throw new ProviderAuthorizationFailedError(this.name);
      }
      return tokens;
    } catch (error: unknown) {
      if (error instanceof ProviderAuthError && !(error instanceof RefreshTokenRevokedError)) {
        await deleteTokens(db, this.id);
      }
      throw error;
    }
  }

  async sync(run: SyncRun): Promise<SyncResult> {
    const signal = run.options.signal;
    signal?.throwIfAborted();
    const startedAt = Date.now();
    const userId = requireUserId(run);
    const db = requireTransactionalDatabase(run.db);
    const checkpointStore = requireCheckpoint(run);
    const enqueueContinuation = requireContinuationEnqueue(run);
    const rawCheckpoint = await checkpointStore.load();
    signal?.throwIfAborted();
    let checkpoint: ZivaSyncCheckpoint | null = null;
    let recordsSynced = 0;
    let tokens: TokenSet | null = null;
    let client: ZivaMcpClient | null = null;
    let refreshAttempted = false;
    let terminalFailure: { error: unknown; date?: string } | null = null;
    let observedCloseFailure: ZivaMcpTransportError | null = null;
    const markRefreshAttempted = () => {
      refreshAttempted = true;
    };

    const closeActiveClient = async (): Promise<void> => {
      const activeClient = client;
      client = null;
      if (!activeClient) return;
      try {
        await activeClient.close();
      } catch (error: unknown) {
        observedCloseFailure ??= closeFailure(error);
      }
    };

    const revokeRejectedCredentials = async (error: unknown): Promise<never> => {
      await deleteTokens(db, this.id);
      throw new RefreshTokenRevokedError(this.name, {
        cause: error instanceof Error ? error : undefined,
      });
    };

    const mealsForDate = async (date: string) => {
      for (;;) {
        try {
          client ??= await ZivaMcpClient.connect({
            accessToken: tokens?.accessToken ?? "",
            fetchFn: this.#fetchFn,
            signal,
          });
          return await client.getMealsForDate(date, { signal });
        } catch (error: unknown) {
          signal?.throwIfAborted();
          if (!(error instanceof ZivaMcpAuthenticationError)) throw error;

          await closeActiveClient();
          if (refreshAttempted) await revokeRejectedCredentials(error);
          refreshAttempted = true;
          if (!tokens?.refreshToken) await revokeRejectedCredentials(error);
          tokens = await this.#resolveValidatedTokens(db, true, markRefreshAttempted);
        }
      }
    };

    try {
      try {
        try {
          tokens = await this.#resolveValidatedTokens(db, false, markRefreshAttempted);
        } catch (error: unknown) {
          if (isAbortError(error) || signal?.aborted) {
            terminalFailure = { error: abortReason(signal, error) };
          } else if (!isTerminalProviderError(error)) {
            throw error;
          } else {
            terminalFailure = { error };
          }
        }

        if (!terminalFailure) {
          if (!tokens) throw new Error("Ziva token resolution completed without credentials");
          const accountSubject = tokens.providerAccountId?.trim();
          if (!accountSubject)
            throw new Error("Ziva resolved credentials have no account identity");
          const sourceAccountKey = deriveProviderAccountKey(this.id, accountSubject, userId);
          signal?.throwIfAborted();
          const chunk = planZivaSyncChunk(run.window, rawCheckpoint, sourceAccountKey, {
            calendarEndDate: calendarEndDateForRun(run),
          });
          checkpoint = chunk.checkpoint;
          recordsSynced = chunk.checkpoint.recordsSynced;
          for (const [index, date] of chunk.dates.entries()) {
            if (signal?.aborted) {
              terminalFailure = { error: abortReason(signal) };
              break;
            }
            let payload: Awaited<ReturnType<ZivaMcpClient["getMealsForDate"]>>;
            try {
              payload = await mealsForDate(date);
            } catch (error: unknown) {
              if (isAbortError(error) || signal?.aborted) {
                terminalFailure = { error: abortReason(signal, error) };
                break;
              }
              if (error instanceof ProviderRateLimitError || !isTerminalProviderError(error)) {
                throw error;
              }
              terminalFailure = { error, date };
              break;
            }

            const normalizedMeals = payload.meals.map((meal) =>
              normalizeZivaMeal(meal, { sourceAccountKey }),
            );
            signal?.throwIfAborted();
            const committed = await upsertZivaMealsForDate(db, userId, normalizedMeals);
            recordsSynced += committed;
            if (!checkpoint) throw new Error("Ziva checkpoint completed before its final date");
            checkpoint = advanceZivaSyncCheckpoint(checkpoint, date, recordsSynced);
            if (checkpoint) await checkpointStore.save(checkpoint);
            else await checkpointStore.clear();
            run.options.onProgress?.(
              ((index + 1) / chunk.dates.length) * 100,
              `Synced Ziva diary date ${date}`,
            );
            if (signal?.aborted) {
              terminalFailure = { error: abortReason(signal) };
              break;
            }
          }
        }
      } finally {
        await closeActiveClient();
      }

      if (terminalFailure) {
        return {
          provider: this.id,
          recordsSynced,
          errors: [terminalSyncError(terminalFailure.error, terminalFailure.date)],
          duration: Date.now() - startedAt,
          continued: false,
        };
      }

      if (observedCloseFailure) {
        return {
          provider: this.id,
          recordsSynced,
          errors: [terminalSyncError(observedCloseFailure)],
          duration: Date.now() - startedAt,
          continued: false,
        };
      }

      if (checkpoint) {
        signal?.throwIfAborted();
        await enqueueContinuation(checkpoint);
        return {
          provider: this.id,
          recordsSynced,
          errors: [],
          duration: Date.now() - startedAt,
          continued: true,
        };
      }

      return {
        provider: this.id,
        recordsSynced,
        errors: [],
        duration: Date.now() - startedAt,
        continued: false,
      };
    } catch (error: unknown) {
      if (isAbortError(error)) {
        return {
          provider: this.id,
          recordsSynced,
          errors: [terminalSyncError(error)],
          duration: Date.now() - startedAt,
          continued: false,
        };
      }
      throw error;
    }
  }
}
