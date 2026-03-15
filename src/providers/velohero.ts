import { parseVeloHeroWorkout, VeloHeroClient } from "velohero-client";
import type { Database } from "../db/index.ts";
import { activity } from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import type { Provider, ProviderAuthSetup, SyncError, SyncResult } from "./types.ts";

const VELOHERO_BASE_URL = "https://app.velohero.com";

// ============================================================
// Helper: format date as YYYY-MM-DD
// ============================================================

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ============================================================
// Provider implementation
// ============================================================

export class VeloHeroProvider implements Provider {
  readonly id = "velohero";
  readonly name = "VeloHero";
  private fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.fetchFn = fetchFn;
  }

  validate(): string | null {
    // VeloHero is always "enabled" — auth state checked at sync time via stored tokens
    return null;
  }

  authSetup(): ProviderAuthSetup {
    const fetchFn = this.fetchFn;
    return {
      oauthConfig: {
        clientId: "",
        clientSecret: "",
        authorizeUrl: `${VELOHERO_BASE_URL}/sso`,
        tokenUrl: `${VELOHERO_BASE_URL}/sso`,
        redirectUri: "",
        scopes: [],
      },
      automatedLogin: async (email: string, password: string) => {
        const result = await VeloHeroClient.signIn(email, password, fetchFn);
        return {
          accessToken: result.sessionCookie,
          refreshToken: null,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // sessions likely expire in ~24h
          scopes: `userId:${result.userId}`,
        };
      },
      exchangeCode: async () => {
        throw new Error("VeloHero uses automated login, not OAuth code exchange");
      },
    };
  }

  async sync(db: Database, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, VELOHERO_BASE_URL);

    // Resolve session — re-authenticate if expired
    let client: VeloHeroClient;
    try {
      const stored = await loadTokens(db, this.id);
      if (!stored) {
        throw new Error("VeloHero not connected — authenticate via the web UI");
      }

      // Re-authenticate if token expired (session cookies expire)
      if (stored.expiresAt <= new Date()) {
        const username = process.env.VELOHERO_USERNAME;
        const password = process.env.VELOHERO_PASSWORD;
        if (!username || !password) {
          throw new Error(
            "VeloHero session expired and VELOHERO_USERNAME/VELOHERO_PASSWORD not set for re-auth",
          );
        }
        console.log("[velohero] Session expired, re-authenticating...");
        const result = await VeloHeroClient.signIn(username, password, this.fetchFn);
        const tokens = {
          accessToken: result.sessionCookie,
          refreshToken: null,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          scopes: `userId:${result.userId}`,
        };
        await saveTokens(db, this.id, tokens);
        client = new VeloHeroClient(result.sessionCookie, this.fetchFn);
      } else {
        client = new VeloHeroClient(stored.accessToken, this.fetchFn);
      }
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    // Fetch and sync activities
    const sinceDate = formatDate(since);
    const toDate = formatDate(new Date());

    try {
      const activityCount = await withSyncLog(db, this.id, "activity", async () => {
        let count = 0;

        console.log(`[velohero] Fetching workouts from ${sinceDate} to ${toDate}`);
        const workouts = await client.getWorkouts(sinceDate, toDate);
        console.log(`[velohero] Fetched ${workouts.length} workouts`);

        for (const workout of workouts) {
          const parsed = parseVeloHeroWorkout(workout);
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
