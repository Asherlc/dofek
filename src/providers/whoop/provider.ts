import { parseRetryAfterHeader } from "@dofek/provider-http/rate-limit";
import { WhoopRateLimitError } from "@dofek/whoop/client";
import { ensureProvider } from "../../db/tokens.ts";
import { createProviderRateLimitFetch } from "../../lib/provider-rate-limit-fetch.ts";
import { resolveScopedUserId } from "../../lib/user-context.ts";
import type { SyncRun } from "../sync-run.ts";
import type { SyncProvider, SyncResult } from "../types.ts";
import { runWhoopOrchestratedSync } from "./sync-orchestrator.ts";

export class WhoopProvider implements SyncProvider {
  readonly id = "whoop";
  readonly name = "WHOOP (Cloud)";
  readonly scheduledSyncLookbackDays = 30;
  #baseFetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#baseFetchFn = fetchFn;
  }

  validate(): string | null {
    // WHOOP is always "enabled" — auth state is checked at sync time via stored tokens
    return null;
  }

  async sync(run: SyncRun): Promise<SyncResult> {
    const start = Date.now();
    const scopedUserId = resolveScopedUserId(run.options.userId);
    await ensureProvider(run.db, this.id, this.name, undefined, scopedUserId);
    const fetchFn = createProviderRateLimitFetch("whoop", this.#baseFetchFn, {
      scope: "user",
      userId: scopedUserId,
      createRateLimitError: (response, responseBody) =>
        new WhoopRateLimitError(
          `WHOOP API rate limit exceeded (${response.status}): ${responseBody}`,
          responseBody,
          parseRetryAfterHeader(response.headers.get("Retry-After")),
          scopedUserId,
        ),
    });
    return runWhoopOrchestratedSync(run, fetchFn, start);
  }
}
