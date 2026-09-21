import {
  ProviderRateLimitError,
  ProviderRequestTimeoutError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import type { TokenSet } from "../../auth/oauth.ts";
import { resolveOAuthTokens } from "../../auth/resolve-tokens.ts";
import type { Database, SyncDatabase } from "../../db/index.ts";
import { deleteTokens } from "../../db/tokens.ts";
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

function terminalSyncError(error: unknown, date?: string): SyncError {
  const message = isAbortError(error)
    ? "Ziva sync was cancelled."
    : error instanceof Error
      ? error.message
      : "Ziva sync failed.";
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
    const startedAt = Date.now();
    const userId = requireUserId(run);
    const db = requireTransactionalDatabase(run.db);
    const checkpointStore = requireCheckpoint(run);
    const enqueueContinuation = requireContinuationEnqueue(run);
    const chunk = planZivaSyncChunk(run.window, await checkpointStore.load());
    let checkpoint: ZivaSyncCheckpoint | null = chunk.checkpoint;
    let recordsSynced = chunk.checkpoint.recordsSynced;
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
          });
          return await client.getMealsForDate(date);
        } catch (error: unknown) {
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
        tokens = await this.#resolveValidatedTokens(db, false, markRefreshAttempted);
      } catch (error: unknown) {
        if (!isTerminalProviderError(error)) throw error;
        terminalFailure = { error };
      }

      if (!terminalFailure) {
        if (!tokens) throw new Error("Ziva token resolution completed without credentials");
        for (const [index, date] of chunk.dates.entries()) {
          let payload: Awaited<ReturnType<ZivaMcpClient["getMealsForDate"]>>;
          try {
            payload = await mealsForDate(date);
          } catch (error: unknown) {
            if (error instanceof ProviderRateLimitError || !isTerminalProviderError(error)) {
              throw error;
            }
            terminalFailure = { error, date };
            break;
          }

          const accountSubject = tokens?.providerAccountId;
          if (!accountSubject)
            throw new Error("Ziva resolved credentials have no account identity");
          const normalizedMeals = payload.meals.map((meal) =>
            normalizeZivaMeal(meal, { userId, accountSubject }),
          );
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
  }
}
