import { parseTrainerRoadActivity, TrainerRoadClient } from "trainerroad-client";
import type { SyncDatabase } from "../db/index.ts";
import { activity } from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens } from "../db/tokens.ts";
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
    this.#fetchFn = fetchFn;
  }

  validate(): string | null {
    return null;
  }

  authSetup(): ProviderAuthSetup {
    const fetchFn = this.#fetchFn;
    return {
      oauthConfig: {
        clientId: "",
        authorizeUrl: `${TRAINERROAD_BASE}/app/login`,
        tokenUrl: `${TRAINERROAD_BASE}/app/login`,
        redirectUri: "",
        scopes: [],
      },
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
      exchangeCode: async () => {
        throw new Error("TrainerRoad uses automated login, not OAuth code exchange");
      },
    };
  }

  async sync(db: SyncDatabase, since: Date): Promise<SyncResult> {
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

      const usernameMatch = stored.scopes?.match(/username:(\S+)/);
      username = usernameMatch?.[1] ?? "";
      if (!username) {
        throw new Error("TrainerRoad username not found — re-authenticate");
      }

      // TrainerRoad cookies expire — user must re-authenticate when expired
      if (stored.expiresAt <= new Date()) {
        throw new Error("TrainerRoad session expired — please re-authenticate via Settings");
      }
      client = new TrainerRoadClient(stored.accessToken, this.#fetchFn);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    // Sync activities
    try {
      const activityCount = await withSyncLog(db, this.id, "activity", async () => {
        let count = 0;
        const sinceDate = formatDate(since);
        const toDate = formatDate(new Date());

        const activities = await client.getActivities(username, sinceDate, toDate);

        for (const raw of activities) {
          const parsed = parseTrainerRoadActivity(raw);
          try {
            await db
              .insert(activity)
              .values({
                providerId: this.id,
                externalId: parsed.externalId,
                activityType: parsed.activityType,
                name: parsed.name,
                startedAt: parsed.startedAt,
                endedAt: parsed.endedAt,
                raw: parsed.raw,
              })
              .onConflictDoUpdate({
                target: [activity.providerId, activity.externalId],
                set: {
                  activityType: parsed.activityType,
                  name: parsed.name,
                  startedAt: parsed.startedAt,
                  endedAt: parsed.endedAt,
                  raw: parsed.raw,
                },
              });
            count++;
          } catch (err) {
            errors.push({
              message: err instanceof Error ? err.message : String(err),
              externalId: parsed.externalId,
              cause: err,
            });
          }
        }

        return { recordCount: count, result: count };
      });
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
