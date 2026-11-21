import { logSync } from "../../db/sync-log.ts";
import { loadTokens } from "../../db/tokens.ts";
import { createProviderRateLimitFetch } from "../../lib/provider-rate-limit-fetch.ts";
import type { SyncDegradation } from "../../sync/sync-degradation.ts";
import { reportSyncDegradation } from "../../sync/sync-degradation-reporting.ts";
import { ProviderAuthenticationFailedError } from "../auth-errors.ts";
import type { SyncRun } from "../sync-run.ts";
import type { ProviderAuthSetup, SyncError, SyncProvider, SyncResult } from "../types.ts";
import { syncIntervalsIcuActivities } from "./activities.ts";
import { syncIntervalsIcuPlannedWorkouts } from "./calendar.ts";
import { IntervalsIcuClient } from "./client.ts";
import {
  bindIntervalsIcuAthlete,
  createIntervalsIcuAuthSetup,
  validateIntervalsIcuConfig,
} from "./oauth.ts";
import { syncIntervalsIcuWellness } from "./wellness.ts";

/** Shared shape returned by the independent Intervals.icu feeds. */
type FeedResult = Pick<SyncResult, "recordsSynced" | "errors" | "degradations">;

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
    // Independent feeds: a throw or throttle in one never discards the other's successful writes.
    const feeds: { name: string; dataType: string; sync: () => Promise<FeedResult> }[] = [
      {
        name: "Activities",
        dataType: "activities",
        sync: () => syncIntervalsIcuActivities(client, run, this.id),
      },
      {
        name: "Wellness",
        dataType: "wellness",
        sync: () => syncIntervalsIcuWellness(client, run, this.id),
      },
      {
        name: "Planned workouts",
        dataType: "planned_workouts",
        sync: () => syncIntervalsIcuPlannedWorkouts(client, run, this.id),
      },
    ];
    let recordsSynced = 0;
    const degradations: SyncDegradation[] = [];
    for (const [index, feed] of feeds.entries()) {
      let message = `${feed.name} synced`;
      try {
        const feedResult = await feed.sync();
        // Accumulate before diagnostics so a failed diagnostic write cannot drop saved counts.
        recordsSynced += feedResult.recordsSynced;
        errors.push(...feedResult.errors);
        const warnings = feedResult.degradations ?? [];
        degradations.push(...warnings);
        if (feedResult.errors.length > 0) {
          message = `${feed.name} completed with errors`;
        } else if (warnings.length > 0) {
          message = `${feed.name} completed with warnings`;
        }
        const firstWarning = warnings[0];
        if (firstWarning) {
          for (const warning of warnings) reportSyncDegradation(warning);
          await logSync(run.db, {
            providerId: this.id,
            dataType: feed.dataType,
            status: "degraded",
            recordCount: feedResult.recordsSynced,
            errorMessage: firstWarning.message,
            degradationKind: firstWarning.kind,
            userId: run.options.userId,
          });
        }
      } catch (error) {
        errors.push({
          message: `${feed.name}: ${error instanceof Error ? error.message : String(error)}`,
          cause: error,
        });
        message = `${feed.name} failed`;
      }
      run.options.onProgress?.(((index + 1) / feeds.length) * 100, message);
    }
    return {
      provider: this.id,
      recordsSynced,
      errors,
      degradations: degradations.length > 0 ? degradations : undefined,
      duration: Date.now() - start,
    };
  }
}
