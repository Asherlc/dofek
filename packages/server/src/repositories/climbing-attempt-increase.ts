import { z } from "zod";
import {
  climbingVolumeBaselineWeeks,
  climbingVolumeDaysPerWeek,
} from "./climbing-volume-increase.ts";

export const climbingAttemptIncreaseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("increase"),
    recentAttempts: z.number().int().positive(),
    baselineAttempts: z.number().positive(),
    increasePercent: z.number().positive(),
  }),
  z.object({ status: z.literal("below_threshold") }),
  z.object({ status: z.literal("insufficient_data") }),
]);

export type ClimbingAttemptIncrease = z.infer<typeof climbingAttemptIncreaseSchema>;

interface ClimbingAttemptDay {
  daysAgo: number;
  attempts: number | null;
}

export function evaluateClimbingAttemptIncrease(
  days: readonly ClimbingAttemptDay[],
): ClimbingAttemptIncrease {
  const recent = { climbingDays: 0, countedDays: 0, attempts: 0 };
  const baseline = { climbingDays: 0, countedDays: 0, attempts: 0 };
  const countedBaselineWeeks = new Set<number>();
  for (const { daysAgo, attempts } of days) {
    const period = daysAgo < climbingVolumeDaysPerWeek ? recent : baseline;
    period.climbingDays += 1;
    if (attempts === null) continue;

    period.countedDays += 1;
    period.attempts += attempts;
    if (period === baseline) {
      countedBaselineWeeks.add(Math.floor(daysAgo / climbingVolumeDaysPerWeek));
    }
  }

  // Compare exact fractions so the 70% minimum and 15-point gap are inclusive.
  const coverageGap = Math.abs(
    recent.countedDays * baseline.climbingDays - baseline.countedDays * recent.climbingDays,
  );
  if (
    countedBaselineWeeks.size < 2 ||
    recent.climbingDays === 0 ||
    100 * recent.countedDays < 70 * recent.climbingDays ||
    100 * baseline.countedDays < 70 * baseline.climbingDays ||
    100 * coverageGap > 15 * recent.climbingDays * baseline.climbingDays
  ) {
    return { status: "insufficient_data" };
  }

  const baselineAttempts = baseline.attempts / climbingVolumeBaselineWeeks;
  const additional = recent.attempts - baselineAttempts;
  if (additional < 10 || additional < baselineAttempts * 0.25) {
    return { status: "below_threshold" };
  }

  return {
    status: "increase",
    recentAttempts: recent.attempts,
    baselineAttempts,
    increasePercent: (additional / baselineAttempts) * 100,
  };
}
