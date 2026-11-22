import { describe, expect, it } from "vitest";
import {
  type LateWorkoutSleep,
  type LateWorkoutSleepNight,
  lateWorkoutSleepSchema,
} from "./late-workout-sleep.ts";

const finish = "2026-03-09T21:00:00Z";
const onset = "2026-03-09T23:00:00Z";
const measuredNight = {
  episodeId: "night",
  date: "2026-03-10",
  sleepProvider: "polar",
  sourceSessionIds: ["night"],
  sourceProviders: ["polar"],
  previousWake: { sessionId: "previous-night", endedAt: "2026-03-09T07:00:00Z" },
  status: "matched",
  reason: null,
  workouts: [
    {
      id: "workout",
      canonicalType: "running",
      sourceProviders: ["fit-file"],
      fitMemberId: "fit-member",
      startedAt: "2026-03-09T20:30:00Z",
      endedAt: finish,
      status: "eligible",
      reason: null,
    },
  ],
  bouts: [
    {
      workoutIds: ["workout"],
      finish,
      finishOffsetMinutes: -120,
      minutesFromFinishToSleep: 120,
      inStudyWindow: true,
    },
  ],
  matchedWorkoutIds: ["workout"],
  habitualOnset: {
    timestamp: onset,
    month: "2026-03",
    dayClass: "weekday",
    timezone: "UTC",
    observedCount: 1,
    referenceNights: [{ date: "2026-03-10", episodeId: "night", sleepProvider: "polar" }],
    ambiguousReferenceDates: [],
    reason: null,
  },
  actualOnset: onset,
  workoutFinish: finish,
  durationMinutes: 450,
  durationReason: null,
  finishOffsetMinutes: -120,
  actualOnsetOffsetMinutes: 0,
  minutesFromFinishToSleep: 120,
  load: {
    score: 60,
    category: "light",
    maximums: [{ date: "2026-03-09", bpm: 200, basis: "profile" }],
    coveredSeconds: 1800,
    reason: null,
  },
  plot: { workoutFinish: 2 / 3, actualOnset: 5 / 6 },
} satisfies LateWorkoutSleepNight;

const measured = {
  range: { startDate: "2026-03-10", endDate: "2026-03-10", timezone: "UTC" },
  matchedNightCount: 1,
  measuredLoadNightCount: 1,
  axis: { lowerMinutes: -600, upperMinutes: 120, habitualPosition: 5 / 6 },
  nights: [measuredNight],
} satisfies LateWorkoutSleep;

describe("lateWorkoutSleepSchema", () => {
  it("preserves measured workout, sleep, reference, and load evidence", () => {
    expect(lateWorkoutSleepSchema.parse(measured)).toEqual(measured);
  });

  it("preserves matched timing with explicit unavailable load", () => {
    const timingOnly = {
      ...measured,
      measuredLoadNightCount: 0,
      nights: [
        {
          ...measuredNight,
          load: {
            score: null,
            category: null,
            maximums: [],
            coveredSeconds: null,
            reason: "Complete heart-rate coverage is unavailable.",
          },
        },
      ],
    };
    expect(lateWorkoutSleepSchema.parse(timingOnly)).toEqual(timingOnly);
  });

  it("accepts an empty access intersection", () => {
    const empty = {
      ...measured,
      range: { startDate: null, endDate: null, timezone: "UTC" },
      matchedNightCount: 0,
      measuredLoadNightCount: 0,
      nights: [],
    };
    expect(lateWorkoutSleepSchema.parse(empty)).toEqual(empty);
  });

  it.each([
    [{ plot: { ...measuredNight.plot, workoutFinish: 1.01 } }, ["plot", "workoutFinish"]],
    [{ date: "2026-02-30" }, ["date"]],
    [{ load: { ...measuredNight.load, category: "extreme" } }, ["load", "category"]],
    [
      {
        load: {
          ...measuredNight.load,
          maximums: [{ date: "2026-03-09", bpm: 183.425, basis: "age_estimate" }],
        },
      },
      ["load", "maximums", 0, "age"],
    ],
  ] as const)("rejects invalid night data at %j", (override, path) => {
    const result = lateWorkoutSleepSchema.safeParse({
      ...measured,
      nights: [{ ...measuredNight, ...override }],
    });
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([["nights", 0, ...path]]);
  });
});
