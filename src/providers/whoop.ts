import type { CanonicalActivityType } from "@dofek/training/training";
import { and, eq } from "drizzle-orm";
import {
  mapSportId,
  parseDuringRange,
  WhoopClient,
  type WhoopCycle,
  type WhoopHrValue,
  WhoopRateLimitError,
  type WhoopRecoveryRecord,
  type WhoopSleepRecord,
  type WhoopWeightliftingWorkoutResponse,
  type WhoopWorkoutRecord,
} from "whoop-whoop";
import { z } from "zod";
import type { OAuthConfig } from "../auth/oauth.ts";
import { exchangeCodeForTokens, getOAuthRedirectUri } from "../auth/oauth.ts";
import type { SyncDatabase } from "../db/index.ts";
import {
  activity,
  dailyMetrics,
  exercise,
  exerciseAlias,
  journalEntry,
  journalQuestion,
  metricStream,
  sleepSession,
  strengthSet,
  strengthWorkout,
} from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import { logger } from "../logger.ts";
import type {
  ProviderAuthSetup,
  ProviderIdentity,
  SyncError,
  SyncOptions,
  SyncProvider,
  SyncResult,
} from "./types.ts";

export type {
  WhoopAuthToken,
  WhoopCycle,
  WhoopExerciseDetails,
  WhoopHrValue,
  WhoopRecoveryRecord,
  WhoopRecoveryScore,
  WhoopSignInResult,
  WhoopSleepRecord,
  WhoopSleepScore,
  WhoopSleepStageSummary,
  WhoopV2Activity,
  WhoopWeightliftingExercise,
  WhoopWeightliftingGroup,
  WhoopWeightliftingSet,
  WhoopWeightliftingWorkoutResponse,
  WhoopWorkoutRecord,
  WhoopWorkoutScore,
  WhoopZoneDuration,
} from "whoop-whoop";
// Re-export whoop-whoop types and client for dofek consumers
export { parseDuringRange, WhoopClient, WhoopRateLimitError } from "whoop-whoop";

// ============================================================
// Parsing — pure functions (dofek-specific shapes)
// ============================================================

function milliToMinutes(milli: number): number {
  return Math.round(milli / 60000);
}

export interface ParsedRecovery {
  cycleId: number;
  restingHr?: number;
  hrv?: number;
  spo2?: number;
  skinTemp?: number;
}

/** Resolve the effective state field (API uses `score_state` or `state` depending on version) */
function resolveRecoveryState(record: WhoopRecoveryRecord): string | undefined {
  return record.score_state ?? record.state;
}

export function parseRecovery(record: WhoopRecoveryRecord): ParsedRecovery {
  const state = resolveRecoveryState(record);

  // Legacy format: score_state === "SCORED" with nested `score` object
  if (state === "SCORED" && record.score) {
    return {
      cycleId: record.cycle_id ?? 0,
      restingHr: record.score.resting_heart_rate,
      hrv: record.score.hrv_rmssd_milli,
      spo2: record.score.spo2_percentage,
      skinTemp: record.score.skin_temp_celsius,
    };
  }
  // BFF v0 format: flat biometric fields at top level.
  // Accept any state value (or absent state) — the presence of resting_heart_rate
  // indicates scored recovery. The API has used "complete", no state, and other
  // values across different versions; keying on biometric data is more robust.
  if (record.resting_heart_rate != null) {
    return {
      cycleId: record.cycle_id ?? 0,
      restingHr: record.resting_heart_rate,
      // BFF returns hrv_rmssd in seconds; convert to milliseconds
      hrv: record.hrv_rmssd != null ? record.hrv_rmssd * 1000 : undefined,
      spo2: record.spo2_percentage ?? record.spo2,
      skinTemp: record.skin_temp_celsius,
    };
  }
  // Unscored or unrecognized format
  return { cycleId: record.cycle_id ?? 0 };
}

export interface ParsedSleep {
  externalId: string;
  startedAt: Date;
  endedAt: Date;
  durationMinutes: number;
  deepMinutes: number;
  remMinutes: number;
  lightMinutes: number;
  awakeMinutes: number;
  efficiencyPct?: number;
  sleepType: "sleep" | "nap";
  isNap: boolean;
  sleepNeedBaselineMinutes?: number;
  sleepNeedFromDebtMinutes?: number;
  sleepNeedFromStrainMinutes?: number;
  sleepNeedFromNapMinutes?: number;
}

