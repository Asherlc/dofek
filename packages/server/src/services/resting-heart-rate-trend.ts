import { trendDirection } from "@dofek/scoring/scoring";
import type { HrvBaselineRow } from "../repositories/daily-metrics-repository.ts";

export function computeRestingHeartRateTrendDirection(
  rows: Pick<HrvBaselineRow, "resting_hr" | "resting_hr_mean_7d">[],
): ReturnType<typeof trendDirection> | null {
  const values = rows
    .slice(-14)
    .flatMap((row) =>
      row.resting_hr != null && row.resting_hr_mean_7d != null ? [row.resting_hr_mean_7d] : [],
    );
  const previousAverage = values.at(-2);
  const latestAverage = values.at(-1);

  return previousAverage == null || latestAverage == null
    ? null
    : trendDirection(latestAverage, previousAverage);
}
