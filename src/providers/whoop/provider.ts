import { and, eq } from "drizzle-orm";
import { WhoopClient, WhoopRateLimitError } from "whoop-whoop/client";
import type { WhoopCycle, WhoopWorkoutRecord } from "whoop-whoop/types";
import { parseDuringRange } from "whoop-whoop/utils";
import { z } from "zod";
import type { OAuthConfig } from "../../auth/oauth.ts";
import { exchangeCodeForTokens, getOAuthRedirectUri } from "../../auth/oauth.ts";
import type { SyncDatabase } from "../../db/index.ts";
import { writeMetricStreamBatch } from "../../db/metric-stream-writer.ts";
import {
  activity,
  dailyMetrics,
  exercise,
  exerciseAlias,
  journalEntry,
  journalQuestion,
  sleepSession,
  sleepStage,
  strengthSet,
  strengthWorkout,
} from "../../db/schema.ts";
import { SOURCE_TYPE_API } from "../../db/sensor-channels.ts";
import { withSyncLog } from "../../db/sync-log.ts";
import { getTokenUserId } from "../../db/token-user-context.ts";
import { ensureProvider, loadTokens, saveTokens } from "../../db/tokens.ts";
import { logger } from "../../logger.ts";
import type {
  ProviderAuthSetup,
  ProviderIdentity,
  SyncError,
  SyncOptions,
  SyncProvider,
  SyncResult,
} from "../types.ts";
import { parseJournalResponse } from "./journal-parsing.ts";
import {
  buildV2ActivityTypeLookup,
  extractSleepIdsFromCycle,
  inlineSleepSchema,
  parseHeartRateValues,
  parseInlineSleep,
  parseRecovery,
  parseSleepStages,
  parseWeightliftingWorkout,
  parseWorkout,
  resolveRecoveryState,
} from "./parsing.ts";

// ============================================================
// Provider implementation
// ============================================================

