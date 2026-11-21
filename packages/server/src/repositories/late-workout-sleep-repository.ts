import { formatDateYmdInTimeZone } from "@dofek/format/format";
import type { LateWorkoutSleep, LateWorkoutSleepNight } from "@dofek/training/late-workout-sleep";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import { dateWindowStartString, type RangeDays } from "../lib/date-window.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { scoreLateWorkoutSleepLoad } from "./late-workout-sleep-load.ts";
import { buildLateWorkoutSleepTiming } from "./late-workout-sleep-timing.ts";
import { listWorkoutWindows } from "./pre-sleep-activity-repository.ts";
import { listSleepEpisodes } from "./sleep-episode-analysis.ts";

const MAX_DAYS = 366;
const START_MINUTES = -600;
const END_MINUTES = 120;
const countSchema = z.coerce.number().int().nonnegative();
const coverageSchema = z.object({
  user_id: z.string(),
  activity_id: z.string(),
  member_activity_id: z.string().nullable(),
  started_at: z.iso.datetime().nullable(),
  ended_at: z.iso.datetime().nullable(),
  covered_seconds: countSchema,
  bpm_seconds: z.array(z.tuple([z.number(), countSchema])),
  status: z.string(),
  is_current: z.boolean(),
});

type Timing = ReturnType<typeof buildLateWorkoutSleepTiming>[number];
type Workout = Timing["workouts"][number];
type Coverage = z.infer<typeof coverageSchema>;
type Load = LateWorkoutSleepNight["load"];

const unavailableLoad = (reason: string): Load => ({
  score: null,
  category: null,
  maximums: [],
  coveredSeconds: null,
  reason,
});

function effectiveRange(days: RangeDays, endDate: string, access: AccessWindow) {
  const requestedStart = dateWindowStartString(endDate, Math.min(days ?? MAX_DAYS, MAX_DAYS) - 1);
  if (access.kind === "full") return { startDate: requestedStart, endDate };
  const permittedEnd = dateWindowStartString(access.endDateExclusive, 1);
  const startDate = requestedStart >= access.startDate ? requestedStart : access.startDate;
  const effectiveEnd = endDate <= permittedEnd ? endDate : permittedEnd;
  return startDate <= effectiveEnd ? { startDate, endDate: effectiveEnd } : null;
}

function monthEnd(date: string): string {
  const nextMonth = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  return dateWindowStartString(nextMonth.toISOString().slice(0, 10), 1);
}

function wholeSecond(timestamp: string | null): number | null {
  return timestamp === null || /\.\d*[1-9]\d*Z$/.test(timestamp)
    ? null
    : Date.parse(timestamp) / 1000;
}

function fitWorkout(workout: Workout): boolean {
  const start = wholeSecond(workout.startedAt);
  const finish = wholeSecond(workout.endedAt);
  return workout.fitMemberId !== null && start !== null && finish !== null && finish > start;
}

function verifiedCoverage(workout: Workout, coverage: Coverage | undefined): Coverage | null {
  if (
    !coverage?.is_current ||
    coverage.status !== "complete" ||
    coverage.member_activity_id !== workout.fitMemberId
  )
    return null;
  const start = wholeSecond(coverage.started_at);
  const finish = wholeSecond(coverage.ended_at);
  if (
    start === null ||
    finish === null ||
    start !== wholeSecond(workout.startedAt) ||
    finish !== wholeSecond(workout.endedAt) ||
    finish - start !== coverage.covered_seconds ||
    coverage.bpm_seconds.reduce((sum, [, seconds]) => sum + seconds, 0) !== coverage.covered_seconds
  )
    return null;
  return coverage;
}

function duplicateMatchedDates(timing: readonly Timing[]) {
  const counts = new Map<string, number>();
  for (const { date, status } of timing) {
    if (status === "matched") counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([date]) => date));
}

function axisFor(matched: readonly Timing[]) {
  const offsets = matched.flatMap((night) =>
    [night.finishOffsetMinutes, night.actualOnsetOffsetMinutes].filter((offset) => offset !== null),
  );
  const lowerMinutes = Math.min(START_MINUTES, ...offsets);
  const upperMinutes = Math.max(END_MINUTES, ...offsets);
  return {
    lowerMinutes,
    upperMinutes,
    habitualPosition: -lowerMinutes / (upperMinutes - lowerMinutes),
  };
}

function plotPosition(
  offset: number | null,
  { lowerMinutes, upperMinutes }: LateWorkoutSleep["axis"],
) {
  return offset === null || offset < lowerMinutes || offset > upperMinutes
    ? null
    : (offset - lowerMinutes) / (upperMinutes - lowerMinutes);
}

