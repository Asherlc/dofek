import { resolveUniqueWallClockInTimezone } from "@dofek/format/record-local-time";
import type { WorkoutWindow } from "./pre-sleep-activity-repository.ts";
import { analysisLocalClock, type SleepEpisode } from "./sleep-episode-analysis.ts";

const MINUTE_MS = 60_000;
const STUDY_START = -600;
const STUDY_END = 120;
const RELAXATION_TYPES = new Set([
  "yoga",
  "stretching",
  "meditation",
  "massage",
  "massagetherapy",
  "breathwork",
  "relaxation",
]);
const OURA_NON_WORKOUT_TYPES = new Set(["nap", "rest", "body_status"]);

function referenceGroup(date: string) {
  const weekday = new Date(date).getUTCDay();
  const dayClass = weekday === 0 || weekday === 6 ? "weekend" : "weekday";
  const month = date.slice(0, 7);
  return { month, dayClass, key: `${month}:${dayClass}` } as const;
}

function detectedOnset({ timing }: SleepEpisode): string | null {
  return timing.source_provider === "polar" && timing.elapsed_minutes !== null
    ? timing.started_at
    : null;
}

function buildReferences(episodes: readonly SleepEpisode[], timezone: string) {
  const byDate = new Map<
    string,
    { episodeId: string; sleepProvider: string; offsetMs: number }[]
  >();
  for (const episode of episodes) {
    const onset = detectedOnset(episode);
    if (!onset) continue;
    const clock = analysisLocalClock(onset, timezone);
    const instantMs = Date.parse(onset);
    const wallMs =
      Date.parse(`${clock.date}T${clock.time}Z`) + new Date(instantMs).getUTCMilliseconds();
    const candidates = byDate.get(episode.date) ?? [];
    candidates.push({
      episodeId: episode.timing.selected_session_id,
      sleepProvider: episode.timing.source_provider,
      offsetMs: wallMs - Date.parse(episode.date),
    });
    byDate.set(episode.date, candidates);
  }

  const groups = new Map<
    string,
    {
      referenceNights: { date: string; episodeId: string; sleepProvider: string }[];
      ambiguousReferenceDates: string[];
      totalOffsetMs: number;
    }
  >();
  for (const [date, candidates] of [...byDate].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const { key } = referenceGroup(date);
    const group = groups.get(key) ?? {
      referenceNights: [],
      ambiguousReferenceDates: [],
      totalOffsetMs: 0,
    };
    const [first, second] = candidates;
    if (first && !second) {
      group.referenceNights.push({
        date,
        episodeId: first.episodeId,
        sleepProvider: first.sleepProvider,
      });
      group.totalOffsetMs += first.offsetMs;
    } else {
      group.ambiguousReferenceDates.push(date);
    }
    groups.set(key, group);
  }
  return groups;
}

function habitualOnsetFor(
  date: string,
  timezone: string,
  references: ReturnType<typeof buildReferences>,
) {
  const { month, dayClass, key } = referenceGroup(date);
  const group = references.get(key);
  const referenceNights = group?.referenceNights ?? [];
  const observedCount = referenceNights.length;
  const wallClock =
    group && observedCount > 0
      ? new Date(Date.parse(date) + Math.round(group.totalOffsetMs / observedCount))
      : null;
  const instant = wallClock ? resolveUniqueWallClockInTimezone(wallClock, timezone) : null;
  return {
    month,
    dayClass,
    timezone,
    referenceNights,
    observedCount,
    ambiguousReferenceDates: group?.ambiguousReferenceDates ?? [],
    timestamp: instant?.toISOString() ?? null,
    reason: instant
      ? null
      : wallClock
        ? "The habitual onset falls in a skipped or repeated local time."
        : "No unambiguous detected sleep onsets were recorded for this month and day type.",
  };
}

const workoutReasons = {
  non_workout: "This Oura record describes a nap, rest, or body status.",
  relaxation: "This activity is a relaxation exercise.",
  too_short: "The recorded workout lasted less than one minute.",
  onset_unavailable: "The wake window has no verified sleep onset.",
  unknown_bounds: "The workout has missing or invalid bounds.",
  conflicting_member_bounds: "FIT recordings disagree on the workout bounds.",
  crosses_wake_window: "The workout crosses the preceding wake or detected sleep onset.",
  overlapping_workouts: "Independent workout recordings overlap.",
  eligible: null,
} as const;
type WorkoutStatus = keyof typeof workoutReasons;

type WorkoutEvidence = {
  id: string;
  canonicalType: string;
  providerType: string;
  sourceProviders: string[];
  canonicalStartedAt: string;
  canonicalEndedAt: string | null;
  fitMemberId: string | null;
  fitMembers: WorkoutWindow["activities"][number]["fit_members"];
  startedAt: string;
  endedAt: string | null;
  status: WorkoutStatus;
  reason: string | null;
};