/**
 * Zod schema for inline sleep records from the BFF v0 cycle.sleeps array.
 * The sleep-service endpoint now returns raw stage data, so we parse from
 * the cycle response instead.
 */
export const inlineSleepSchema = z.object({
  during: z.string(),
  state: z.string().optional(),
  time_in_bed: z.number(),
  wake_duration: z.number(),
  light_sleep_duration: z.number(),
  slow_wave_sleep_duration: z.number(),
  rem_sleep_duration: z.number(),
  in_sleep_efficiency: z.number().optional(),
  sleep_need: z.number().optional(),
  habitual_sleep_need: z.number().optional(),
  debt_post: z.number().optional(),
  need_from_strain: z.number().optional(),
  credit_from_naps: z.number().optional(),
  significant: z.boolean().optional(),
});

export type InlineSleepRecord = z.infer<typeof inlineSleepSchema>;

/**
 * Parse an inline sleep record from the BFF v0 cycle.sleeps array.
 * This is the primary sleep parsing path since the sleep-service endpoint
 * changed to return raw stage arrays instead of summary objects.
 */
export function parseInlineSleep(
  record: InlineSleepRecord,
  sleepIndex: number,
): ParsedSleep | null {
  let range: { start: Date; end: Date };
  try {
    range = parseDuringRange(record.during);
  } catch {
    return null;
  }
  if (Number.isNaN(range.start.getTime()) || Number.isNaN(range.end.getTime())) {
    return null;
  }

  const durationMilli = record.time_in_bed - record.wake_duration;

  return {
    externalId: `inline-${range.start.toISOString()}-${sleepIndex}`,
    startedAt: range.start,
    endedAt: range.end,
    durationMinutes: milliToMinutes(durationMilli),
    deepMinutes: milliToMinutes(record.slow_wave_sleep_duration),
    remMinutes: milliToMinutes(record.rem_sleep_duration),
    lightMinutes: milliToMinutes(record.light_sleep_duration),
    awakeMinutes: milliToMinutes(record.wake_duration),
    efficiencyPct: record.in_sleep_efficiency,
    sleepType: record.significant === false ? "nap" : "sleep",
    isNap: record.significant === false,
    sleepNeedBaselineMinutes:
      record.habitual_sleep_need != null ? milliToMinutes(record.habitual_sleep_need) : undefined,
    sleepNeedFromDebtMinutes:
      record.debt_post != null ? milliToMinutes(record.debt_post) : undefined,
    sleepNeedFromStrainMinutes:
      record.need_from_strain != null ? milliToMinutes(record.need_from_strain) : undefined,
    sleepNeedFromNapMinutes:
      record.credit_from_naps != null ? milliToMinutes(record.credit_from_naps) : undefined,
  };
}

/** Parse a sleep record from the legacy sleep-service API response. */
export function parseSleep(record: WhoopSleepRecord): ParsedSleep | null {
  // BFF v0 uses `during` range; fall back to legacy `start`/`end`
  let startedAt: Date;
  let endedAt: Date;
  if (record.during) {
    const range = parseDuringRange(record.during);
    startedAt = range.start;
    endedAt = range.end;
  } else {
    startedAt = new Date(record.start ?? "");
    endedAt = new Date(record.end ?? "");
  }

  if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) {
    return null;
  }

  const stages = record.score?.stage_summary;
  const totalSleepMilli =
    (stages?.total_in_bed_time_milli ?? 0) - (stages?.total_awake_time_milli ?? 0);
  const sleepNeeded = record.score?.sleep_needed;

  return {
    externalId: String(record.id),
    startedAt,
    endedAt,
    durationMinutes: milliToMinutes(totalSleepMilli),
    deepMinutes: milliToMinutes(stages?.total_slow_wave_sleep_time_milli ?? 0),
    remMinutes: milliToMinutes(stages?.total_rem_sleep_time_milli ?? 0),
    lightMinutes: milliToMinutes(stages?.total_light_sleep_time_milli ?? 0),
    awakeMinutes: milliToMinutes(stages?.total_awake_time_milli ?? 0),
    efficiencyPct: record.score?.sleep_efficiency_percentage,
    sleepType: record.nap ? "nap" : "sleep",
    isNap: record.nap,
    sleepNeedBaselineMinutes: sleepNeeded ? milliToMinutes(sleepNeeded.baseline_milli) : undefined,
    sleepNeedFromDebtMinutes: sleepNeeded
      ? milliToMinutes(sleepNeeded.need_from_sleep_debt_milli)
      : undefined,
    sleepNeedFromStrainMinutes: sleepNeeded
      ? milliToMinutes(sleepNeeded.need_from_recent_strain_milli)
      : undefined,
    sleepNeedFromNapMinutes: sleepNeeded
      ? milliToMinutes(sleepNeeded.need_from_recent_nap_milli)
      : undefined,
  };
}

