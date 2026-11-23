import { createHash } from "node:crypto";
import { strengthExerciseIdentityKey } from "@dofek/training/training";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { LoggedSetComparison, LoggedSetExercise } from "../contracts/logged-set-comparison.ts";
import type { TrainingProgressionStrengthRow } from "../contracts/training-progression-strength.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import { ChartRange } from "../lib/chart-range.ts";
import type { RangeDays } from "../lib/date-window.ts";
import { dateStringSchema, executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import { selectStrengthProgressionEvidence } from "./strength-progression-evidence.ts";
import {
  type ConsolidatedSet,
  consolidatedStrengthQualityFlags,
  consolidateSets,
  estimateConsolidatedStrengthSet,
  isWorking,
  strengthSetRowSchema,
} from "./strength-set-estimate.ts";

const sourceExternalIdSchema = z.object({
  providerId: z.string(),
  externalId: z.string(),
  memberActivityId: z.string().optional(),
  subsource: z.string().nullable().optional(),
});

const rowSchema = strengthSetRowSchema.extend({
  activity_name: z.string().nullable(),
  activity_started_at: timestampStringSchema,
  activity_ended_at: timestampStringSchema.nullable(),
  session_date: dateStringSchema,
  source_providers: z.array(z.string()),
  source_external_ids: z.array(sourceExternalIdSchema).nullable().default(null),
  member_activity_ids: z.array(z.string().uuid()),
  timezone: z.string().nullable(),
  start_utc_offset_minutes: z.coerce.number().int().nullable(),
  end_utc_offset_minutes: z.coerce.number().int().nullable(),
  local_time_source: z.string(),
  muscle_groups: z.array(z.string()).nullable(),
  exercise_type: z.string().nullable(),
  movement: z.string().nullable(),
});

const coverageRowSchema = z.object({ first_observed_date: dateStringSchema.nullable() });
const cursorSchema = z
  .object({
    version: z.literal(1),
    userId: z.string().uuid(),
    shape: z.string().min(1),
    startedAt: z.string().datetime({ offset: true }),
    activityId: z.string().uuid(),
  })
  .strict();

type Row = z.infer<typeof rowSchema>;

function loggedExerciseIdentity(row: Row) {
  const name = row.exercise_name.trim().replace(/\s+/g, " ");
  const equipment = row.equipment?.trim().replace(/\s+/g, " ") || null;
  const normalizedEquipment = equipment?.toLowerCase() ?? null;
  const delimiter = " - ";
  const suffixStart = name.lastIndexOf(delimiter);
  const baseName =
    suffixStart >= 0 &&
    name.slice(suffixStart + delimiter.length).toLowerCase() === normalizedEquipment
      ? name.slice(0, suffixStart)
      : name;
  const exerciseName =
    normalizedEquipment === "dumbbell" && baseName.toLowerCase() === "bench fly"
      ? "Chest Fly"
      : baseName;
  return {
    key: strengthExerciseIdentityKey({
      exerciseName: exerciseName.toLowerCase(),
      equipment: normalizedEquipment,
    }),
    exerciseId: row.exercise_id,
    exerciseName,
    equipment: normalizedEquipment === "dumbbell" ? "Dumbbell" : equipment,
    plainName: exerciseName === name,
  };
}

function groupLoggedSetRows(rows: Row[]) {
  type ExerciseGroup = {
    display: ReturnType<typeof loggedExerciseIdentity>;
    exerciseIds: string[];
  };
  const groups = new Map<string, ExerciseGroup>();
  const byExerciseId = new Map<string, ExerciseGroup>();
  const groupedRows = rows.map((row) => {
    const known = byExerciseId.get(row.exercise_id);
    if (known) return { ...row, exerciseGroup: known };

    const identity = loggedExerciseIdentity(row);
    const group = groups.get(identity.key) ?? { display: identity, exerciseIds: [] };
    const current = group.display;
    if (
      (identity.plainName && !current.plainName) ||
      (identity.plainName === current.plainName && identity.exerciseId < current.exerciseId)
    ) {
      group.display = identity;
    }
    group.exerciseIds.push(row.exercise_id);
    groups.set(identity.key, group);
    byExerciseId.set(row.exercise_id, group);
    return { ...row, exerciseGroup: group };
  });

  // Consolidation uses exercise IDs within each workout. Give aliases the same
  // ID on these comparison rows so mirrored sets go through the existing checks.
  for (const row of groupedRows) row.exercise_id = row.exerciseGroup.display.exerciseId;
  return groupedRows;
}

export interface StrengthProgressionInput {
  startDate: string;
  endDate: string;
  providers: string[];
  exerciseIds: string[];
  cursor: string | null;
  limit: number;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function round(value: number, precision = 2): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function roundEstimate(value: number | null): number | null {
  return value === null ? null : round(value);
}

const STRENGTH_EVIDENCE_WINDOW_DAYS = 56;

function sourceExerciseIdentity(raw: Record<string, unknown>) {
  const providerExerciseId =
    typeof raw.providerExerciseId === "string" ? raw.providerExerciseId : null;
  const providerExerciseName =
    typeof raw.providerExerciseName === "string"
      ? raw.providerExerciseName
      : typeof raw.exerciseName === "string"
        ? raw.exerciseName
        : null;
  return {
    provider_exercise_id: providerExerciseId,
    provider_exercise_name: providerExerciseName,
    status:
      providerExerciseId !== null || providerExerciseName !== null
        ? ("available" as const)
        : ("unavailable" as const),
  };
}

function isWarmup(row: Row): boolean {
  return row.set_type === "warmup";
}

function volumeResult(set: ConsolidatedSet<Row>, flags: string[]) {
  if (set.conflicting || flags.length > 0) {
    return { status: "unavailable" as const, value_kg_reps: null, reason: "quality_flags" };
  }
  if (!isWorking(set.row)) {
    return { status: "unavailable" as const, value_kg_reps: null, reason: "non_working_set" };
  }
  if (set.row.weight_kg === null || set.row.reps === null) {
    return { status: "unavailable" as const, value_kg_reps: null, reason: "missing_load_or_reps" };
  }
  return {
    status: "available" as const,
    value_kg_reps: round(set.row.weight_kg * set.row.reps, 3),
    reason: null,
  };
}

function cursorShape(input: StrengthProgressionInput, timezone: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        startDate: input.startDate,
        endDate: input.endDate,
        providers: [...input.providers].sort(),
        exerciseIds: [...input.exerciseIds].sort(),
        timezone,
      }),
    )
    .digest("base64url");
}