function presentNight(
  night: Timing,
  axis: LateWorkoutSleep["axis"],
  ambiguousDates: ReadonlySet<string>,
  load: Load | undefined,
): LateWorkoutSleepNight {
  const ambiguousDate = night.status === "matched" && ambiguousDates.has(night.date);
  const reason = ambiguousDate
    ? "More than one matched sleep episode ends on this date."
    : night.reason;
  const timingAvailable =
    night.finishOffsetMinutes !== null || night.minutesFromFinishToSleep !== null;
  return {
    episodeId: night.episodeId,
    date: night.date,
    sleepProvider: night.sleepProvider,
    sourceSessionIds: night.selectedEpisode.timing.source_session_ids,
    sourceProviders: night.selectedEpisode.timing.source_providers,
    previousWake: night.previousWake,
    status: ambiguousDate ? "ambiguous_sleep_date" : night.status,
    reason,
    workouts: night.workouts.map(
      ({
        id,
        canonicalType,
        sourceProviders,
        fitMemberId,
        startedAt,
        endedAt,
        status,
        reason,
      }) => ({
        id,
        canonicalType,
        sourceProviders,
        fitMemberId,
        startedAt,
        endedAt,
        status,
        reason,
      }),
    ),
    bouts: night.bouts.map(
      ({ workouts, finish, finishOffsetMinutes, minutesFromFinishToSleep, inStudyWindow }) => ({
        workoutIds: workouts.map(({ id }) => id),
        finish,
        finishOffsetMinutes,
        minutesFromFinishToSleep,
        inStudyWindow,
      }),
    ),
    matchedWorkoutIds: night.matchedBout?.workouts.map(({ id }) => id) ?? [],
    habitualOnset: night.habitualOnset,
    actualOnset: night.actualOnset,
    workoutFinish:
      night.matchedBout?.finish ?? (timingAvailable ? (night.bouts[0]?.finish ?? null) : null),
    durationMinutes: night.durationMinutes,
    durationReason: night.durationReason,
    finishOffsetMinutes: night.finishOffsetMinutes,
    actualOnsetOffsetMinutes: night.actualOnsetOffsetMinutes,
    minutesFromFinishToSleep: night.minutesFromFinishToSleep,
    load:
      load ??
      unavailableLoad(
        reason ??
          "A current, complete FIT heart-rate recording is required for every workout in the bout.",
      ),
    plot: {
      workoutFinish: plotPosition(night.finishOffsetMinutes, axis),
      actualOnset: plotPosition(night.actualOnsetOffsetMinutes, axis),
    },
  };
}