export interface ParsedWorkout {
  externalId: string;
  activityType: CanonicalActivityType;
  startedAt: Date;
  endedAt: Date;
  durationSeconds: number;
  distanceMeters?: number;
  calories?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  totalElevationGain?: number;
  percentRecorded?: number;
}

export function parseWorkout(record: WhoopWorkoutRecord): ParsedWorkout {
  // BFF v0 uses `during` range; fall back to legacy `start`/`end`
  let startedAt: Date;
  let endedAt: Date;
  if (record.during) {
    const range = parseDuringRange(record.during);
    startedAt = range.start;
    endedAt = range.end;
  } else {
    startedAt = new Date(record.start ?? record.created_at ?? "");
    endedAt = new Date(record.end ?? record.updated_at ?? "");
  }

  return {
    externalId: record.activity_id ?? String(record.id ?? ""),
    activityType: mapSportId(record.sport_id),
    startedAt,
    endedAt,
    durationSeconds: Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
    distanceMeters: undefined, // BFF v0 doesn't include distance at top level
    calories: record.kilojoules ? Math.round(record.kilojoules / 4.184) : undefined,
    avgHeartRate: record.average_heart_rate,
    maxHeartRate: record.max_heart_rate,
    totalElevationGain: undefined,
    percentRecorded: record.percent_recorded,
  };
}

export interface ParsedHrRecord {
  recordedAt: Date;
  heartRate: number;
}

export function parseHeartRateValues(values: WhoopHrValue[]): ParsedHrRecord[] {
  return values.map((v) => ({
    recordedAt: new Date(v.time),
    heartRate: v.data,
  }));
}

/**
 * WHOOP has multiple cycle shapes:
 * - legacy: cycle.sleep.id
 * - BFF v0: cycle.recovery.sleep_id
 * - v2 activities: cycle.v2_activities[*].id where activity is sleep-related
 */
export function extractSleepIdsFromCycle(cycle: WhoopCycle): string[] {
  const ids = new Set<string>();

  if (cycle.sleep?.id != null) {
    ids.add(String(cycle.sleep.id));
  }

  if (cycle.recovery?.sleep_id != null) {
    ids.add(String(cycle.recovery.sleep_id));
  }

  for (const activity of cycle.v2_activities ?? []) {
    const activityType = activity.type.toLowerCase();
    const scoreType = activity.score_type.toLowerCase();
    const isSleepActivity = scoreType === "sleep" || activityType.includes("sleep");
    if (isSleepActivity && activity.id) {
      ids.add(activity.id);
    }
  }

  return [...ids];
}

// ============================================================
// Weightlifting parsing
// ============================================================

export interface ParsedStrengthExercise {
  exerciseName: string;
  equipment: string | null;
  providerExerciseId: string;
  exerciseIndex: number;
  muscleGroups: string[];
  exerciseType: string;
  sets: ParsedStrengthSet[];
}

export interface ParsedStrengthSet {
  setIndex: number;
  weightKg: number | null;
  reps: number | null;
  durationSeconds: number | null;
  strapLocation: string | null;
  strapLocationLaterality: string | null;
}

export interface ParsedWeightliftingWorkout {
  activityId: string;
  exercises: ParsedStrengthExercise[];
  rawMskStrainScore: number;
  scaledMskStrainScore: number;
  cardioStrainScore: number;
  cardioStrainContributionPercent: number;
  mskStrainContributionPercent: number;
}

