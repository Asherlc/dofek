import { KayaClient, KayaInvalidCredentialsError, signInToKaya } from "@dofek/kaya-client";
import { resolveProviderActivityType } from "@dofek/training/activity-types";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { upsertProviderActivity } from "../db/provider-activity-sync.ts";
import { climbingEntry } from "../db/schema/activity.ts";
import { ensureProvider, loadTokens } from "../db/tokens.ts";
import { captureException } from "../lib/error-reporting.ts";
import {
  ProviderInvalidCredentialsError,
  ProviderStoredIdentityMissingError,
} from "./auth-errors.ts";
import type { SyncRun } from "./sync-run.ts";
import type { ProviderAuthSetup, SyncError, SyncProvider, SyncResult } from "./types.ts";

const scopesSchema = z.object({ kayaUserId: z.string() });
const sentAscentTypes = new Set(["flash", "onsight", "redpoint", "repeat"]);

export class KayaSyncProvider implements SyncProvider {
  readonly id = "kaya";
  readonly name = "Kaya";
  readonly scheduledSyncLookbackDays = 30;

  constructor(readonly fetchFn: typeof fetch = globalThis.fetch) {}

  validate(): string | null {
    return null;
  }

  authSetup(): ProviderAuthSetup {
    return {
      apiBaseUrl: "https://kaya-beta.kayaclimb.com",
      automatedLogin: async (email, password) => {
        try {
          const tokens = await signInToKaya(email, password, this.fetchFn);
          return {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: new Date(Date.now() + 25 * 60_000),
            scopes: JSON.stringify({ kayaUserId: tokens.userId }),
          };
        } catch (error) {
          if (error instanceof KayaInvalidCredentialsError) {
            throw new ProviderInvalidCredentialsError(this.name, { cause: error });
          }
          throw error;
        }
      },
    };
  }

  async sync(run: SyncRun): Promise<SyncResult> {
    const startedAt = Date.now();
    const userId = run.options.userId;
    if (!userId) throw new Error("kaya sync requires a userId");
    await ensureProvider(run.db, this.id, this.name, "https://kaya-beta.kayaclimb.com", userId);
    const tokens = await loadTokens(run.db, this.id, userId);
    if (!tokens) {
      return this.#result(startedAt, 0, [
        new ProviderStoredIdentityMissingError(this.name, "credentials — connect via the app"),
      ]);
    }
    const identity = scopesSchema.safeParse(tokens.scopes ? JSON.parse(tokens.scopes) : null);
    if (!identity.success) {
      return this.#result(startedAt, 0, [
        new ProviderStoredIdentityMissingError(
          this.name,
          "account identity — reconnect via the app",
        ),
      ]);
    }
    const client = new KayaClient(tokens.accessToken, this.fetchFn);
    try {
      const [sessions, ascents] = await Promise.all([
        client.listSessions(identity.data.kayaUserId),
        client.listAscents(identity.data.kayaUserId),
      ]);
      const ascentsBySession = new Map<string, typeof ascents>();
      for (const ascent of ascents) {
        if (!ascent.session_id) continue;
        const list = ascentsBySession.get(ascent.session_id) ?? [];
        list.push(ascent);
        ascentsBySession.set(ascent.session_id, list);
      }
      let recordsSynced = 0;
      const errors: SyncError[] = [];
      for (const session of sessions) {
        const started = new Date(session.start_time);
        if (Number.isNaN(started.valueOf()) || started < run.window.since) continue;
        const row = await upsertProviderActivity(
          run.db,
          {
            providerId: this.id,
            userId,
            externalId: session.id,
            activityType: resolveProviderActivityType("rock_climbing", "rock_climbing"),
            startedAt: started,
            endedAt: session.end_time ? new Date(session.end_time) : null,
            name: session.gym ? `Kaya climbing at ${session.gym.name}` : "Kaya climbing",
            sourceName: this.name,
            raw: session,
          },
          {
            activityType: resolveProviderActivityType("rock_climbing", "rock_climbing"),
            startedAt: started,
            endedAt: session.end_time ? new Date(session.end_time) : null,
            name: session.gym ? `Kaya climbing at ${session.gym.name}` : "Kaya climbing",
            sourceName: this.name,
            raw: session,
          },
        );
        if (!row) continue;
        const sessionAscents = ascentsBySession.get(session.id) ?? [];
        await run.db.delete(climbingEntry).where(eq(climbingEntry.activityId, row.id));
        if (sessionAscents.length) {
          await run.db.insert(climbingEntry).values(
            sessionAscents.flatMap((ascent) => {
              const boulder = ascent.climb.climb_type.name.toLowerCase().includes("boulder");
              const grade = ascent.climb.grade;
              if (!grade) {
                errors.push({ message: "Kaya ascent is missing a grade", externalId: ascent.id });
                return [];
              }
              return [
                {
                  activityId: row.id,
                  externalId: ascent.id,
                  climbType: boulder ? ("boulder" as const) : ("route" as const),
                  gradeSystem: boulder ? ("v_scale" as const) : ("yds" as const),
                  grade: grade.name,
                  sent: sentAscentTypes.has(ascent.ascent_type.name.toLowerCase()),
                  attemptCount: ascent.attempts ?? 1,
                  lead: boulder ? null : ascent.climb.lead,
                  routeName: ascent.climb.name,
                  locationName: ascent.climb.gym?.name ?? session.gym?.name ?? null,
                  sourceName: this.name,
                  raw: ascent,
                },
              ];
            }),
          );
          recordsSynced += sessionAscents.length;
        }
      }
      return this.#result(startedAt, recordsSynced, errors);
    } catch (error) {
      captureException(error);
      return this.#result(startedAt, 0, [error]);
    }
  }

  #result(startedAt: number, recordsSynced: number, errors: unknown[]): SyncResult {
    return {
      provider: this.id,
      recordsSynced,
      errors: errors.map((error) => ({
        message: error instanceof Error ? error.message : String(error),
      })),
      duration: Date.now() - startedAt,
    };
  }
}
