import { z } from "zod";

export const climbingVolumeDaysPerWeek = 7;
export const climbingVolumeBaselineWeeks = 4;
const microsecondsPerMinute = 60_000_000;
export const climbingVolumeWindowDays =
  climbingVolumeDaysPerWeek * (climbingVolumeBaselineWeeks + 1);

export const climbingVolumeIncreaseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("increase"),
    recentMinutes: z.number().positive(),
    baselineMinutes: z.number().positive(),
    increasePercent: z.number().positive(),
  }),
  z.object({ status: z.literal("below_threshold") }),
  z.object({ status: z.literal("insufficient_data") }),
]);

export type ClimbingVolumeIncrease = z.infer<typeof climbingVolumeIncreaseSchema>;

interface TimedClimbingWorkout {
  daysAgo: number;
  durationMicroseconds: number | null;
}

export function evaluateClimbingVolumeIncrease(
  workouts: readonly TimedClimbingWorkout[],
): ClimbingVolumeIncrease {
  let recentDuration = 0;
  let baselineDuration = 0;
  const activeBaselineWeeks = new Set<number>();
  for (const { daysAgo, durationMicroseconds } of workouts) {
    if (durationMicroseconds === null || durationMicroseconds <= 0) {
      return { status: "insufficient_data" };
    }

    if (daysAgo < climbingVolumeDaysPerWeek) {
      recentDuration += durationMicroseconds;
    } else {
      baselineDuration += durationMicroseconds;
      activeBaselineWeeks.add(Math.floor(daysAgo / climbingVolumeDaysPerWeek));
    }
  }

  if (activeBaselineWeeks.size < 2) return { status: "insufficient_data" };

  const weeklyBaseline = baselineDuration / climbingVolumeBaselineWeeks;
  const increase = recentDuration - weeklyBaseline;
  if (increase < weeklyBaseline * 0.25 || increase < 60 * microsecondsPerMinute) {
    return { status: "below_threshold" };
  }

  return {
    status: "increase",
    recentMinutes: recentDuration / microsecondsPerMinute,
    baselineMinutes: weeklyBaseline / microsecondsPerMinute,
    increasePercent: (increase / weeklyBaseline) * 100,
  };
}