export function parseWeightliftingWorkout(
  response: WhoopWeightliftingWorkoutResponse,
): ParsedWeightliftingWorkout {
  const exercises: ParsedStrengthExercise[] = [];
  let exerciseIndex = 0;

  for (const group of response.workout_groups) {
    for (const workoutExercise of group.workout_exercises) {
      const details = workoutExercise.exercise_details;
      const isTimeFormat = details.volume_input_format === "TIME";

      const sets: ParsedStrengthSet[] = [];
      let setIndex = 0;
      for (const set of workoutExercise.sets) {
        if (!set.complete) continue;

        sets.push({
          setIndex,
          weightKg: set.weight_kg > 0 ? set.weight_kg : null,
          reps: set.number_of_reps > 0 ? set.number_of_reps : null,
          durationSeconds: isTimeFormat && set.time_in_seconds > 0 ? set.time_in_seconds : null,
          strapLocation: set.strap_location ?? null,
          strapLocationLaterality: set.strap_location_laterality ?? null,
        });
        setIndex++;
      }

      exercises.push({
        exerciseName: details.name,
        equipment: details.equipment || null,
        providerExerciseId: details.exercise_id,
        exerciseIndex,
        muscleGroups: details.muscle_groups,
        exerciseType: details.exercise_type,
        sets,
      });
      exerciseIndex++;
    }
  }

  return {
    activityId: response.activity_id,
    exercises,
    rawMskStrainScore: response.raw_msk_strain_score,
    scaledMskStrainScore: response.scaled_msk_strain_score,
    cardioStrainScore: response.cardio_strain_score,
    cardioStrainContributionPercent: response.cardio_strain_contribution_percent,
    mskStrainContributionPercent: response.msk_strain_contribution_percent,
  };
}

// ============================================================
// Journal parsing — response shape discovered empirically
// ============================================================

export interface ParsedJournalEntry {
  question: string; // e.g. "caffeine", "alcohol", "melatonin"
  answerText: string | null;
  answerNumeric: number | null;
  impactScore: number | null;
  date: Date;
}

function getString(obj: Record<string, unknown>, key: string): string | undefined {
  const val = obj[key];
  return typeof val === "string" ? val : undefined;
}

function getArray(obj: Record<string, unknown>, key: string): unknown[] | undefined {
  const val = obj[key];
  return Array.isArray(val) ? val : undefined;
}

function toRecord(val: unknown): Record<string, unknown> | null {
  if (val && typeof val === "object" && !Array.isArray(val)) {
    return Object.fromEntries(Object.entries(val));
  }
  return null;
}

/**
 * Parse the behavior-impact-service response into health_event entries.
 * The response shape isn't documented — this handles several possibilities:
 * - Array of journal entry objects
 * - Wrapped object with entries under a known key
 * - Individual entry with nested answers
 */
