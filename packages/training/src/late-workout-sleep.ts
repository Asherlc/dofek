import { z } from "zod";

const nullableTimestamp = z.iso.datetime().nullable();
const nullableNumber = z.number().nullable();
const position = z.number().min(0).max(1).nullable();
const recordedMax = z.object({ date: z.iso.date(), bpm: z.number().positive() });

const workoutSchema = z.object({
  id: z.string(),
  canonicalType: z.string(),
  sourceProviders: z.array(z.string()),
  fitMemberId: z.string().nullable(),
  startedAt: z.iso.datetime(),
  endedAt: nullableTimestamp,
  status: z.enum([
    "eligible",
    "non_workout",
    "relaxation",
    "too_short",
    "onset_unavailable",
    "unknown_bounds",
    "conflicting_member_bounds",
    "crosses_wake_window",
    "overlapping_workouts",
  ]),
  reason: z.string().nullable(),
});

const nightSchema = z.object({
  episodeId: z.string(),
  date: z.iso.date(),
  sleepProvider: z.string(),
  sourceSessionIds: z.array(z.string()),
  sourceProviders: z.array(z.string()),
  previousWake: z.object({ sessionId: z.string(), endedAt: z.iso.datetime() }).nullable(),
  status: z.enum([
    "matched",
    "onset_unavailable",
    "previous_wake_unavailable",
    "no_records",
    "no_eligible_workouts",
    "habitual_onset_unavailable",
    "outside_study_window",
    "ambiguous_workouts",
    "ambiguous_sleep_date",
  ]),
  reason: z.string().nullable(),
  workouts: z.array(workoutSchema),
  bouts: z.array(
    z.object({
      workoutIds: z.array(z.string()),
      finish: z.iso.datetime(),
      finishOffsetMinutes: nullableNumber,
      minutesFromFinishToSleep: nullableNumber,
      inStudyWindow: z.boolean().nullable(),
    }),
  ),
  matchedWorkoutIds: z.array(z.string()),
  habitualOnset: z.object({
    timestamp: nullableTimestamp,
    month: z.string(),
    dayClass: z.enum(["weekday", "weekend"]),
    timezone: z.string(),
    observedCount: z.number().int().nonnegative(),
    referenceNights: z.array(
      z.object({
        date: z.iso.date(),
        episodeId: z.string(),
        sleepProvider: z.string(),
      }),
    ),
    ambiguousReferenceDates: z.array(z.iso.date()),
    reason: z.string().nullable(),
  }),
  actualOnset: nullableTimestamp,
  workoutFinish: nullableTimestamp,
  durationMinutes: nullableNumber,
  durationReason: z.string().nullable(),
  finishOffsetMinutes: nullableNumber,
  actualOnsetOffsetMinutes: nullableNumber,
  minutesFromFinishToSleep: nullableNumber,
  load: z.object({
    score: nullableNumber,
    category: z.enum(["light", "moderate", "high", "maximal"]).nullable(),
    maximums: z.array(
      z.discriminatedUnion("basis", [
        recordedMax.extend({ basis: z.literal("profile") }),
        recordedMax.extend({
          basis: z.literal("age_estimate"),
          age: z.number().int().nonnegative(),
        }),
      ]),
    ),
    coveredSeconds: z.number().int().nonnegative().nullable(),
    reason: z.string().nullable(),
  }),
  plot: z.object({ workoutFinish: position, actualOnset: position }),
});

export const lateWorkoutSleepSchema = z.object({
  range: z.object({
    startDate: z.iso.date().nullable(),
    endDate: z.iso.date().nullable(),
    timezone: z.string(),
  }),
  matchedNightCount: z.number().int().nonnegative(),
  measuredLoadNightCount: z.number().int().nonnegative(),
  axis: z.object({
    lowerMinutes: z.number(),
    upperMinutes: z.number(),
    habitualPosition: z.number().min(0).max(1),
  }),
  nights: z.array(nightSchema),
});

export type LateWorkoutSleep = z.infer<typeof lateWorkoutSleepSchema>;
export type LateWorkoutSleepNight = LateWorkoutSleep["nights"][number];
