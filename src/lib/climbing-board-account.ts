import { sql } from "drizzle-orm";
import type { TokenSet } from "../auth/oauth.ts";
import { persistClimbingLogSnapshot } from "../db/climbing-log-snapshot.ts";
import { persistClimbingLogEntries, type SourceClimbingLogEntry } from "../db/climbing-log-sync.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import { ProviderStoredIdentityMissingError } from "../providers/auth-errors.ts";
import type { ProviderAuthSetup, SyncResult, SyncRun } from "../providers/types.ts";
import { captureException } from "./error-reporting.ts";
import { findProviderTransportError } from "./provider-transport-error.ts";

export interface BoardLogbook {
  entries: SourceClimbingLogEntry[];
  absentExternalIds: string[];
  authoritative: boolean;
}

export interface ClimbingBoardClient {
  login(username: string, password: string): Promise<TokenSet>;
  fetchLogbook(
    tokens: TokenSet,
    persistTokens: (tokens: TokenSet) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<BoardLogbook>;
}

/** Per-user connection and canonical graph persistence shared by board protocols. */
export class ClimbingBoardAccount {
  readonly id: string;
  readonly name: string;
  readonly apiBaseUrl: string;
  readonly #client: ClimbingBoardClient;

  constructor(id: string, name: string, apiBaseUrl: string, client: ClimbingBoardClient) {
    this.id = id;
    this.name = name;
    this.apiBaseUrl = apiBaseUrl;
    this.#client = client;
  }

  authSetup(): ProviderAuthSetup {
    return {
      apiBaseUrl: this.apiBaseUrl,
      automatedLogin: (username, password) => this.#client.login(username, password),
    };
  }

  async sync(run: SyncRun): Promise<SyncResult> {
    const started = Date.now();
    const userId = run.options.userId;
    const result: SyncResult = { provider: this.id, recordsSynced: 0, errors: [], duration: 0 };
    try {
      if (!userId) throw new Error(`${this.name} sync requires a user context.`);
      await ensureProvider(run.db, this.id, this.name, this.apiBaseUrl, userId);
      const tokens = await loadTokens(run.db, this.id, userId);
      if (!tokens)
        throw new ProviderStoredIdentityMissingError(
          this.name,
          "connection; connect your account in Settings → Data Sources",
        );
      result.recordsSynced = await withSyncLog(
        run.db,
        this.id,
        "climbing_activity",
        async () => {
          const logbook = await this.#client.fetchLogbook(
            tokens,
            (refreshed) => saveTokens(run.db, this.id, refreshed, userId),
            run.options.signal,
          );
          // Fetch and validate the complete upstream response before writing any graph rows.
          const persisted = await run.db.transaction(async (tx) => {
            const persist = logbook.authoritative
              ? persistClimbingLogSnapshot
              : persistClimbingLogEntries;
            const saved = await persist(tx, {
              userId,
              providerId: this.id,
              entries: logbook.entries,
            });
            if (logbook.absentExternalIds.length > 0)
              await tx.execute(sql`
                UPDATE fitness.climbing_log_entry SET provider_absent_at = NOW()
                WHERE user_id = ${userId} AND provider_id = ${this.id}
                  AND external_id = ANY(${sql.param(logbook.absentExternalIds)}::text[])
                  AND provider_absent_at IS NULL
              `);
            return saved;
          });
          return { recordCount: persisted.recordsSynced, result: persisted.recordsSynced };
        },
        userId,
      );
    } catch (error) {
      captureException(error, { tags: { provider: this.id, phase: "climbing_activity" } });
      if (findProviderTransportError(error)) throw error;
      result.errors.push({
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });
    }
    result.duration = Date.now() - started;
    return result;
  }
}
