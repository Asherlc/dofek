import { selectRecentDailyLoad } from "@dofek/training/training";
import { workloadRatioResultSchema } from "../contracts/mobile-dashboard-contracts.ts";

export interface WorkloadRatioRow {
  date: string;
  dailyLoad: number;
  strain: number;
  acuteLoad: number;
  chronicLoad: number;
  workloadRatio: number | null;
}

export interface WorkloadRatioContext {
  label: string;
  description: string;
  recentDays: number;
  baselineDays: number;
}

export interface WorkloadRatioResult {
  context: WorkloadRatioContext;
  timeSeries: WorkloadRatioRow[];
  displayedStrain: number;
  displayedDate: string | null;
}

export { workloadRatioResultSchema };

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
