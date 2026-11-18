import { formatDurationMinutes, formatNumber } from "./format.ts";

export const climbingVolumeIncreaseTitle = "Climbing volume increased";
export const climbingAttemptIncreaseTitle = "Recorded climbing attempts increased";

const attemptAverageFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

export function formatClimbingAttemptIncrease(result: {
  recentAttempts: number;
  baselineAttempts: number;
  increasePercent: number;
}): string {
  const recent = formatNumber(result.recentAttempts, 0);
  const baseline = attemptAverageFormatter.format(result.baselineAttempts);
  const increase = formatNumber(result.increasePercent, 0);
  return `You logged ${recent} climbing attempts in the last 7 days, up ${increase}% from your recent weekly average of ${baseline}.`;
}

export function formatClimbingVolumeIncrease(result: {
  recentMinutes: number;
  baselineMinutes: number;
  increasePercent: number;
}): string {
  const recent = formatDurationMinutes(result.recentMinutes, { style: "long" });
  const baseline = formatDurationMinutes(result.baselineMinutes, { style: "long" });
  const increase = formatNumber(result.increasePercent, 0);
  return `You logged ${recent} of climbing in the last 7 days, up ${increase}% from your recent weekly average of ${baseline}.`;
}
