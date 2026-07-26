import { TrainerRoadClient } from "@dofek/trainerroad/client";
import { parseTrainerRoadActivity } from "@dofek/trainerroad/parsing";
import {
  finishProviderActivityListSync,
  upsertProviderActivity,
} from "../db/provider-activity-sync.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens } from "../db/tokens.ts";
import { createProviderRateLimitFetch } from "../lib/provider-rate-limit-fetch.ts";
import { ProviderSessionExpiredError, ProviderStoredIdentityMissingError } from "./auth-errors.ts";
import type { SyncRun } from "./sync-run.ts";
import type { ProviderAuthSetup, SyncError, SyncProvider, SyncResult } from "./types.ts";

const TRAINERROAD_BASE = "https://www.trainerroad.com";

// ============================================================
// Helper
// ============================================================

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ============================================================
// Provider implementation
// ============================================================

export class TrainerRoadProvider implements SyncProvider {
  readonly id = "trainerroad";
  readonly name = "TrainerRoad";
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = createProviderRateLimitFetch("trainerroad", fetchFn);
  }

  validate(): string | null {
    return null;
  }

  activityUrl(externalId: string): string {
    return `https://www.trainerroad.com/app/cycling/rides/${externalId}`;
  }

  authSetup(_options?: { host?: string }): ProviderAuthSetup {
    const fetchFn = this.#fetchFn;
    return {
      automatedLogin: async (email: string, password: string) => {
        const result = await TrainerRoadClient.signIn(email, password, fetchFn);
        return {
          accessToken: result.authCookie,
          refreshToken: null,
          // TrainerRoad cookies last a long time; set 30-day expiry
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          scopes: `username:${result.username}`,
        };
      },
    };
  }

  async sync(run: SyncRun): Promise<SyncResult> {
    const { db, window, options } = run;
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, TRAINERROAD_BASE);

    let client: TrainerRoadClient;
    let username: string;
    try {
      const stored = await loadTokens(db, this.id);
      if (!stored) {
        throw new Error("TrainerRoad not connected — authenticate via the web UI");
      }

      const usernamePrefix = "username:";
      const scope = stored.scopes ?? "";
      username = scope.startsWith(usernamePrefix) ? scope.slice(usernamePrefix.length) : "";
      if (!username) {
        throw new ProviderStoredIdentityMissingError("TrainerRoad", "username");
      }

      // TrainerRoad cookies expire — user must re-authenticate when expired
      if (stored.expiresAt <= new Date()) {
        throw new ProviderSessionExpiredError("TrainerRoad");
      }
      client = new TrainerRoadClient(stored.accessToken, this.#fetchFn);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    // Sync activities
    const since = window.since;
    const syncWindowEnd = window.until;
    const presentActivityExternalIds = new Set<string>();
    try {
      const activityCount = await withSyncLog(
        db,
        this.id,
        "activity",
        async () => {
          let count = 0;
          const sinceDate = formatDate(since);
          const toDate = formatDate(syncWindowEnd);

          const activities = await client.getActivities(username, sinceDate, toDate);

          for (const raw of activities) {
            const parsed = parseTrainerRoadActivity(raw);
            presentActivityExternalIds.add(parsed.externalId);
            try {
              await upsertProviderActivity(
                db,
                {
                  providerId: this.id,
                  externalId: parsed.externalId,
                  activityType: parsed.activityType,
                  name: parsed.name,
                  startedAt: parsed.startedAt,
                  endedAt: parsed.endedAt,
                  raw: parsed.raw,
                },
                {
                  activityType: parsed.activityType,
                  name: parsed.name,
                  startedAt: parsed.startedAt,
                  endedAt: parsed.endedAt,
                  raw: parsed.raw,
                },
              );
              count++;
            } catch (err) {
              errors.push({
                message: err instanceof Error ? err.message : String(err),
                externalId: parsed.externalId,
                cause: err,
              });
            }
          }

          await finishProviderActivityListSync(db, {
            providerId: this.id,
            userId: options?.userId,
            windowStart: since,
            windowEnd: syncWindowEnd,
            presentExternalIds: presentActivityExternalIds,
          });
          return { recordCount: count, result: count };
        },
        options?.userId,
      );
      recordsSynced += activityCount;
    } catch (err) {
      errors.push({
        message: `activity: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    return {
      provider: this.id,
      recordsSynced,
      errors,
      duration: Date.now() - start,
    };
  }
}