function workoutFacts(
  activity: WorkoutWindow["activities"][number],
  window: WorkoutWindow,
  onset: string | null,
): WorkoutEvidence {
  const [fit, otherFit] = activity.fit_members;
  const conflicting =
    fit &&
    activity.fit_members.some(
      (member) => member.started_at !== fit.started_at || member.ended_at !== fit.ended_at,
    );
  const resolvedFit = conflicting ? null : fit;
  const start = resolvedFit?.started_at ?? activity.started_at;
  const end = resolvedFit ? resolvedFit.ended_at : activity.ended_at;
  const started = Date.parse(start);
  const finished = end === null ? null : Date.parse(end);
  const duration = finished === null ? null : finished - started;
  const relaxation = [activity.canonical_type, activity.provider_type].some((type) =>
    RELAXATION_TYPES.has(type.toLowerCase().replaceAll(/[^a-z]/g, "")),
  );
  const ouraNonWorkout =
    activity.canonical_type === "other" &&
    activity.source_providers.includes("oura") &&
    OURA_NON_WORKOUT_TYPES.has(activity.provider_type);
  let status: WorkoutStatus = "eligible";
  if (ouraNonWorkout) status = "non_workout";
  else if (relaxation) status = "relaxation";
  else if (conflicting) status = "conflicting_member_bounds";
  else if (duration === null || duration < 0) status = "unknown_bounds";
  else if (duration < MINUTE_MS) status = "too_short";
  else if (onset === null) status = "onset_unavailable";
  else if (
    started < Date.parse(window.previousWake.endedAt) ||
    (finished ?? Infinity) > Date.parse(onset)
  )
    status = "crosses_wake_window";
  return {
    id: activity.id,
    canonicalType: activity.canonical_type,
    providerType: activity.provider_type,
    sourceProviders: activity.source_providers,
    canonicalStartedAt: activity.started_at,
    canonicalEndedAt: activity.ended_at,
    fitMemberId: otherFit ? null : (fit?.id ?? null),
    fitMembers: activity.fit_members,
    startedAt: start,
    endedAt: end,
    status,
    reason: workoutReasons[status],
  };
}

function buildBouts(workouts: WorkoutEvidence[], habitual: number | null, actual: number | null) {
  const groups: { workouts: WorkoutEvidence[]; finish: number; overlaps: boolean }[] = [];
  for (const workout of workouts) {
    if (workout.status !== "eligible" || workout.endedAt === null) continue;
    const start = Date.parse(workout.startedAt);
    const finish = Date.parse(workout.endedAt);
    const previous = groups.at(-1);
    if (previous && start - previous.finish <= 60 * MINUTE_MS) {
      if (start < previous.finish) {
        for (const member of previous.workouts) {
          if (member.endedAt !== null && Date.parse(member.endedAt) > start) {
            member.status = "overlapping_workouts";
            member.reason = workoutReasons.overlapping_workouts;
          }
        }
        workout.status = "overlapping_workouts";
        workout.reason = workoutReasons.overlapping_workouts;
        previous.overlaps = true;
      }
      previous.workouts.push(workout);
      previous.finish = Math.max(previous.finish, finish);
    } else {
      groups.push({ workouts: [workout], finish, overlaps: false });
    }
  }

  return groups.map(({ workouts: members, finish, overlaps }) => {
    const offset = habitual === null ? null : (finish - habitual) / MINUTE_MS;
    return {
      workouts: members,
      finish: new Date(finish).toISOString(),
      finishOffsetMinutes: offset,
      inStudyWindow: offset === null ? null : offset >= STUDY_START && offset <= STUDY_END,
      minutesFromFinishToSleep: actual === null ? null : (actual - finish) / MINUTE_MS,
      overlaps,
    };
  });
}

const matchReasons = {
  onset_unavailable: "This sleep episode has no verified detected onset.",
  previous_wake_unavailable: "No valid preceding main wake was recorded within two calendar days.",
  no_records: "No activity records cover this window. Recording completeness is unknown.",
  no_eligible_workouts: "No recorded activity qualifies as a whole workout in this wake window.",
  habitual_onset_unavailable: "The habitual sleep onset is unavailable.",
  outside_study_window: "The recorded workout finish is outside the study timing window.",
  ambiguous_workouts: "Multiple or unresolved workout records prevent a single-bout comparison.",
  matched: null,
} as const;

function couldFinishInStudyWindow(start: string, end: string | null, habitual: number): boolean {
  const startMs = Date.parse(start);
  const endMs = end === null ? null : Date.parse(end);
  if (endMs === null || endMs < startMs) return startMs <= habitual + STUDY_END * MINUTE_MS;
  const offset = (endMs - habitual) / MINUTE_MS;
  return offset >= STUDY_START && offset <= STUDY_END;
}

