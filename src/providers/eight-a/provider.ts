import { and, eq, sql } from "drizzle-orm";
import {
  persistClimbingLogEntries,
  type SourceClimbingLogEntry,
} from "../../db/climbing-log-sync.ts";
import type { SyncDatabase } from "../../db/index.ts";
import { climbingLogEntry } from "../../db/schema/climbing.ts";
import { withSyncLog } from "../../db/sync-log.ts";
import { ensureProvider, loadTokens, saveTokens } from "../../db/tokens.ts";
import { captureException } from "../../lib/error-reporting.ts";
import { createProviderRateLimitFetch } from "../../lib/provider-rate-limit-fetch.ts";
import { findProviderTransportError } from "../../lib/provider-transport-error.ts";
import { ProviderAuthError } from "../auth-errors.ts";
import type { ProviderAuthSetup, SyncProvider, SyncResult, SyncRun } from "../types.ts";
import { EightAClient } from "./client.ts";
import { resolveEightAIdentities } from "./identity.ts";
import { parseEightAExport } from "./parser.ts";

export class EightAProvider implements SyncProvider {
  readonly id = "eight-a";
  readonly name = "8a.nu / Vertical-Life";
  readonly #client: EightAClient;
  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#client = new EightAClient(createProviderRateLimitFetch(this.id, fetchFn));
  }
  validate(): string | null {
    return null;
  }
  authSetup(): ProviderAuthSetup {
    return {
      apiBaseUrl: "https://vlcapi.vertical-life.info",
      automatedLogin: (username, password) => this.#client.login(username, password),
    };
  }
  async sync(run: SyncRun): Promise<SyncResult> {
    const startedAt = Date.now();
    const result: SyncResult = { provider: this.id, recordsSynced: 0, errors: [], duration: 0 };
    try {
      const userId = run.options.userId;
      if (!userId) throw new Error("Vertical-Life sync requires a user context.");
      await ensureProvider(run.db, this.id, this.name, "https://vlcapi.vertical-life.info", userId);
      const tokens = await loadTokens(run.db, this.id, userId);
      if (!tokens)
        throw new ProviderAuthError(
          "authentication_failed",
          "Vertical-Life is not connected. Connect it in Settings → Data Sources.",
        );
      result.recordsSynced = await withSyncLog(
        run.db,
        this.id,
        "climbing_activity",
        async () => {
          const entries = await this.#client.fetchLogbook(
            tokens,
            (next) => saveTokens(run.db, this.id, next, userId),
            run.options.signal,
          );
          run.options.signal?.throwIfAborted();
          const count = await persistEightAEntries(run.db, entries, userId, "native");
          return { recordCount: count, result: count };
        },
        userId,
      );
    } catch (error) {
      run.options.signal?.throwIfAborted();
      captureException(error, { tags: { provider: this.id, phase: "climbing_activity" } });
      if (findProviderTransportError(error)) throw error;
      result.errors.push({
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });
    }
    result.duration = Date.now() - startedAt;
    return result;
  }
}

function persistEightAEntries(
  db: SyncDatabase,
  entries: readonly SourceClimbingLogEntry[],
  userId: string,
  source: "native" | "csv",
) {
  return db.transaction(async (tx) => {
    await ensureProvider(
      tx,
      "eight-a",
      "8a.nu / Vertical-Life",
      "https://vlcapi.vertical-life.info",
      userId,
    );
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`climbing-graph:${userId}:eight-a`},0))`,
    );
    const known = await tx
      .select({
        id: climbingLogEntry.id,
        externalId: climbingLogEntry.externalId,
        raw: climbingLogEntry.raw,
      })
      .from(climbingLogEntry)
      .where(and(eq(climbingLogEntry.userId, userId), eq(climbingLogEntry.providerId, "eight-a")));
    const connected = source === "native" || (await loadTokens(tx, "eight-a", userId)) !== null;
    const resolved = resolveEightAIdentities(entries, known, source, connected);
    for (const migration of resolved.migrations)
      await tx
        .update(climbingLogEntry)
        .set({ externalId: migration.externalId })
        .where(eq(climbingLogEntry.id, migration.id));
    for (const update of resolved.rawUpdates)
      await tx
        .update(climbingLogEntry)
        .set({ raw: update.raw })
        .where(eq(climbingLogEntry.id, update.id));
    const saved = await persistClimbingLogEntries(tx, {
      userId,
      providerId: "eight-a",
      entries: resolved.entries,
    });
    if (source === "native")
      await tx.execute(sql`
      UPDATE fitness.climbing_log_entry SET provider_absent_at=NOW()
      WHERE user_id=${userId}::uuid AND provider_id='eight-a'
        AND external_id LIKE 'eight-a:native:%' AND provider_absent_at IS NULL
        AND id <> ALL(${sql.param(saved.logEntryIds)}::uuid[])
    `);
    return entries.length;
  });
}

export async function importEightAExportFile(
  db: SyncDatabase,
  csvText: string,
  userId: string,
): Promise<SyncResult> {
  const startedAt = Date.now();
  const entries = parseEightAExport(csvText);
  const recordsSynced = await persistEightAEntries(db, entries, userId, "csv");
  return {
    provider: "eight-a",
    recordsSynced,
    errors: [],
    duration: Date.now() - startedAt,
  };
}
