import { randomUUID } from "node:crypto";
import type { TokenSet } from "../../auth/oauth.ts";
import { withSyncLog } from "../../db/sync-log.ts";
import { ensureProvider, loadTokens } from "../../db/tokens.ts";
import { captureException } from "../../lib/error-reporting.ts";
import { createProviderRateLimitFetch } from "../../lib/provider-rate-limit-fetch.ts";
import { findProviderTransportError } from "../../lib/provider-transport-error.ts";
import {
  ProviderStoredIdentityInvalidError,
  ProviderStoredIdentityMissingError,
} from "../auth-errors.ts";
import type { SyncRun } from "../sync-run.ts";
import type { ProviderAuthSetup, SyncProvider, SyncResult } from "../types.ts";
import { TheCragClient } from "./client.ts";
import { THECRAG_LOGBOOK_SCOPE } from "./identity.ts";
import { mapTheCragAscent } from "./mapping.ts";
import { writeClimbingRecords } from "./persistence.ts";
import { TheCragSyncProgress } from "./progress.ts";

const API_BASE_URL = "https://www.thecrag.com/api";

export class TheCragProvider implements SyncProvider {
  readonly id = "thecrag";
  readonly name = "theCrag";
  readonly #fetchFn: typeof fetch;
  constructor(fetchFn: typeof fetch = globalThis.fetch) {
    this.#fetchFn = createProviderRateLimitFetch(this.id, fetchFn);
  }
  validate(): string | null {
    return null;
  }
  authSetup(): ProviderAuthSetup {
    return {
      apiBaseUrl: API_BASE_URL,
      manualToken: {
        kind: "access-token",
        label: "Personal API key (active supporter required)",
        instructionsUrl: "https://www.thecrag.com/en/article/logbookreadapi",
        exchangeToken: async (input): Promise<TokenSet> => {
          const key = input.trim();
          const data = await new TheCragClient(this.#fetchFn, key).fetchPage(1);
          return {
            accessToken: key,
            refreshToken: null,
            expiresAt: new Date("2099-12-31T00:00:00.000Z"),
            scopes: THECRAG_LOGBOOK_SCOPE,
            providerAccountId: data.account.id,
            authorizationId: randomUUID(),
          };
        },
      },
    };
  }
  async sync(run: SyncRun): Promise<SyncResult> {
    const startedAt = Date.now();
    const { db, options } = run;
    let recordsSynced = 0;
    try {
      const userId = options.userId;
      if (!userId) throw new Error("theCrag sync requires a user context.");
      await ensureProvider(db, this.id, this.name, API_BASE_URL, userId);
      const tokens = await loadTokens(db, this.id, userId);
      if (!tokens)
        throw new ProviderStoredIdentityMissingError(
          this.name,
          "API key — reconnect in Data Sources",
        );
      if (
        tokens.scopes !== THECRAG_LOGBOOK_SCOPE ||
        !tokens.authorizationId ||
        !tokens.providerAccountId ||
        !/^[1-9]\d*$/.test(tokens.providerAccountId)
      )
        throw new ProviderStoredIdentityInvalidError(
          "Reconnect theCrag in Data Sources using a personal API key from theCrag Settings > API Keys. An active supporter subscription is required.",
        );
      const identity = {
        accountId: tokens.providerAccountId,
        authorizationId: tokens.authorizationId,
      };
      const progress = new TheCragSyncProgress(db, userId, identity);
      const cursor = run.window.kind === "full" ? undefined : await progress.load();
      // The API's `since` is exclusive. Replay the source second at the boundary.
      const since = cursor === undefined ? undefined : Math.max(0, cursor - 1);
      const client = new TheCragClient(this.#fetchFn, tokens.accessToken);
      recordsSynced = await withSyncLog(
        db,
        this.id,
        "climbing_activity",
        async () => {
          const records = [];
          const ids = new Set<string>();
          let expectedTotal: number | undefined;
          let expectedPageSize: number | undefined;
          let highestEpoch = cursor;
          for (let page = 1; ; page++) {
            const data = await client.fetchPage(page, { since, signal: options.signal });
            if (data.account.id !== identity.accountId)
              throw new Error(
                "theCrag returned a different account. Reconnect your intended account in Data Sources.",
              );
            if (
              data.page !== page ||
              (expectedTotal !== undefined && data.numberAscents !== expectedTotal) ||
              (expectedPageSize !== undefined && data.perPage !== expectedPageSize)
            )
              throw new Error(
                "theCrag returned inconsistent logbook pagination. Try syncing again.",
              );
            expectedTotal = data.numberAscents;
            expectedPageSize = data.perPage;
            const remaining = data.numberAscents - (page - 1) * data.perPage;
            if (data.ascents.length !== Math.min(data.perPage, remaining))
              throw new Error("theCrag returned an incomplete logbook page. Try syncing again.");
            for (const ascent of data.ascents) {
              const record = mapTheCragAscent(ascent, identity.accountId);
              if (ids.has(record.externalId))
                throw new Error("theCrag returned duplicate ascent identities. Try syncing again.");
              ids.add(record.externalId);
              records.push(record);
              highestEpoch = Math.max(highestEpoch ?? 0, ascent.epoch);
            }
            if (page * data.perPage >= data.numberAscents) break;
          }
          const recordCount = await writeClimbingRecords(db, userId, this.id, records);
          if (records.length && highestEpoch !== undefined) await progress.save(highestEpoch);
          return { recordCount, result: recordCount };
        },
        userId,
      );
      return { provider: this.id, recordsSynced, errors: [], duration: Date.now() - startedAt };
    } catch (error) {
      captureException(error, { tags: { provider: this.id, phase: "climbing_activity" } });
      if (findProviderTransportError(error)) throw error;
      return {
        provider: this.id,
        recordsSynced,
        errors: [{ message: error instanceof Error ? error.message : String(error), cause: error }],
        duration: Date.now() - startedAt,
      };
    }
  }
}
