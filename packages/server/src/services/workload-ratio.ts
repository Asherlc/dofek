import { selectRecentDailyLoad } from "@dofek/training/training";
import {
  type WorkloadRatioResult,
  workloadRatioResultSchema,
} from "../contracts/mobile-dashboard-contracts.ts";

export type WorkloadRatioRow = WorkloadRatioResult["timeSeries"][number];

export type WorkloadRatioContext = WorkloadRatioResult["context"];

export { type WorkloadRatioResult, workloadRatioResultSchema };

const workloadRatioContext = {
  label: "Recent-to-baseline workload ratio",
  description:
    "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days. This is descriptive context, not a safe range or an injury prediction.",
  recentDays: 7,
  baselineDays: 28,
} satisfies WorkloadRatioContext;

export function buildWorkloadRatioResult(timeSeries: WorkloadRatioRow[]): WorkloadRatioResult {
  const displayed = selectRecentDailyLoad(timeSeries);
  return {
    context: { ...workloadRatioContext },
    timeSeries,
    displayedStrain: displayed?.strain ?? 0,
    displayedDate: displayed?.date ?? null,
  };
}
