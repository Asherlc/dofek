import { resolveProviderActivityType } from "@dofek/training/activity-types";
import { and, eq } from "drizzle-orm";
import { persistClimbingLogEntries } from "../../db/climbing-log-sync.ts";
import { resolveUserExerciseWithProvenance } from "../../db/exercise-provenance.ts";
import type { SyncDatabase } from "../../db/index.ts";
import { upsertProviderActivity } from "../../db/provider-activity-sync.ts";
import { strengthSet } from "../../db/schema/activity.ts";
import { climbingLogEntry } from "../../db/schema/climbing.ts";
import { withSyncLog } from "../../db/sync-log.ts";
import { ensureProvider, loadTokens, saveTokens } from "../../db/tokens.ts";
import { captureException } from "../../lib/error-reporting.ts";
import { createProviderRateLimitFetch } from "../../lib/provider-rate-limit-fetch.ts";
import { findProviderTransportError } from "../../lib/provider-transport-error.ts";
import { ProviderAuthError } from "../auth-errors.ts";
import type { ProviderAuthSetup, SyncProvider, SyncResult, SyncRun } from "../types.ts";
import { readCrimpdArchive } from "./archive.ts";
import { CrimpdClient } from "./client.ts";
import { parseCrimpdExport } from "./parser.ts";

export class CrimpdProvider implements SyncProvider {
  readonly id = "crimpd";
  readonly name = "Crimpd";
  readonly #client: CrimpdClient;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#client = new CrimpdClient(createProviderRateLimitFetch(this.id, fetchFn));
  }

  validate(): string | null {
    return null;
  }

  authSetup(): ProviderAuthSetup {
    return {
      apiBaseUrl: "https://api.crimpd.com",
      automatedLogin: (username, password) => this.#client.login(username, password),
    };
  }

  async sync(run: SyncRun): Promise<SyncResult> {
    const startedAt = Date.now();
    const result: SyncResult = { provider: this.id, recordsSynced: 0, errors: [], duration: 0 };
    try {
      const userId = run.options.userId;
      if (!userId) throw new Error("Crimpd sync requires a user context.");
      await ensureProvider(run.db, this.id, this.name, "https://api.crimpd.com", userId);
      const stored = await loadTokens(run.db, this.id, userId);
      if (!stored)
        throw new ProviderAuthError(
          "authentication_failed",
          "Crimpd is not connected. Connect Crimpd in Settings → Data Sources.",
        );
      let tokens = stored;
      let refreshed = false;
      const renew = async () => {
        tokens = await this.#client.refresh(tokens);
        await saveTokens(run.db, this.id, tokens, userId);
        refreshed = true;
      };
      result.recordsSynced = await withSyncLog(
        run.db,
        this.id,
        "activity",
        async () => {
          if (tokens.expiresAt.getTime() <= Date.now()) await renew();
          run.options.signal?.throwIfAborted();
          const directory = await mkdtemp(join(tmpdir(), "dofek-crimpd-"));
          try {
            const filePath = join(directory, "logbook.zip");
            try {
              await this.#client.downloadExport(tokens, filePath, run.options.signal);
            } catch (error) {
              if (!(error instanceof ProviderAuthError) || refreshed) throw error;
              await renew();
              await this.#client.downloadExport(tokens, filePath, run.options.signal);
            }
            run.options.signal?.throwIfAborted();
            const imported = await importCrimpdExportFile(run.db, filePath, userId);
            return { recordCount: imported.recordsSynced, result: imported.recordsSynced };
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        },
        userId,
      );
    } catch (error) {
      run.options.signal?.throwIfAborted();
      captureException(error, { tags: { provider: this.id, phase: "activity" } });
      if (findProviderTransportError(error)) throw error;
      result.errors.push({
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });
    }
    result.duration = Date.now() - startedAt;
    return result;
  }
}

export async function importCrimpdExportFile(
  db: SyncDatabase,
  filePath: string,
  userId: string,
): Promise<SyncResult> {
  const startedAt = Date.now();
  const archive = await readCrimpdArchive(filePath);
  const workouts = parseCrimpdExport(archive.workoutsCsv, archive.setsCsv);
  const recordsSynced = await db.transaction(async (tx) => {
    await ensureProvider(tx, "crimpd", "Crimpd", "https://api.crimpd.com", userId);
    let imported = 0;
    for (const workout of workouts) {
      const type =
        workout.climbingEntries.length || workout.raw.TYPE === "Open Climbing"
          ? "rock_climbing"
          : workout.raw.TARGET === "Flexibility"
            ? "flexibility"
            : [
                  "Strength Training",
                  "Compound",
                  "Upper Body",
                  "Lower Body",
                  "Core",
                  "Antagonist Muscles",
                  "Finger Strength",
                ].includes(workout.raw.TARGET ?? "")
              ? "strength"
              : "other";
      // DATE is Crimpd's logged occurrence anchor, not a measured workout start.
      const values = {
        activityType: resolveProviderActivityType(workout.raw.TYPE ?? type, type),
        startedAt: workout.loggedAt,
        endedAt: null,
        name: workout.name,
        notes: workout.notes,
        sourceName: "Crimpd",
        raw: workout.raw,
      };
      const saved = await upsertProviderActivity(
        tx,
        { providerId: "crimpd", userId, externalId: workout.externalId, ...values },
        values,
      );
      if (!saved) continue;
      const entries = [];
      for (const entry of workout.climbingEntries) {
        const [existing] = await tx
          .select({ id: climbingLogEntry.id })
          .from(climbingLogEntry)
          .where(
            and(
              eq(climbingLogEntry.userId, userId),
              eq(climbingLogEntry.providerId, "crimpd"),
              eq(climbingLogEntry.externalId, entry.externalId),
            ),
          )
          .limit(1);
        entries.push(existing ? entry : { ...entry, activityId: saved.id });
      }
      await persistClimbingLogEntries(tx, { userId, providerId: "crimpd", entries });
      for (const set of workout.sets) {
        const exerciseId = await resolveUserExerciseWithProvenance(tx, {
          userId,
          providerId: "crimpd",
          name: set.exerciseName,
          providerExerciseName: set.exerciseName,
          providerExerciseId: null,
          equipment: null,
          exerciseType: null,
          muscleGroups: null,
        });
        const setValues = {
          exerciseId,
          exerciseIndex: set.exerciseIndex,
          setIndex: set.setIndex,
          reps: set.reps,
          distanceMeters: set.distanceMeters,
          notes: set.notes,
          raw: set.raw,
        };
        const [known] = await tx
          .select({ id: strengthSet.id })
          .from(strengthSet)
          .where(
            and(
              eq(strengthSet.activityId, saved.id),
              eq(strengthSet.exerciseIndex, set.exerciseIndex),
              eq(strengthSet.setIndex, set.setIndex),
            ),
          )
          .limit(1);
        if (known) await tx.update(strengthSet).set(setValues).where(eq(strengthSet.id, known.id));
        else await tx.insert(strengthSet).values({ activityId: saved.id, ...setValues });
      }
      imported++;
    }
    return imported;
  });
  return { provider: "crimpd", recordsSynced, errors: [], duration: Date.now() - startedAt };
}

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
