import type { SleepNeedV2 } from "dofek-server/sleep-need-contract";
import type { SleepPerformanceInfo } from "dofek-server/types";
import { SleepNeedCard } from "./SleepNeedCard.tsx";
import { SleepPerformanceCard } from "./SleepPerformanceCard.tsx";

interface SleepOverviewCardsProps {
  sleepNeed: SleepNeedV2 | undefined;
  sleepNeedLoading?: boolean;
  sleepPerformance: SleepPerformanceInfo | null | undefined;
  sleepPerformanceLoading?: boolean;
}

export function SleepOverviewCards({
  sleepNeed,
  sleepNeedLoading,
  sleepPerformance,
  sleepPerformanceLoading,
}: SleepOverviewCardsProps) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4" data-testid="sleep-overview-cards">
      <SleepPerformanceCard data={sleepPerformance} loading={sleepPerformanceLoading} />
      <SleepNeedCard data={sleepNeed} loading={sleepNeedLoading} />
    </div>
  );
}