export class LateWorkoutSleepRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #timezone: string;
  readonly #access: AccessWindow;
  readonly #sensorStore: Pick<ActivitySensorStore, "query">;

  constructor(
    db: Pick<Database, "execute">,
    userId: string,
    timezone: string,
    access: AccessWindow,
    sensorStore: Pick<ActivitySensorStore, "query">,
  ) {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
    this.#access = access;
    this.#sensorStore = sensorStore;
  }

  async list({ days, endDate }: { days: RangeDays; endDate: string }): Promise<LateWorkoutSleep> {
    const range = effectiveRange(days, endDate, this.#access);
    if (!range) {
      return {
        range: { startDate: null, endDate: null, timezone: this.#timezone },
        matchedNightCount: 0,
        measuredLoadNightCount: 0,
        axis: axisFor([]),
        nights: [],
      };
    }
    const monthStart = `${range.startDate.slice(0, 7)}-01`;
    const contextStart = this.#permittedStart(dateWindowStartString(monthStart, 3));
    const monthFinish = monthEnd(range.endDate);
    const permittedEnd =
      this.#access.kind === "limited" && monthFinish >= this.#access.endDateExclusive
        ? dateWindowStartString(this.#access.endDateExclusive, 1)
        : monthFinish;
    const episodes = await listSleepEpisodes(this.#sensorStore, {
      userId: this.#userId,
      startDate: contextStart,
      endDate: permittedEnd,
      profileTimezone: this.#timezone,
      detectedOnsetAccess: {
        startDate: this.#access.kind === "limited" ? this.#access.startDate : contextStart,
        endDate:
          this.#access.kind === "limited"
            ? dateWindowStartString(this.#access.endDateExclusive, 1)
            : permittedEnd,
        timezone: this.#timezone,
      },
    });
    const windows = await listWorkoutWindows(
      this.#db,
      this.#userId,
      episodes.filter(({ date }) => date <= range.endDate),
      { startDate: contextStart, endDate: permittedEnd, timezone: this.#timezone },
    );
    const timing = buildLateWorkoutSleepTiming(episodes, windows, {
      ...range,
      timezone: this.#timezone,
    });
    const ambiguousDates = duplicateMatchedDates(timing);
    const matched = timing.filter(
      ({ date, status }) => status === "matched" && !ambiguousDates.has(date),
    );
    const axis = axisFor(matched);
    const loads = await this.#load(matched);
    const nights = timing.map((night) =>
      presentNight(night, axis, ambiguousDates, loads.get(night.episodeId)),
    );
    return {
      range: { ...range, timezone: this.#timezone },
      matchedNightCount: matched.length,
      measuredLoadNightCount: nights.filter(({ load }) => load.score !== null).length,
      axis,
      nights,
    };
  }

  #permittedStart(date: string): string {
    return this.#access.kind === "limited" && date < this.#access.startDate
      ? this.#access.startDate
      : date;
  }

  async #load(nights: readonly Timing[]): Promise<Map<string, Load>> {
    const loads = new Map<string, Load>();
    const candidates = nights.flatMap((night) => {
      const workouts = night.matchedBout?.workouts;
      return workouts?.length && workouts.every(fitWorkout)
        ? [{ episodeId: night.episodeId, workouts }]
        : [];
    });
    const activityIds = [
      ...new Set(candidates.flatMap(({ workouts }) => workouts.map(({ id }) => id))),
    ];
    if (activityIds.length === 0) return loads;

    const coverage = await this.#sensorStore.query(
      coverageSchema,
      `WITH selected AS MATERIALIZED (
        SELECT *
        FROM analytics.activity_fit_heart_rate FINAL
        WHERE user_id = {userId:UUID} AND activity_id IN {activityIds:Array(UUID)}
      ), current_groups AS (
        SELECT activity_id, user_id, refresh_version
        FROM analytics.deduped_activities FINAL
        WHERE user_id = {userId:UUID} AND activity_id IN {activityIds:Array(UUID)} AND is_deleted = 0
      ), members AS (
        SELECT activity_id, user_id, member_activity_id
        FROM analytics.deduped_activity_members FINAL
        WHERE user_id = {userId:UUID}
          AND member_activity_id IN (SELECT member_activity_id FROM selected)
          AND is_deleted = 0
      ), sources AS (
        SELECT activity_id, user_id, source_synced_at, started_at, ended_at
        FROM analytics.activity_source_records FINAL
        WHERE user_id = {userId:UUID}
          AND activity_id IN (SELECT member_activity_id FROM selected)
          AND provider_id = 'fit-file' AND is_deleted = 0
      ), sensor_versions AS (
        SELECT activity_id, user_id, max(refresh_version) AS refresh_version
        FROM analytics.activity_sensor_sample
        WHERE user_id = {userId:UUID} AND activity_id IN {activityIds:Array(UUID)}
        GROUP BY activity_id, user_id
      )
      SELECT
        toString(selected.user_id) AS user_id, toString(selected.activity_id) AS activity_id,
        toString(selected.member_activity_id) AS member_activity_id,
        formatDateTime(selected.started_at, '%FT%T.%fZ', 'UTC') AS started_at,
        formatDateTime(selected.ended_at, '%FT%T.%fZ', 'UTC') AS ended_at,
        selected.covered_seconds, selected.bpm_seconds, selected.status,
        toBool(coalesce(
          selected.is_deleted = 0 AND selected.source_activity_version = current_groups.refresh_version
          AND isNotNull(members.member_activity_id)
          AND isNotNull(sources.activity_id)
          AND selected.started_at = sources.started_at AND selected.ended_at = sources.ended_at
          AND selected.source_member_version = coalesce(toUInt64(toUnixTimestamp64Nano(sources.source_synced_at)), toUInt64(0))
          AND selected.source_sensor_version = coalesce(sensor_versions.refresh_version, toUInt64(0)),
          false
        )) AS is_current
      FROM selected
      LEFT JOIN current_groups ON current_groups.user_id = selected.user_id AND current_groups.activity_id = selected.activity_id
      LEFT JOIN members ON members.user_id = selected.user_id
        AND members.activity_id = selected.activity_id AND members.member_activity_id = selected.member_activity_id
      LEFT JOIN sources ON sources.user_id = selected.user_id AND sources.activity_id = selected.member_activity_id
      LEFT JOIN sensor_versions ON sensor_versions.user_id = selected.user_id AND sensor_versions.activity_id = selected.activity_id
      SETTINGS enable_materialized_cte = 1, join_use_nulls = 1`,
      { userId: this.#userId, activityIds },
    );
    const byId = new Map(
      coverage.filter((row) => row.user_id === this.#userId).map((row) => [row.activity_id, row]),
    );
    const complete = candidates.flatMap(({ episodeId, workouts }) => {
      const recordings = workouts.map((workout) => ({
        date: formatDateYmdInTimeZone(workout.startedAt, this.#timezone),
        samples: verifiedCoverage(workout, byId.get(workout.id))?.bpm_seconds ?? null,
      }));
      return recordings.every(({ samples }) => samples !== null) ? [{ episodeId, recordings }] : [];
    });
    if (complete.length === 0) return loads;
    const [profile] = await executeWithSchema(
      this.#db,
      z.object({ max_hr: z.number().nullable(), birth_date: dateStringSchema.nullable() }),
      sql`SELECT max_hr, birth_date FROM fitness.user_profile WHERE id = ${this.#userId}::uuid`,
    );
    for (const { episodeId, recordings } of complete) {
      loads.set(
        episodeId,
        scoreLateWorkoutSleepLoad(recordings, {
          maxHeartRate: profile?.max_hr ?? null,
          birthDate: profile?.birth_date ?? null,
        }),
      );
    }
    return loads;
  }
}
