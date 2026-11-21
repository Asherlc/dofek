import { loadTokens } from "../../db/tokens.ts";
import { createProviderRateLimitFetch } from "../../lib/provider-rate-limit-fetch.ts";
import { ProviderAuthenticationFailedError } from "../auth-errors.ts";
import type { SyncRun } from "../sync-run.ts";
import type { ProviderAuthSetup, SyncError, SyncProvider, SyncResult } from "../types.ts";
import { syncIntervalsIcuActivities } from "./activities.ts";
import { IntervalsIcuClient } from "./client.ts";
import {
  bindIntervalsIcuAthlete,
  createIntervalsIcuAuthSetup,
  validateIntervalsIcuConfig,
} from "./oauth.ts";

export class IntervalsIcuProvider implements SyncProvider {
  readonly id = "intervals.icu";
  readonly name = "Intervals.icu";
  readonly #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    // App-scoped (default) budget: all users share the OAuth app's rate limit.
    this.#fetchFn = createProviderRateLimitFetch(this.id, fetchFn);
  }

  validate(): string | null {
    return validateIntervalsIcuConfig();
  }

  authSetup(options?: { host?: string }): ProviderAuthSetup | undefined {
    return createIntervalsIcuAuthSetup(options);
  }

  activityUrl(externalId: string): string {
    return `https://intervals.icu/activities/${externalId}`;
  }

  async sync(run: SyncRun): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    const fail = (error: unknown): SyncResult => {
      errors.push({
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });
      return { provider: this.id, recordsSynced: 0, errors, duration: Date.now() - start };
    };

    let tokens: Awaited<ReturnType<typeof loadTokens>>;
    try {
      tokens = await loadTokens(run.db, this.id, run.options.userId);
      if (!tokens) throw new ProviderAuthenticationFailedError(this.name);
      const athleteId = tokens.providerAccountId?.trim();
      if (!athleteId) throw new Error("Intervals.icu connection is missing its athlete ID");
      if (!run.options.userId) throw new Error("Intervals.icu sync requires a user ID");
      await bindIntervalsIcuAthlete(run.db, run.options.userId, athleteId);
    } catch (error) {
      return fail(error);
    }

    const client = new IntervalsIcuClient(tokens.accessToken, this.#fetchFn);
    const activities = await syncIntervalsIcuActivities(client, run, this.id);
    errors.push(...activities.errors);
    return {
      provider: this.id,
      recordsSynced: activities.recordsSynced,
      errors,
      degradations: activities.degradations.length > 0 ? activities.degradations : undefined,
      duration: Date.now() - start,
    };
  }
}
