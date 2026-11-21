import type { LateWorkoutSleep, LateWorkoutSleepNight } from "@dofek/training/late-workout-sleep";

const axis = { lowerMinutes: -600, upperMinutes: 120 };
function position(minutes: number) {
  return (minutes - axis.lowerMinutes) / (axis.upperMinutes - axis.lowerMinutes);
}

const latest: LateWorkoutSleepNight = {
  episodeId: "sleep-2",
  date: "2026-11-15",
  sleepProvider: "polar",
  sourceSessionIds: ["polar-2"],
  sourceProviders: ["polar"],
  previousWake: { sessionId: "polar-wake-2", endedAt: "2026-11-14T07:30:00Z" },
  status: "matched",
  reason: null,
  workouts: [
    {
      id: "workout-2",
      canonicalType: "running",
      sourceProviders: ["fit-file"],
      fitMemberId: "fit-2",
      status: "eligible",
      reason: null,
      startedAt: "2026-11-14T21:00:00Z",
      endedAt: "2026-11-14T21:30:00Z",
    },
  ],
  bouts: [
    {
      workoutIds: ["workout-2"],
      finish: "2026-11-14T21:30:00Z",
      finishOffsetMinutes: -45,
      minutesFromFinishToSleep: 60,
      inStudyWindow: true,
    },
  ],
  matchedWorkoutIds: ["workout-2"],
  habitualOnset: {
    timestamp: "2026-11-14T22:15:00Z",
    month: "2026-11",
    dayClass: "weekend",
    timezone: "UTC",
    observedCount: 2,
    referenceNights: [
      { date: "2026-11-08", episodeId: "polar-reference-weekend", sleepProvider: "polar" },
      { date: "2026-11-15", episodeId: "sleep-2", sleepProvider: "polar" },
    ],
    ambiguousReferenceDates: [],
    reason: null,
  },
  actualOnset: "2026-11-14T22:30:00Z",
  workoutFinish: "2026-11-14T21:30:00Z",
  durationMinutes: 435,
  durationReason: null,
  finishOffsetMinutes: -45,
  actualOnsetOffsetMinutes: 15,
  minutesFromFinishToSleep: 60,
  load: {
    score: 60,
    category: "light",
    coveredSeconds: 1800,
    reason: null,
    maximums: [{ date: "2026-11-14", bpm: 200, basis: "profile" }],
  },
  plot: { workoutFinish: position(-45), actualOnset: position(15) },
};

const timingOnly: LateWorkoutSleepNight = {
  ...latest,
  episodeId: "sleep-1",
  date: "2026-11-10",
  sourceSessionIds: ["polar-1"],
  previousWake: { sessionId: "polar-wake-1", endedAt: "2026-11-09T07:00:00Z" },
  workouts: [
    {
      id: "workout-1",
      canonicalType: "cycling",
      sourceProviders: ["fit-file"],
      fitMemberId: "fit-1",
      status: "eligible",
      reason: null,
      startedAt: "2026-11-09T19:45:00Z",
      endedAt: "2026-11-09T20:15:00Z",
    },
  ],
  bouts: [
    {
      workoutIds: ["workout-1"],
      finish: "2026-11-09T20:15:00Z",
      finishOffsetMinutes: -120,
      minutesFromFinishToSleep: 135,
      inStudyWindow: true,
    },
  ],
  matchedWorkoutIds: ["workout-1"],
  workoutFinish: "2026-11-09T20:15:00Z",
  actualOnset: "2026-11-09T22:30:00Z",
  habitualOnset: {
    ...latest.habitualOnset,
    timestamp: "2026-11-09T22:15:00Z",
    dayClass: "weekday",
    referenceNights: [
      { date: "2026-11-09", episodeId: "polar-wake-1", sleepProvider: "polar" },
      { date: "2026-11-10", episodeId: "sleep-1", sleepProvider: "polar" },
    ],
  },
  finishOffsetMinutes: -120,
  minutesFromFinishToSleep: 135,
  load: {
    score: null,
    category: null,
    maximums: [],
    coveredSeconds: null,
    reason: "Heart-rate samples are incomplete.",
  },
  plot: { workoutFinish: position(-120), actualOnset: position(15) },
};

const contextNight: LateWorkoutSleepNight = {
  ...timingOnly,
  episodeId: "sleep-3",
  date: "2026-11-18",
  sleepProvider: "apple_health",
  sourceSessionIds: ["apple-sleep-3"],
  sourceProviders: ["apple_health"],
  previousWake: null,
  status: "onset_unavailable",
  reason: "This sleep source does not provide a verified onset.",
  habitualOnset: { ...timingOnly.habitualOnset, timestamp: "2026-11-17T22:15:00Z" },
  actualOnset: null,
  durationMinutes: null,
  durationReason: "Time asleep unavailable from this record.",
  workoutFinish: null,
  finishOffsetMinutes: null,
  actualOnsetOffsetMinutes: null,
  minutesFromFinishToSleep: null,
  workouts: [],
  bouts: [],
  matchedWorkoutIds: [],
  load: { score: null, category: null, maximums: [], coveredSeconds: null, reason: null },
  plot: { workoutFinish: null, actualOnset: null },
};

export const matchedLateWorkoutSleep: LateWorkoutSleep = {
  range: { startDate: "2026-11-08", endDate: "2026-11-21", timezone: "UTC" },
  axis: { ...axis, habitualPosition: position(0) },
  matchedNightCount: 2,
  measuredLoadNightCount: 1,
  nights: [timingOnly, latest, contextNight],
};

export const timingOnlyLateWorkoutSleep: LateWorkoutSleep = {
  ...matchedLateWorkoutSleep,
  matchedNightCount: 1,
  measuredLoadNightCount: 0,
  nights: [timingOnly],
};

export const emptyLateWorkoutSleep: LateWorkoutSleep = {
  ...matchedLateWorkoutSleep,
  matchedNightCount: 0,
  measuredLoadNightCount: 0,
  nights: [],
};
