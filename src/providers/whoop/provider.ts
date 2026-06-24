import { ensureProvider } from "../../db/tokens.ts";
import { createProviderRateLimitFetch } from "../../lib/provider-rate-limit-fetch.ts";
import type { SyncRun } from "../sync-run.ts";
import type { SyncProvider, SyncResult } from "../types.ts";
import { runWhoopOrchestratedSync } from "./sync-orchestrator.ts";

export class WhoopProvider implements SyncProvider {
  readonly id = "whoop";
  readonly name = "WHOOP (Cloud)";
  readonly scheduledSyncLookbackDays = 30;
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = createProviderRateLimitFetch("whoop", fetchFn);
  }

  validate(): string | null {
    // WHOOP is always "enabled" — auth state is checked at sync time via stored tokens
    return null;
  }

  async sync(run: SyncRun): Promise<SyncResult> {
    const start = Date.now();
    await ensureProvider(run.db, this.id, this.name, undefined, run.options.userId);
    return runWhoopOrchestratedSync(run, this.#fetchFn, start);
  }
}