function decodeCursor(cursor: string | null, userId: string, shape: string) {
  if (cursor === null) return null;
  try {
    const parsed = cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
    if (parsed.userId !== userId || parsed.shape !== shape) throw new Error("cursor mismatch");
    return parsed;
  } catch {
    throw new Error("Invalid strength progression cursor");
  }
}

function encodeCursor(row: Row, userId: string, shape: string): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      userId,
      shape,
      startedAt: row.activity_started_at,
      activityId: row.activity_id,
    }),
    "utf8",
  ).toString("base64url");
}

/** Exact-range, anomaly-safe strength progression over canonical activity groups. */
export class StrengthProgressionRepository extends BaseRepository {
  #localDateSql() {
    return sql`CASE
      WHEN a.local_time_source IN (
        'provider_timezone', 'device_timezone', 'user_home_timezone',
        'gps_timezone', 'home_zone_fallback'
      ) AND a.timezone IS NOT NULL
        THEN (a.started_at AT TIME ZONE a.timezone)::date
      WHEN a.local_time_source IN ('provider_offset', 'device_offset')
        AND a.start_utc_offset_minutes IS NOT NULL
        THEN ((a.started_at AT TIME ZONE 'UTC')
          + a.start_utc_offset_minutes * INTERVAL '1 minute')::date
      ELSE (a.started_at AT TIME ZONE ${this.timezone})::date
    END`;
  }

  #readRows(predicate: SQL, prior = false) {
    const localDate = this.#localDateSql();
    return executeWithSchema(
      this.db,
      rowSchema,
      sql`${prior ? sql`/* strength_progression_prior */` : sql``} SELECT
            a.id::text AS activity_id,
            a.name AS activity_name,
            a.started_at::text AS activity_started_at,
            a.ended_at::text AS activity_ended_at,
            (${localDate})::text AS session_date,
            a.source_providers,
            a.source_external_ids,
            a.member_activity_ids,
            a.timezone,
            a.start_utc_offset_minutes,
            a.end_utc_offset_minutes,
            a.local_time_source,
            strength.id::text AS set_id,
            strength.activity_id::text AS set_activity_id,
            source_activity.provider_id AS set_provider,
            exercise.id::text AS exercise_id,
            exercise.name AS exercise_name,
            exercise.equipment,
            exercise.muscle_groups,
            exercise.exercise_type,
            exercise.movement,
            strength.exercise_index,
            strength.set_index,
            strength.set_type,
            strength.weight_kg,
            strength.reps,
            strength.distance_meters,
            strength.duration_seconds,
            strength.rpe,
            strength.notes,
            strength.raw
          FROM fitness.v_activity AS a
          JOIN fitness.strength_set AS strength
            ON strength.activity_id = ANY(a.member_activity_ids)
          JOIN fitness.activity AS source_activity ON source_activity.id = strength.activity_id
          JOIN fitness.exercise AS exercise ON exercise.id = strength.exercise_id
          WHERE a.user_id = ${this.userId}::uuid
            AND ${predicate}
          ORDER BY a.started_at ${prior ? sql`ASC` : sql`DESC`}, a.id, strength.exercise_index, strength.set_index,
            strength.created_at, strength.id`,
    );
  }

  async listLoggedSetComparison(days: RangeDays): Promise<LoggedSetComparison> {
    const rows = await this.#readRows(sql`true
      ${ChartRange.fromDays(days).postgresTimestampAfterNow(sql`a.started_at`)}
      AND a.started_at <= CURRENT_TIMESTAMP
      ${this.timestampAccessPredicate(sql`a.started_at`)}`);
    const exercises = new Map<string, LoggedSetExercise>();
    const sessions = new Map<string, LoggedSetExercise["sessions"][number]>();
    for (const set of consolidateSets(groupLoggedSetRows(rows)).sets) {
      if (volumeResult(set, consolidatedStrengthQualityFlags(set)).status !== "available") continue;
      const row = set.row;
      if (row.reps === null || row.weight_kg === null) continue;
      const key = row.exercise_id;
      let exercise = exercises.get(key);
      if (!exercise) {
        const { display, exerciseIds } = row.exerciseGroup;
        exercise = {
          exerciseId: display.exerciseId,
          exerciseName: display.exerciseName,
          equipment: display.equipment,
          ...(exerciseIds.length > 1 ? { exerciseIds: [...exerciseIds].sort() } : {}),
          totalLoggedSets: 0,
          sessions: [],
          comparisons: [],
        };
        exercises.set(key, exercise);
      }
      const sessionKey = JSON.stringify([key, row.activity_id]);
      let session = sessions.get(sessionKey);
      if (!session) {
        session = {
          activityId: row.activity_id,
          date: row.session_date,
          loggedSets: 0,
          sourceProviders: [],
          heaviestSets: [],
        };
        exercise.sessions.push(session);
        sessions.set(sessionKey, session);
      }
      exercise.totalLoggedSets++;
      session.loggedSets++;
      const providers = unique(set.sourceRows.map((source) => source.set_provider));
      session.sourceProviders = unique([...session.sourceProviders, ...providers]);
      const evidence = {
        reps: row.reps,
        weightKg: row.weight_kg,
        setId: row.set_id,
        sourceProviders: providers,
      };
      const current = session.heaviestSets.findIndex((value) => value.reps === row.reps);
      const best = session.heaviestSets[current];
      if (!best) session.heaviestSets.push(evidence);
      else if (
        evidence.weightKg > best.weightKg ||
        (evidence.weightKg === best.weightKg && evidence.setId < best.setId)
      ) {
        session.heaviestSets[current] = evidence;
      }
    }
    for (const exercise of exercises.values()) {
      exercise.sessions.sort(
        (a, b) => a.date.localeCompare(b.date) || a.activityId.localeCompare(b.activityId),
      );
      const byReps = new Map<
        number,
        Map<string, LoggedSetExercise["comparisons"][number]["first"]>
      >();
      for (const session of exercise.sessions) {
        session.heaviestSets.sort((a, b) => a.reps - b.reps);
        for (const set of session.heaviestSets) {
          const dates = byReps.get(set.reps) ?? new Map();
          byReps.set(set.reps, dates);
          const endpoint = { ...set, activityId: session.activityId, date: session.date };
          const current = dates.get(session.date);
          // Sessions are ordered by activity ID within each date; keep the first equal load.
          if (!current || endpoint.weightKg > current.weightKg) {
            dates.set(session.date, endpoint);
          }
        }
      }
      exercise.comparisons = [...byReps]
        .map(([reps, dates]) => {
          const observations = [...dates.values()].sort((a, b) => a.date.localeCompare(b.date));
          const first = observations[0];
          if (!first) throw new Error("Logged set comparison requires an observation");
          return {
            reps,
            observedDates: observations.length,
            first,
            latest: observations.length > 1 ? (observations.at(-1) ?? null) : null,
          };
        })
        .sort((a, b) => b.observedDates - a.observedDates || a.reps - b.reps);
    }
    return {
      exercises: [...exercises.values()].sort(
        (a, b) =>
          a.exerciseName.localeCompare(b.exerciseName) || a.exerciseId.localeCompare(b.exerciseId),
      ),
      research: {
        summary:
          "Over eight weeks, the study found no statistically significant difference in tested squat or bench-press one-rep max gains among trained men assigned one, three, or five supervised sets per exercise per session, performed to failure. These observed logged sets and loads do not establish personal causation or prescribe set targets.",
        url: "https://pmc.ncbi.nlm.nih.gov/articles/pmid/30153194/",
      },
    };
  }

  async listRange(input: StrengthProgressionInput) {
    const localDate = this.#localDateSql();
    const providerPredicate =
      input.providers.length === 0
        ? sql`true`
        : sql`(
            source_activity.provider_id IN (${sql.join(
              input.providers.map((provider) => sql`${provider}`),
              sql`, `,
            )})
            OR a.source_providers && ARRAY[${sql.join(
              input.providers.map((provider) => sql`${provider}`),
              sql`, `,
            )}]::text[]
          )`;
    const exercisePredicate =
      input.exerciseIds.length === 0
        ? sql`true`
        : sql`strength.exercise_id IN (${sql.join(
            input.exerciseIds.map((exerciseId) => sql`${exerciseId}::uuid`),
            sql`, `,
          )})`;
    const rows = await this.#readRows(
      sql`${localDate} BETWEEN ${input.startDate}::date AND ${input.endDate}::date AND ${providerPredicate} AND ${exercisePredicate}`,
    );
    const priorRows = await this.#readRows(
      sql`${localDate} < ${input.startDate}::date AND ${providerPredicate} AND ${exercisePredicate}`,
      true,
    );

    const [coverage] = await executeWithSchema(
      this.db,
      coverageRowSchema,
      sql`SELECT MIN(${localDate})::text AS first_observed_date
          FROM fitness.v_activity AS a
          JOIN fitness.strength_set AS strength
            ON strength.activity_id = ANY(a.member_activity_ids)
          JOIN fitness.activity AS source_activity ON source_activity.id = strength.activity_id
          WHERE a.user_id = ${this.userId}::uuid
            AND ${providerPredicate}
            AND ${exercisePredicate}`,
    );

    const { sets, mergedExactDuplicateRecords, possibleDuplicateGroups } = consolidateSets(rows);
    const priorBestByExercise = new Map<
      string,
      {
        date: string;
        value_kg: number;
        set_id: string;
        provider: string;
        fatigue_marker: "Failure";
        raw: Record<string, unknown>;
        activity_id: string;
        weight_kg: number | null;
        reps: number | null;
      }
    >();
    for (const set of consolidateSets(priorRows).sets) {
      const flags = consolidatedStrengthQualityFlags(set);
      const { source, value } = estimateConsolidatedStrengthSet(set, flags);
      if (value === null) continue;
      const evidence = {
        date: set.row.session_date,
        value_kg: value,
        set_id: source.set_id,
        provider: source.set_provider,
        fatigue_marker: "Failure" as const,
        raw: source.raw,
        activity_id: set.row.activity_id,
        weight_kg: set.row.weight_kg,
        reps: set.row.reps,
      };
      const priorBest = priorBestByExercise.get(set.row.exercise_id);
      if (priorBest === undefined || value > priorBest.value_kg) {
        priorBestByExercise.set(set.row.exercise_id, evidence);
      }
    }
    const evaluatedSets = sets.map((set) => {
      const flags = consolidatedStrengthQualityFlags(set);
      return {
        set,
        flags,
        volume: volumeResult(set, flags),
        estimate: estimateConsolidatedStrengthSet(set, flags),
      };
    });

    const sessionRows = [...new Map(rows.map((row) => [row.activity_id, row])).values()];
    const shape = cursorShape(input, this.timezone);
    const cursor = decodeCursor(input.cursor, this.userId, shape);
    const filteredSessionRows = cursor
      ? sessionRows.filter(
          (row) =>
            row.activity_started_at < cursor.startedAt ||
            (row.activity_started_at === cursor.startedAt && row.activity_id > cursor.activityId),
        )
      : sessionRows;
    const hasMore = filteredSessionRows.length > input.limit;
    const pageRows = filteredSessionRows.slice(0, input.limit);
    const pageActivityIds = new Set(pageRows.map((row) => row.activity_id));

    const setOutput = (evaluated: (typeof evaluatedSets)[number]) => {
      const { set, flags, volume, estimate } = evaluated;
      const originalRecords = set.sourceRows.map((sourceRow) => ({
        provider: sourceRow.set_provider,
        activity_id: sourceRow.set_activity_id,
        set_id: sourceRow.set_id,
        values: sourceRow.raw,
        source_exercise_identity: sourceExerciseIdentity(sourceRow.raw),
      }));
      const firstOriginal = originalRecords.find((record) => Object.keys(record.values).length > 0);
      return {
        id: set.row.set_id,
        exercise_index: set.row.exercise_index,
        set_index: set.row.set_index,
        set_type: set.row.set_type,
        is_warmup: isWarmup(set.row),
        is_working_set: isWorking(set.row),
        normalized: {
          weight_kg: set.row.weight_kg,
          reps: set.row.reps,
          rpe: set.row.rpe,
          rir: null,
          rir_status: "not_recorded_by_canonical_schema" as const,
          distance_meters: set.row.distance_meters,
          duration_seconds: set.row.duration_seconds,
          notes: set.row.notes,
        },
        original: {
          status: firstOriginal ? ("available" as const) : ("unavailable" as const),
          values: firstOriginal?.values ?? null,
          reason: firstOriginal ? null : "not_recorded_for_legacy_strength_set",
          records: originalRecords,
        },
        volume,
        estimated_one_rep_max: {
          status: estimate.value === null ? ("unavailable" as const) : ("available" as const),
          value_kg: roundEstimate(estimate.value),
          formula: "Epley" as const,
          reason: estimate.reason,
        },
        quality_flags: flags,
        excluded_from_aggregates: flags.length > 0,
        provenance: {
          value_kind: "mixed" as const,
          source_set_ids: unique(set.sourceRows.map((row) => row.set_id)),
          source_activity_ids: unique(set.sourceRows.map((row) => row.set_activity_id)),
          source_providers: unique(set.sourceRows.map((row) => row.set_provider)),
          merged_duplicate: set.sourceRows.length > 1,
          calculated_fields: ["volume_kg_reps", "estimated_one_rep_max"],
        },
      };
    };

    const sessionOutputs = pageRows.map((row) => {
      const sessionSets = evaluatedSets.filter(
        (evaluated) => evaluated.set.row.activity_id === row.activity_id,
      );
      const groupedExercises = new Map<string, typeof sessionSets>();
      for (const set of sessionSets) {
        groupedExercises.set(set.set.row.exercise_id, [
          ...(groupedExercises.get(set.set.row.exercise_id) ?? []),
          set,
        ]);
      }
      return {
        activity_id: row.activity_id,
        date: row.session_date,
        started_at: row.activity_started_at,
        duration_minutes:
          row.activity_ended_at === null
            ? null
            : round(
                (new Date(row.activity_ended_at).getTime() -
                  new Date(row.activity_started_at).getTime()) /
                  60_000,
              ),
        name: row.activity_name,
        source_providers: row.source_providers,
        source_external_ids: row.source_external_ids ?? [],
        member_activity_ids: row.member_activity_ids,
        timezone: {
          value: row.timezone,
          start_utc_offset_minutes: row.start_utc_offset_minutes,
          end_utc_offset_minutes: row.end_utc_offset_minutes,
          local_time_source: row.local_time_source,
          analysis_timezone: this.timezone,
          assumed: row.local_time_source === "unknown",
        },
        quality_flags: [
          ...(row.local_time_source === "unknown" ? ["timezone_assumed_from_user_context"] : []),
          ...(sessionSets.some((set) => set.flags.length > 0)
            ? ["contains_suspicious_strength_records"]
            : []),
        ],
        exercises: [...groupedExercises.values()].map((exerciseSets) => {
          const exerciseRow = exerciseSets[0]?.set.row;
          if (!exerciseRow) throw new Error("Strength exercise group cannot be empty");
          return {
            exercise_id: exerciseRow.exercise_id,
            name: exerciseRow.exercise_name,
            equipment: exerciseRow.equipment,
            muscle_groups: exerciseRow.muscle_groups ?? [],
            exercise_type: exerciseRow.exercise_type,
            movement: exerciseRow.movement,
            normalized_identity: true,
            sets: exerciseSets.map(setOutput),
          };
        }),
      };
    });

    const groupedByExercise = new Map<string, typeof evaluatedSets>();
    for (const evaluated of evaluatedSets) {
      groupedByExercise.set(evaluated.set.row.exercise_id, [
        ...(groupedByExercise.get(evaluated.set.row.exercise_id) ?? []),
        evaluated,
      ]);
    }
    const exercises = [...groupedByExercise.values()]
      .map((exerciseSets) => {
        const firstSet = exerciseSets[0];
        if (!firstSet) throw new Error("Strength exercise group cannot be empty");
        const validVolumes = exerciseSets.flatMap((set) =>
          set.volume.value_kg_reps === null ? [] : [set.volume.value_kg_reps],
        );
        const validEstimates = exerciseSets
          .flatMap((set) =>
            set.estimate.value === null
              ? []
              : [
                  {
                    date: set.set.row.session_date,
                    value_kg: set.estimate.value,
                    set_id: set.estimate.source.set_id,
                    provider: set.estimate.source.set_provider,
                    fatigue_marker: "Failure" as const,
                    raw: set.estimate.source.raw,
                    activity_id: set.set.row.activity_id,
                    weight_kg: set.set.row.weight_kg,
                    reps: set.set.row.reps,
                  },
                ],
          )
          .sort((a, b) => a.date.localeCompare(b.date) || a.set_id.localeCompare(b.set_id));
        const dailyBestEstimates = new Map<string, (typeof validEstimates)[number]>();
        for (const estimate of validEstimates) {
          const current = dailyBestEstimates.get(estimate.date);
          if (!current || estimate.value_kg > current.value_kg) {
            dailyBestEstimates.set(estimate.date, estimate);
          }
        }
        const observations = [...dailyBestEstimates.values()].sort((a, b) =>
          a.date.localeCompare(b.date),
        );
        let priorBest = priorBestByExercise.get(firstSet.set.row.exercise_id) ?? null;
        const prs = observations.flatMap((observation) => {
          if (priorBest !== null && observation.value_kg <= priorBest.value_kg) return [];
          const result = {
            ...observation,
            value_kg: round(observation.value_kg),
            previous_best_kg: roundEstimate(priorBest?.value_kg ?? null),
            previous_best_evidence: priorBest && {
              ...priorBest,
              value_kg: round(priorBest.value_kg),
            },
          };
          priorBest = observation;
          return [result];
        });
        const firstObservation = observations[0];
        const latestObservation = observations.at(-1);
        const changes =
          firstObservation && latestObservation && firstObservation !== latestObservation
            ? {
                change_kg: round(latestObservation.value_kg - firstObservation.value_kg),
                change_percent: round(
                  ((latestObservation.value_kg - firstObservation.value_kg) /
                    firstObservation.value_kg) *
                    100,
                ),
              }
            : { change_kg: null, change_percent: null };
        const dates = unique(exerciseSets.map((set) => set.set.row.session_date));
        const activities = unique(exerciseSets.map((set) => set.set.row.activity_id));
        const daily = dates.map((date) => {
          const dateSets = exerciseSets.filter((set) => set.set.row.session_date === date);
          const dateVolumes = dateSets.flatMap((set) =>
            set.volume.value_kg_reps === null ? [] : [set.volume.value_kg_reps],
          );
          const dateWeights = dateSets.flatMap((set) =>
            set.flags.length === 0 &&
            isWorking(set.set.row) &&
            set.set.row.weight_kg !== null &&
            set.set.row.weight_kg > 0
              ? [set.set.row.weight_kg]
              : [],
          );
          return {
            date,
            sessions: unique(dateSets.map((set) => set.set.row.activity_id)).length,
            working_sets: dateSets.filter((set) => isWorking(set.set.row)).length,
            valid_working_sets: dateSets.filter((set) => set.volume.status === "available").length,
            total_volume_kg_reps: round(
              dateVolumes.reduce((sum, value) => sum + value, 0),
              3,
            ),
            max_weight_kg: dateWeights.length === 0 ? null : Math.max(...dateWeights),
            best_estimated_one_rep_max_kg: roundEstimate(
              dailyBestEstimates.get(date)?.value_kg ?? null,
            ),
          };
        });
        return {
          exercise_id: firstSet.set.row.exercise_id,
          name: firstSet.set.row.exercise_name,
          equipment: firstSet.set.row.equipment,
          muscle_groups: firstSet.set.row.muscle_groups ?? [],
          exercise_type: firstSet.set.row.exercise_type,
          movement: firstSet.set.row.movement,
          normalized_identity: true,
          frequency_days: dates.length,
          frequency_sessions: activities.length,
          working_sets: exerciseSets.filter((set) => isWorking(set.set.row)).length,
          valid_working_sets: exerciseSets.filter((set) => set.volume.status === "available")
            .length,
          total_volume_kg_reps: round(
            validVolumes.reduce((sum, value) => sum + value, 0),
            3,
          ),
          estimated_one_rep_max: {
            formula: "Epley" as const,
            first_kg: roundEstimate(firstObservation?.value_kg ?? null),
            latest_kg: roundEstimate(latestObservation?.value_kg ?? null),
            best_kg:
              observations.length === 0
                ? null
                : round(Math.max(...observations.map((observation) => observation.value_kg))),
            ...changes,
            observations: observations.map((observation) => ({
              ...observation,
              value_kg: round(observation.value_kg),
            })),
          },
          daily,
          prs,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name) || a.exercise_id.localeCompare(b.exercise_id));

    const validVolumes = evaluatedSets.flatMap((set) =>
      set.volume.value_kg_reps === null ? [] : [set.volume.value_kg_reps],
    );
    const lastPageRow = pageRows.at(-1);
    return {
      range: { start_date: input.startDate, end_date: input.endDate, timezone: this.timezone },
      channel: {
        id: "strength" as const,
        interchangeable_with: [],
        note: "Strength load remains separate from cardiovascular, climbing, and finger-loading channels.",
      },
      definitions: {
        estimated_one_rep_max:
          "Epley estimate = weight_kg × (1 + 0.0333 × repetitions), using unflagged Strong sets of 2–10 repetitions with a recorded Failure tag, verified units, and supported barbell exercise identity.",
        volume:
          "Set volume = normalized weight_kg × repetitions; warm-ups, rests, missing values, and quality-flagged records are excluded.",
        working_set:
          "Working sets include working, dropset, and failure set types; warmup and rest types are excluded.",
        anomaly_handling:
          "Original and normalized values are returned unchanged. Flagged records remain visible but are excluded from volume, e1RM, trends, and PRs.",
        duplicate_handling:
          "Exact duplicates across distinct canonical member activities are merged only when exercise occurrence alignment is unambiguous. Repeated source-local identities and ambiguous/conflicting overlaps remain visible and are excluded from aggregates.",
        personal_records:
          "An in-range e1RM is a PR only when it exceeds the anomaly-safe best before the range and every earlier valid in-range estimate; preceding-best evidence is returned.",
      },
      coverage: {
        sessions: sessionRows.length,
        source_sets: rows.length,
        sets: evaluatedSets.length,
        first_observed_date: coverage?.first_observed_date ?? null,
        timezone_assumed_sessions: sessionRows.filter((row) => row.local_time_source === "unknown")
          .length,
        merged_exact_duplicate_records: mergedExactDuplicateRecords,
        possible_duplicate_groups: possibleDuplicateGroups,
        flagged_sets: evaluatedSets.filter((set) => set.flags.length > 0).length,
        sets_excluded_from_volume: evaluatedSets.filter(
          (set) => set.volume.status === "unavailable",
        ).length,
        sets_excluded_from_estimated_one_rep_max: evaluatedSets.filter(
          (set) => set.estimate.value === null,
        ).length,
      },
      summary: {
        sessions: sessionRows.length,
        exercises: exercises.length,
        frequency_days: unique(sessionRows.map((row) => row.session_date)).length,
        valid_working_sets: evaluatedSets.filter((set) => set.volume.status === "available").length,
        total_volume_kg_reps: round(
          validVolumes.reduce((sum, value) => sum + value, 0),
          3,
        ),
      },
      exercises,
      sessions: sessionOutputs.filter((session) => pageActivityIds.has(session.activity_id)),
      pagination: {
        limit: input.limit,
        has_more: hasMore,
        next_cursor: hasMore && lastPageRow ? encodeCursor(lastPageRow, this.userId, shape) : null,
      },
    };
  }

  /**
   * Read-only training-progression evidence. Own selection stays on the server:
   * a bounded, access-windowed read feeds canonical deduplication and the same
   * Epley observation rules used by the existing strength estimate.
   */
  async getStrengthProgression(): Promise<TrainingProgressionStrengthRow[]> {
    const rows = await this.#readRows(sql`/* training_progression_strength */ true
      ${ChartRange.fromDays(STRENGTH_EVIDENCE_WINDOW_DAYS).postgresTimestampAfterNow(sql`a.started_at`)}
      AND a.started_at <= CURRENT_TIMESTAMP
      ${this.timestampAccessPredicate(sql`a.started_at`)}`);
    return selectStrengthProgressionEvidence(consolidateSets(rows).sets);
  }
}