export function parseJournalResponse(raw: unknown): ParsedJournalEntry[] {
  if (!raw || typeof raw !== "object") return [];

  // Unwrap if wrapped in a known key
  let items: unknown[];
  if (Array.isArray(raw)) {
    items = raw;
  } else {
    const obj = toRecord(raw);
    if (!obj) return [];
    // Try common wrapper keys
    const wrapped =
      obj.impacts ?? obj.entries ?? obj.data ?? obj.results ?? obj.journal ?? obj.records;
    if (Array.isArray(wrapped)) {
      items = wrapped;
    } else {
      // Single object — wrap it
      items = [raw];
    }
  }

  const entries: ParsedJournalEntry[] = [];
  for (const item of items) {
    const obj = toRecord(item);
    if (!obj) continue;

    // Try to extract a date
    const dateStr =
      getString(obj, "date") ??
      getString(obj, "created_at") ??
      getString(obj, "cycle_start") ??
      getString(obj, "start") ??
      getString(obj, "day");
    const date = dateStr ? new Date(dateStr) : null;
    if (!date || Number.isNaN(date.getTime())) continue;

    // Check if it has nested answers/behaviors
    const answers =
      getArray(obj, "answers") ??
      getArray(obj, "behaviors") ??
      getArray(obj, "items") ??
      getArray(obj, "journal_entries");

    if (Array.isArray(answers)) {
      for (const answer of answers) {
        const answerRecord = toRecord(answer);
        if (!answerRecord) continue;
        const question =
          getString(answerRecord, "name") ??
          getString(answerRecord, "behavior") ??
          getString(answerRecord, "question") ??
          getString(answerRecord, "type") ??
          "unknown";
        const answerNumeric =
          typeof answerRecord.value === "number"
            ? answerRecord.value
            : typeof answerRecord.score === "number"
              ? answerRecord.score
              : null;
        const answerText =
          typeof answerRecord.answer === "string"
            ? answerRecord.answer
            : typeof answerRecord.response === "string"
              ? answerRecord.response
              : typeof answerRecord.value === "string"
                ? answerRecord.value
                : null;
        const impactScore =
          typeof answerRecord.impact === "number"
            ? answerRecord.impact
            : typeof answerRecord.impact_score === "number"
              ? answerRecord.impact_score
              : null;

        entries.push({
          question: question.toLowerCase().replace(/\s+/g, "_"),
          answerText,
          answerNumeric,
          impactScore,
          date,
        });
      }
    } else {
      // Flat entry — use available fields
      const question =
        getString(obj, "name") ?? getString(obj, "behavior") ?? getString(obj, "type") ?? "journal";
      const answerNumeric =
        typeof obj.value === "number"
          ? obj.value
          : typeof obj.score === "number"
            ? obj.score
            : null;
      const answerText =
        typeof obj.answer === "string"
          ? obj.answer
          : typeof obj.response === "string"
            ? obj.response
            : null;
      const impactScore =
        typeof obj.impact === "number"
          ? obj.impact
          : typeof obj.impact_score === "number"
            ? obj.impact_score
            : null;

      entries.push({
        question: question.toLowerCase().replace(/\s+/g, "_"),
        answerText,
        answerNumeric,
        impactScore,
        date,
      });
    }
  }
  return entries;
}

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
  authSetup(): ProviderAuthSetup | undefined {
    const clientId = process.env.WHOOP_CLIENT_ID;
    const clientSecret = process.env.WHOOP_CLIENT_SECRET;
    if (!clientId || !clientSecret) return undefined;

    const config: OAuthConfig = {
      clientId,
      clientSecret,
      authorizeUrl: "https://api.prod.whoop.com/oauth/oauth2/auth",
      tokenUrl: "https://api.prod.whoop.com/oauth/oauth2/token",
      redirectUri: getOAuthRedirectUri(),
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
                  target: [dailyMetrics.date, dailyMetrics.providerId, dailyMetrics.sourceName],
                  set: {
                    restingHr: parsed.restingHr,
                    hrv: parsed.hrv,
                    spo2Avg: parsed.spo2,
                    skinTempC: parsed.skinTemp,
                  },
                });
              count++;
            } else {
              logger.warn(
                `[whoop] Skipping unrecognized recovery format: ` +
                  `state=${recoveryState}, keys=${Object.keys(cycle.recovery).join(",")}`,
              );
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
                    target: [sleepSession.providerId, sleepSession.externalId],
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

    // --- Collect all workouts from cycles (BFF v0 or legacy shape) ---
    const allWorkouts: WhoopWorkoutRecord[] = [];
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
              const parsed = parseWorkout(workoutRecord);

              await db
                .insert(activity)
                .values({
                  providerId: this.id,
                  externalId: parsed.externalId,
                  activityType: parsed.activityType,
                  startedAt: parsed.startedAt,
                  endedAt: parsed.endedAt,
                  percentRecorded: parsed.percentRecorded,
                  raw: {
                    strain: workoutRecord.score,
                    avgHeartRate: parsed.avgHeartRate,
                    maxHeartRate: parsed.maxHeartRate,
                    calories: parsed.calories,
                    durationSeconds: parsed.durationSeconds,
                  },
                })
                .onConflictDoUpdate({
                  target: [activity.providerId, activity.externalId],
                  set: {
                    activityType: parsed.activityType,
                    startedAt: parsed.startedAt,
                    endedAt: parsed.endedAt,
                    percentRecorded: parsed.percentRecorded,
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
                  target: [strengthWorkout.providerId, strengthWorkout.externalId],
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
            const BATCH_SIZE = 500;

            while (windowStart < nowMs) {
              const windowEnd = Math.min(windowStart + weekMs, nowMs);
              const startStr = new Date(windowStart).toISOString();
              const endStr = new Date(windowEnd).toISOString();

              const values = await client.getHeartRate(startStr, endStr, 6);
              const parsed = parseHeartRateValues(values);

              for (let i = 0; i < parsed.length; i += BATCH_SIZE) {
                const batch = parsed.slice(i, i + BATCH_SIZE);
                await db
                  .insert(metricStream)
                  .values(
                    batch.map((r) => ({
                      providerId: this.id,
                      recordedAt: r.recordedAt,
                      heartRate: r.heartRate,
                    })),
                  )
                  .onConflictDoNothing();
              }

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

              const userId = options?.userId ?? "00000000-0000-0000-0000-000000000001";
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