export class WhoopProvider implements SyncProvider {
  readonly id = "whoop";
  readonly name = "WHOOP";
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = fetchFn;
  }

  validate(): string | null {
    // WHOOP is always "enabled" — auth state is checked at sync time via stored tokens
    return null;
  }

  /**
   * Returns OAuth setup for login via Whoop.
   * Returns undefined if WHOOP_CLIENT_ID or WHOOP_CLIENT_SECRET are not set.
   * Whoop supports OAuth for login, but data sync can continue using Cognito tokens.
   */
  authSetup(options?: { host?: string }): ProviderAuthSetup | undefined {
    const clientId = process.env.WHOOP_CLIENT_ID;
    const clientSecret = process.env.WHOOP_CLIENT_SECRET;
    if (!clientId || !clientSecret) return undefined;

    const config: OAuthConfig = {
      clientId,
      clientSecret,
      authorizeUrl: "https://api.prod.whoop.com/oauth/oauth2/auth",
      tokenUrl: "https://api.prod.whoop.com/oauth/oauth2/token",
      redirectUri: getOAuthRedirectUri(options?.host),
      scopes: ["read:profile"],
    };
    const fetchFn = this.#fetchFn;

    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeCodeForTokens(config, code, fetchFn),
      getUserIdentity: async (accessToken: string): Promise<ProviderIdentity> => {
        const response = await fetchFn(
          "https://api.prod.whoop.com/developer/v2/user/profile/basic",
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Whoop profile API error (${response.status}): ${text}`);
        }
        const whoopProfileSchema = z.object({
          user_id: z.number(),
          email: z.string().nullish(),
          first_name: z.string().nullish(),
          last_name: z.string().nullish(),
        });
        const data = whoopProfileSchema.parse(await response.json());
        const nameParts = [data.first_name, data.last_name].filter(Boolean);
        return {
          providerAccountId: String(data.user_id),
          email: data.email ?? null,
          name: nameParts.length > 0 ? nameParts.join(" ") : null,
        };
      },
    };
  }

  async sync(db: SyncDatabase, since: Date, options?: SyncOptions): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name);

    let client: WhoopClient;
    try {
      // Try loading stored tokens from DB
      const stored = await loadTokens(db, this.id);
      if (!stored?.refreshToken) {
        throw new Error("WHOOP not connected — authenticate via the web UI");
      }

      // Extract stored userId from scopes (saved as "userId:12345" during auth)
      const storedUserIdMatch = stored.scopes?.match(/userId:(\d+)/);
      const storedUserId = storedUserIdMatch ? Number(storedUserIdMatch[1]) : null;

      // Refresh the access token using the stored refresh token
      const token = await WhoopClient.refreshAccessToken(stored.refreshToken, this.#fetchFn);

      // Use the stored userId if available, otherwise use the one from bootstrap
      const userId = storedUserId ?? token.userId;
      if (!userId) {
        throw new Error("WHOOP user ID not found — re-authenticate via the web UI");
      }

      // Save the refreshed tokens back to DB, preserving the userId in scopes
      const scopes = `userId:${userId}`;
      await saveTokens(db, this.id, {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // assume ~24h expiry
        scopes,
      });

      client = new WhoopClient(
        { accessToken: token.accessToken, refreshToken: token.refreshToken, userId },
        this.#fetchFn,
        (event) => {
          const logMethod = event.status === 429 ? "warn" : "info";
          logger[logMethod]("[whoop] API request", {
            whoopUserId: event.userId,
            endpoint: event.endpoint,
            status: event.status,
            attempt: event.attempt,
            retryAfterSeconds: event.retryAfterSeconds,
            timestamp: event.timestamp.toISOString(),
          });
        },
      );
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    // --- Fetch all cycles (recovery + sleep + workouts embedded) ---
    // WHOOP API limits cycle queries to 200-day windows
    const MAX_CYCLE_WINDOW_MS = 200 * 24 * 60 * 60 * 1000;
    const cycles: WhoopCycle[] = [];
    try {
      let windowStart = since.getTime();
      const nowMs = Date.now();
      while (windowStart < nowMs) {
        const windowEnd = Math.min(windowStart + MAX_CYCLE_WINDOW_MS, nowMs);
        const startStr = new Date(windowStart).toISOString();
        const endStr = new Date(windowEnd).toISOString();
        logger.info(`[whoop] Fetching cycles ${startStr} → ${endStr}`);
        const chunk = await client.getCycles(startStr, endStr);
        cycles.push(...chunk);
        windowStart = windowEnd;
      }
      logger.info(`[whoop] Fetched ${cycles.length} total cycles`);
    } catch (err) {
      errors.push({
        message: `getCycles: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    // --- Sync recovery from cycles ---
    try {
      const recoveryCount = await withSyncLog(
        db,
        this.id,
        "recovery",
        async () => {
          let count = 0;
          for (const cycle of cycles) {
            if (!cycle.recovery) {
              continue;
            }
            const recoveryState = resolveRecoveryState(cycle.recovery);
            const hasLegacyRecovery = recoveryState === "SCORED" && cycle.recovery.score;
            // BFF v0: accept any state value if biometric data is present
            const hasBffRecovery = cycle.recovery.resting_heart_rate != null;
            if (hasLegacyRecovery || hasBffRecovery) {
              const parsed = parseRecovery(cycle.recovery);
              logger.info(
                `[whoop] Parsed recovery: rhr=${parsed.restingHr}, hrv=${parsed.hrv}, ` +
                  `spo2=${parsed.spo2}, skinTemp=${parsed.skinTemp}`,
              );
              const cycleDayRaw =
                cycle.days?.[0] ?? new Date(cycle.recovery.created_at).toISOString().split("T")[0];
              if (!cycleDayRaw) throw new Error("Could not determine cycle day");
              const cycleDay = cycleDayRaw;

              await db
                .insert(dailyMetrics)
                .values({
                  date: cycleDay,
                  providerId: this.id,
                  restingHr: parsed.restingHr,
                  hrv: parsed.hrv,
                  spo2Avg: parsed.spo2,
                  skinTempC: parsed.skinTemp,
                })
                .onConflictDoUpdate({
                  target: [
                    dailyMetrics.userId,
                    dailyMetrics.date,
                    dailyMetrics.providerId,
                    dailyMetrics.sourceName,
                  ],
                  set: {
                    restingHr: parsed.restingHr,
                    hrv: parsed.hrv,
                    spo2Avg: parsed.spo2,
                    skinTempC: parsed.skinTemp,
                  },
                });
              count++;
            } else if (recoveryState === "SCORED") {
              // Has SCORED state but no parseable biometric data — likely an API change
              logger.warn(
                `[whoop] SCORED recovery with no parseable data: ` +
                  `keys=${Object.keys(cycle.recovery).join(",")}`,
              );
            } else {
              // Pending/unscored recovery (current day before sleep, etc.) — expected
              logger.info(`[whoop] Skipping unscored recovery: state=${recoveryState}`);
            }
          }
          logger.info(
            `[whoop] Recovery sync: ${count} records inserted from ${cycles.length} cycles`,
          );
          return { recordCount: count, result: count };
        },
        options?.userId,
      );
      recordsSynced += recoveryCount;
    } catch (err) {
      errors.push({
        message: `recovery: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // --- Sync sleep from cycles ---
    try {
      const sleepCount = await withSyncLog(
        db,
        this.id,
        "sleep",
        async () => {
          let count = 0;
          for (const cycle of cycles) {
            const inlineSleeps = cycle.sleeps ?? [];
            let sleepIndex = 0;
            for (const rawSleep of inlineSleeps) {
              const parseResult = inlineSleepSchema.safeParse(rawSleep);
              if (!parseResult.success) {
                logger.warn(
                  `[whoop] Skipping inline sleep: schema mismatch: ${parseResult.error.issues[0]?.message}`,
                );
                continue;
              }
              const parsed = parseInlineSleep(parseResult.data, sleepIndex);
              sleepIndex++;
              if (!parsed) {
                logger.warn("[whoop] Skipping inline sleep: invalid timestamps");
                continue;
              }
              // Skip incomplete (in-progress) sleeps
              if (parseResult.data.state !== "complete") continue;

              try {
                await db
                  .insert(sleepSession)
                  .values({
                    providerId: this.id,
                    externalId: parsed.externalId,
                    startedAt: parsed.startedAt,
                    endedAt: parsed.endedAt,
                    durationMinutes: parsed.durationMinutes,
                    deepMinutes: parsed.deepMinutes,
                    remMinutes: parsed.remMinutes,
                    lightMinutes: parsed.lightMinutes,
                    awakeMinutes: parsed.awakeMinutes,
                    efficiencyPct: parsed.efficiencyPct,
                    sleepType: parsed.sleepType,
                    sleepNeedBaselineMinutes: parsed.sleepNeedBaselineMinutes,
                    sleepNeedFromDebtMinutes: parsed.sleepNeedFromDebtMinutes,
                    sleepNeedFromStrainMinutes: parsed.sleepNeedFromStrainMinutes,
                    sleepNeedFromNapMinutes: parsed.sleepNeedFromNapMinutes,
                  })
                  .onConflictDoUpdate({
                    target: [sleepSession.userId, sleepSession.providerId, sleepSession.externalId],
                    set: {
                      startedAt: parsed.startedAt,
                      endedAt: parsed.endedAt,
                      durationMinutes: parsed.durationMinutes,
                      deepMinutes: parsed.deepMinutes,
                      remMinutes: parsed.remMinutes,
                      lightMinutes: parsed.lightMinutes,
                      awakeMinutes: parsed.awakeMinutes,
                      efficiencyPct: parsed.efficiencyPct,
                      sleepType: parsed.sleepType,
                      sleepNeedBaselineMinutes: parsed.sleepNeedBaselineMinutes,
                      sleepNeedFromDebtMinutes: parsed.sleepNeedFromDebtMinutes,
                      sleepNeedFromStrainMinutes: parsed.sleepNeedFromStrainMinutes,
                      sleepNeedFromNapMinutes: parsed.sleepNeedFromNapMinutes,
                    },
                  });
                count++;
              } catch (err) {
                errors.push({
                  message: `Inline sleep: ${err instanceof Error ? err.message : String(err)}`,
                  cause: err,
                });
              }
            }
          }
          return { recordCount: count, result: count };
        },
        options?.userId,
      );
      recordsSynced += sleepCount;
    } catch (err) {
      errors.push({
        message: `sleep: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // --- Sync detailed sleep stages from sleep-service ---
    try {
      const stageCount = await withSyncLog(
        db,
        this.id,
        "sleep_stages",
        async () => {
          let count = 0;
          const sleepIds = new Set<string>();
          for (const cycle of cycles) {
            const ids = extractSleepIdsFromCycle(cycle);
            for (const id of ids) sleepIds.add(id);
          }

          for (const sleepId of sleepIds) {
            try {
              const record = await client.getSleep(sleepId);
              if (!record.stages || record.stages.length === 0) continue;

              const stages = parseSleepStages(record);
              if (stages.length === 0) continue;

              // Find the session ID in our DB
              const sessionRows = await db
                .select({ id: sleepSession.id })
                .from(sleepSession)
                .where(
                  and(
                    eq(sleepSession.providerId, this.id),
                    eq(sleepSession.externalId, String(sleepId)),
                  ),
                )
                .limit(1);

              const sessionId = sessionRows[0]?.id;
              if (!sessionId) continue;

              // Insert stages
              await db.delete(sleepStage).where(eq(sleepStage.sessionId, sessionId));
              await db.insert(sleepStage).values(
                stages.map((s) => ({
                  sessionId,
                  stage: s.stage,
                  startedAt: s.startedAt,
                  endedAt: s.endedAt,
                })),
              );
              count++;
            } catch (err) {
              logger.warn(`[whoop] Failed to fetch sleep stages for ${sleepId}: ${err}`);
            }
          }
          return { recordCount: count, result: count };
        },
        options?.userId,
      );
      recordsSynced += stageCount;
    } catch (err) {
      errors.push({
        message: `sleep_stages: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // --- Collect all workouts from cycles (BFF v0 or legacy shape) ---
    // Also build a lookup from activity_id → v2_activity type name so we can
    // fall back to the human-readable type when sport_id maps to "other".
    const allWorkouts: WhoopWorkoutRecord[] = [];
    const v2ActivityTypeByActivityId = buildV2ActivityTypeLookup(cycles);
    for (const cycle of cycles) {
      const workouts = cycle.workouts ?? cycle.strain?.workouts ?? [];
      allWorkouts.push(...workouts);
    }

    // --- Sync workouts from cycles ---
    try {
      const workoutCount = await withSyncLog(
        db,
        this.id,
        "workouts",
        async () => {
          let count = 0;
          for (const workoutRecord of allWorkouts) {
            try {
              const v2TypeName = workoutRecord.activity_id
                ? v2ActivityTypeByActivityId.get(workoutRecord.activity_id)
                : undefined;
              const parsed = parseWorkout(workoutRecord, v2TypeName);
              if (!parsed) continue;

              await db
                .insert(activity)
                .values({
                  providerId: this.id,
                  externalId: parsed.externalId,
                  activityType: parsed.activityType,
                  startedAt: parsed.startedAt,
                  endedAt: parsed.endedAt,
                  raw: {
                    strain: workoutRecord.score,
                    avgHeartRate: parsed.avgHeartRate,
                    maxHeartRate: parsed.maxHeartRate,
                    calories: parsed.calories,
                    durationSeconds: parsed.durationSeconds,
                  },
                })
                .onConflictDoUpdate({
                  target: [activity.userId, activity.providerId, activity.externalId],
                  set: {
                    activityType: parsed.activityType,
                    startedAt: parsed.startedAt,
                    endedAt: parsed.endedAt,
                    raw: {
                      strain: workoutRecord.score,
                      avgHeartRate: parsed.avgHeartRate,
                      maxHeartRate: parsed.maxHeartRate,
                      calories: parsed.calories,
                      durationSeconds: parsed.durationSeconds,
                    },
                  },
                });
              count++;
            } catch (err) {
              errors.push({
                message: `Workout ${workoutRecord.activity_id}: ${err instanceof Error ? err.message : String(err)}`,
                externalId: workoutRecord.activity_id,
                cause: err,
              });
            }
          }
          return { recordCount: count, result: count };
        },
        options?.userId,
      );
      recordsSynced += workoutCount;
    } catch (err) {
      errors.push({
        message: `workouts: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // --- Sync strength workouts (exercise-level data) ---
    let rateLimited = false;
    try {
      const strengthCount = await withSyncLog(
        db,
        this.id,
        "strength",
        async () => {
          let count = 0;
          const exerciseCache = new Map<string, string>(); // providerExerciseId → exercise UUID

          for (const workoutRecord of allWorkouts) {
            const activityId = workoutRecord.activity_id;
            if (!activityId) continue;

            try {
              const weightliftingData = await client.getWeightliftingWorkout(activityId);
              if (!weightliftingData) continue; // 404 = no exercises for this workout

              const parsed = parseWeightliftingWorkout(weightliftingData);
              if (parsed.exercises.length === 0) continue;

              // Parse workout times from the weightlifting response or fall back to workout record
              const workoutDuring = weightliftingData.during ?? workoutRecord.during;
              if (!workoutDuring) continue; // skip if no time range available
              const { start: startedAt, end: endedAt } = parseDuringRange(workoutDuring);

              // Upsert strength_workout
              const [row] = await db
                .insert(strengthWorkout)
                .values({
                  providerId: this.id,
                  externalId: activityId,
                  startedAt,
                  endedAt,
                  name: weightliftingData.name ?? null,
                  rawMskStrainScore: parsed.rawMskStrainScore,
                  scaledMskStrainScore: parsed.scaledMskStrainScore,
                  cardioStrainScore: parsed.cardioStrainScore,
                  cardioStrainContributionPercent: parsed.cardioStrainContributionPercent,
                  mskStrainContributionPercent: parsed.mskStrainContributionPercent,
                })
                .onConflictDoUpdate({
                  target: [
                    strengthWorkout.userId,
                    strengthWorkout.providerId,
                    strengthWorkout.externalId,
                  ],
                  set: {
                    startedAt,
                    endedAt,
                    name: weightliftingData.name ?? null,
                    rawMskStrainScore: parsed.rawMskStrainScore,
                    scaledMskStrainScore: parsed.scaledMskStrainScore,
                    cardioStrainScore: parsed.cardioStrainScore,
                    cardioStrainContributionPercent: parsed.cardioStrainContributionPercent,
                    mskStrainContributionPercent: parsed.mskStrainContributionPercent,
                  },
                })
                .returning({ id: strengthWorkout.id });

              const workoutId = row?.id;
              if (!workoutId) continue;

              // Delete old sets, re-insert (same pattern as Strong CSV)
              await db.delete(strengthSet).where(eq(strengthSet.workoutId, workoutId));

              const setRows: (typeof strengthSet.$inferInsert)[] = [];

              for (const ex of parsed.exercises) {
                const cacheKey = ex.providerExerciseId;
                let exerciseId = exerciseCache.get(cacheKey);

                if (!exerciseId) {
                  // Upsert exercise
                  await db
                    .insert(exercise)
                    .values({
                      name: ex.exerciseName,
                      equipment: ex.equipment,
                      muscleGroups: ex.muscleGroups,
                      exerciseType: ex.exerciseType,
                    })
                    .onConflictDoNothing();

                  const whereClause = ex.equipment
                    ? and(eq(exercise.name, ex.exerciseName), eq(exercise.equipment, ex.equipment))
                    : eq(exercise.name, ex.exerciseName);

                  const exerciseRows = await db
                    .select({ id: exercise.id })
                    .from(exercise)
                    .where(whereClause)
                    .limit(1);

                  exerciseId = exerciseRows[0]?.id;
                  if (exerciseId) {
                    exerciseCache.set(cacheKey, exerciseId);

                    // Upsert alias
                    await db
                      .insert(exerciseAlias)
                      .values({
                        exerciseId,
                        providerId: this.id,
                        providerExerciseId: ex.providerExerciseId,
                        providerExerciseName: ex.exerciseName,
                      })
                      .onConflictDoNothing();
                  }
                }

                if (!exerciseId) {
                  errors.push({
                    message: `Could not resolve exercise: ${ex.exerciseName}`,
                    externalId: activityId,
                  });
                  continue;
                }

                for (const set of ex.sets) {
                  setRows.push({
                    workoutId,
                    exerciseId,
                    exerciseIndex: ex.exerciseIndex,
                    setIndex: set.setIndex,
                    setType: "working",
                    weightKg: set.weightKg,
                    reps: set.reps,
                    durationSeconds: set.durationSeconds,
                    strapLocation: set.strapLocation,
                    strapLocationLaterality: set.strapLocationLaterality,
                  });
                }
              }

              if (setRows.length > 0) {
                await db.insert(strengthSet).values(setRows);
              }
              count++;
            } catch (err) {
              errors.push({
                message: `Strength ${activityId}: ${err instanceof Error ? err.message : String(err)}`,
                externalId: activityId,
                cause: err,
              });
            }
          }

          return { recordCount: count, result: count };
        },
        options?.userId,
      );
      recordsSynced += strengthCount;
    } catch (err) {
      if (err instanceof WhoopRateLimitError) {
        rateLimited = true;
      }
      errors.push({
        message: `strength: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // --- Sync HR stream (6s intervals) ---
    if (!rateLimited) {
      try {
        const hrCount = await withSyncLog(
          db,
          this.id,
          "hr_stream",
          async () => {
            const weekMs = 7 * 24 * 60 * 60 * 1000;
            let windowStart = since.getTime();
            const nowMs = Date.now();
            let totalRecords = 0;

            while (windowStart < nowMs) {
              const windowEnd = Math.min(windowStart + weekMs, nowMs);
              const startStr = new Date(windowStart).toISOString();
              const endStr = new Date(windowEnd).toISOString();

              const values = await client.getHeartRate(startStr, endStr, 6);
              const parsed = parseHeartRateValues(values);

              const metricRows = parsed.map((r) => ({
                providerId: this.id,
                recordedAt: r.recordedAt,
                heartRate: r.heartRate,
              }));
              await writeMetricStreamBatch(db, metricRows, SOURCE_TYPE_API);

              totalRecords += parsed.length;
              windowStart = windowEnd;
            }

            return { recordCount: totalRecords, result: totalRecords };
          },
          options?.userId,
        );
        recordsSynced += hrCount;
      } catch (err) {
        if (err instanceof WhoopRateLimitError) {
          rateLimited = true;
        }
        errors.push({
          message: `hr_stream: ${err instanceof Error ? err.message : String(err)}`,
          cause: err,
        });
      }
    }

    // --- Sync journal entries ---
    if (!rateLimited) {
      try {
        const journalCount = await withSyncLog(
          db,
          this.id,
          "journal",
          async () => {
            const raw = await client.getJournal(since.toISOString(), new Date().toISOString());
            logger.info(`[whoop] Journal response shape: ${JSON.stringify(raw).slice(0, 500)}`);

            const entries = parseJournalResponse(raw);

            const userId = options?.userId ?? getTokenUserId();
            if (!userId) {
              throw new Error("WHOOP journal sync requires user context");
            }

            let count = 0;
            for (const entry of entries) {
              // Ensure the question exists in the reference table
              await db
                .insert(journalQuestion)
                .values({
                  slug: entry.question,
                  displayName: entry.question
                    .replace(/_/g, " ")
                    .replace(/\b\w/g, (c) => c.toUpperCase()),
                  category: "custom",
                  dataType: "numeric",
                })
                .onConflictDoNothing();

              await db
                .insert(journalEntry)
                .values({
                  date: entry.date.toISOString().split("T")[0] ?? "",
                  providerId: this.id,
                  userId,
                  questionSlug: entry.question,
                  answerText: entry.answerText,
                  answerNumeric: entry.answerNumeric,
                  impactScore: entry.impactScore,
                })
                .onConflictDoUpdate({
                  target: [
                    journalEntry.userId,
                    journalEntry.date,
                    journalEntry.questionSlug,
                    journalEntry.providerId,
                  ],
                  set: {
                    answerText: entry.answerText,
                    answerNumeric: entry.answerNumeric,
                    impactScore: entry.impactScore,
                  },
                });
              count++;
            }
            return { recordCount: count, result: count };
          },
          options?.userId,
        );
        recordsSynced += journalCount;
      } catch (err) {
        errors.push({
          message: `journal: ${err instanceof Error ? err.message : String(err)}`,
          cause: err,
        });
      }
    }

    return {
      provider: this.id,
      recordsSynced,
      errors,
      duration: Date.now() - start,
    };
  }
}