function matchNight(
  episode: SleepEpisode,
  window: WorkoutWindow | undefined,
  habitualOnset: ReturnType<typeof habitualOnsetFor>,
) {
  const actualOnset = detectedOnset(episode);
  const actual = actualOnset === null ? null : Date.parse(actualOnset);
  const habitual = habitualOnset.timestamp === null ? null : Date.parse(habitualOnset.timestamp);
  const workouts = window
    ? window.activities
        .map((row) => workoutFacts(row, window, actualOnset))
        .sort(
          (left, right) =>
            Date.parse(left.startedAt) - Date.parse(right.startedAt) ||
            left.id.localeCompare(right.id),
        )
    : [];
  const bouts = buildBouts(workouts, habitual, actual);
  const inWindow = bouts.filter((bout) => bout.inStudyWindow);
  const [first, second] = inWindow;

  // Unresolved records cannot disqualify an independent bout if their possible finishes are outside the study window.
  const unresolved =
    habitual !== null &&
    workouts.some((workout) => {
      if (workout.status === "conflicting_member_bounds") {
        return workout.fitMembers.some((member) =>
          couldFinishInStudyWindow(member.started_at, member.ended_at, habitual),
        );
      }
      return (
        (workout.status === "unknown_bounds" || workout.status === "crosses_wake_window") &&
        couldFinishInStudyWindow(workout.startedAt, workout.endedAt, habitual)
      );
    });

  let status: keyof typeof matchReasons;
  if (actual === null) status = "onset_unavailable";
  else if (!window) status = "previous_wake_unavailable";
  else if (workouts.length === 0) status = "no_records";
  else if (habitual === null) status = "habitual_onset_unavailable";
  else if (unresolved || second || first?.overlaps) status = "ambiguous_workouts";
  else if (first) status = "matched";
  else status = bouts.length > 0 ? "outside_study_window" : "no_eligible_workouts";
  const matchedBout = status === "matched" ? (first ?? null) : null;
  const [onlyBout, otherBout] = bouts;
  const hasUnresolvedBounds = workouts.some(
    ({ status }) =>
      status === "unknown_bounds" ||
      status === "conflicting_member_bounds" ||
      status === "crosses_wake_window",
  );
  const contextBout =
    (status === "outside_study_window" || status === "habitual_onset_unavailable") &&
    onlyBout &&
    !otherBout &&
    !onlyBout.overlaps &&
    !hasUnresolvedBounds
      ? onlyBout
      : null;
  const timedBout = matchedBout ?? contextBout;
  const provider = episode.timing.source_provider;
  const durationMinutes =
    (provider === "polar" || provider === "oura") &&
    episode.duration_minutes !== null &&
    episode.duration_minutes >= 0
      ? episode.duration_minutes
      : null;
  return {
    episodeId: episode.timing.selected_session_id,
    date: episode.date,
    selectedEpisode: episode,
    sleepProvider: provider,
    durationMinutes,
    durationReason:
      durationMinutes === null ? "Time asleep is unavailable from this recording." : null,
    previousWake: window?.previousWake ?? null,
    habitualOnset,
    actualOnset,
    actualOnsetOffsetMinutes:
      actual === null || habitual === null ? null : (actual - habitual) / MINUTE_MS,
    finishOffsetMinutes: timedBout?.finishOffsetMinutes ?? null,
    minutesFromFinishToSleep: timedBout?.minutesFromFinishToSleep ?? null,
    workouts,
    bouts,
    matchedBout,
    status,
    reason: matchReasons[status],
  };
}

/** Episodes and activity windows must already be scoped to the same account and access window. */
export function buildLateWorkoutSleepTiming(
  episodes: readonly SleepEpisode[],
  activityWindows: ReadonlyMap<string, WorkoutWindow>,
  { startDate, endDate, timezone }: { startDate: string; endDate: string; timezone: string },
) {
  const mainEpisodes = episodes.filter(({ timing }) => !timing.is_nap);
  const references = buildReferences(mainEpisodes, timezone);
  return mainEpisodes
    .filter(({ date }) => date >= startDate && date <= endDate)
    .sort(
      (left, right) =>
        left.date.localeCompare(right.date) ||
        Date.parse(left.timing.started_at) - Date.parse(right.timing.started_at) ||
        left.timing.selected_session_id.localeCompare(right.timing.selected_session_id),
    )
    .map((episode) =>
      matchNight(
        episode,
        activityWindows.get(episode.timing.selected_session_id),
        habitualOnsetFor(episode.date, timezone, references),
      ),
    );
}
