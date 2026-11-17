import { formatDurationMinutes, formatNumber } from "./format.ts";

export const climbingVolumeIncreaseTitle = "Climbing volume increased";

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
