import type { TokenSet } from "../../auth/oauth.ts";
import type { SourceClimbingLogEntry } from "../../db/climbing-log-sync.ts";
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
import { isTheCragPublicProfileScope, THECRAG_PUBLIC_PROFILE_SCOPE } from "./identity.ts";
import { writeClimbingRecords } from "./persistence.ts";
import {
  type PublicAscentReference,
  parsePublicAscent,
  parsePublicFeed,
  publicFeedUrl,
  publicProfileAccount,
  publicProfileUsername,
} from "./public-parsing.ts";
import { createTheCragPublicFetch } from "./public-transport.ts";

const API_BASE_URL = "https://www.thecrag.com/api";
const ORIGIN = "https://www.thecrag.com";

async function publicResponse(
  fetchFn: typeof fetch,
  url: string,
  signal?: AbortSignal,
): Promise<Response> {
  const response = await fetchFn(url, {
    method: "GET",
    redirect: "manual",
    headers: { Accept: "application/atom+xml, application/json, text/html" },
    signal,
  });
  if (response.status !== 200)
    throw new Error(
      `theCrag public request failed (${response.status}). Try again when public access is available.`,
    );
  if (response.url) {
    const requested = new URL(url);
    const received = new URL(response.url);
    const receivedPath = received.pathname.replace(/^\/en\//, "/");
    if (
      received.origin !== ORIGIN ||
      receivedPath !== requested.pathname ||
      received.search !== requested.search ||
      received.username ||
      received.password ||
      received.hash
    )
      throw new Error(
        "theCrag redirected to a different or nonpublic resource. Check that your profile and ascents are public, then try again.",
      );
  }
  return response;
}

export class TheCragProvider implements SyncProvider {
  readonly id = "thecrag";
  readonly name = "theCrag";
  readonly #fetchFn: typeof fetch;

  constructor(fetchFn: typeof globalThis.fetch = createTheCragPublicFetch()) {
    this.#fetchFn = createProviderRateLimitFetch(this.id, fetchFn);
  }

  validate(): string | null {
    return null;
  }

  authSetup(): ProviderAuthSetup {
    return {
      apiBaseUrl: API_BASE_URL,
      manualToken: {
        kind: "public-profile",
        label: "theCrag profile URL or username",
        instructionsUrl: "https://www.thecrag.com/",
        exchangeToken: async (input): Promise<TokenSet> => {
          const username = publicProfileUsername(input);
          const url = new URL(`${API_BASE_URL}/lookup/climber`);
          url.searchParams.set("search", username);
          const response = await publicResponse(this.#fetchFn, url.href);
          let body: unknown;
          try {
            body = await response.json();
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            const safeError = new Error(
              "theCrag returned an invalid public profile response. Check your username and try again.",
            );
            captureException(safeError, { tags: { provider: this.id, phase: "public_profile" } });
            throw safeError;
          }
          const accountId = publicProfileAccount(body, username);
          return {
            accessToken: username,
            refreshToken: null,
            expiresAt: new Date("2099-12-31T00:00:00.000Z"),
            scopes: THECRAG_PUBLIC_PROFILE_SCOPE,
            providerAccountId: accountId,
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
          "public profile — reconnect in Data Sources using your username or profile URL",
        );
      if (!isTheCragPublicProfileScope(tokens.scopes))
        throw new ProviderStoredIdentityInvalidError(
          "Revoke your old personal API key in theCrag Settings → API Keys, then reconnect using your public username/profile URL.",
        );
      const accountId = tokens.providerAccountId;
      if (!accountId || !/^[1-9]\d*$/.test(accountId))
        throw new ProviderStoredIdentityMissingError(
          this.name,
          "account identity — reconnect in Data Sources",
        );
      const username = publicProfileUsername(tokens.accessToken);
      if (username !== tokens.accessToken)
        throw new ProviderStoredIdentityMissingError(
          this.name,
          "public profile identity — reconnect in Data Sources",
        );
      recordsSynced = await withSyncLog(
        db,
        this.id,
        "climbing_activity",
        async () => {
          const references = new Map<string, PublicAscentReference>();
          const visited = new Set<string>();
          let next: string | null = publicFeedUrl(accountId);
          while (next) {
            if (visited.has(next) || visited.size >= 100)
              throw new Error(
                "theCrag public feed pagination could not complete because it looped or exceeded 100 pages. Contact support to investigate the public feed pagination.",
              );
            visited.add(next);
            const response = await publicResponse(this.#fetchFn, next, options.signal);
            const page = parsePublicFeed(await response.text(), accountId);
            for (const item of page.items) {
              const previous = references.get(item.id);
              if (previous && previous.routeId !== item.routeId)
                throw new Error("theCrag returned conflicting public ascent identifiers.");
              references.set(item.id, item);
            }
            next = page.next;
          }
          const records: SourceClimbingLogEntry[] = [];
          for (const reference of references.values()) {
            const response = await publicResponse(
              this.#fetchFn,
              `${ORIGIN}/ascent/${reference.id}`,
              options.signal,
            );
            records.push(parsePublicAscent(await response.text(), reference, username));
          }
          const recordCount = await writeClimbingRecords(db, userId, this.id, records);
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
