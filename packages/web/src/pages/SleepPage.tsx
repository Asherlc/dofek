import { useMemo, useState } from "react";
import { z } from "zod";
import {
  CorrelationCard,
  CorrelationCardSkeleton,
  type Insight,
} from "../components/CorrelationCard.tsx";
import { Hypnogram } from "../components/Hypnogram.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { PageSection } from "../components/PageSection.tsx";
import { SleepChart } from "../components/SleepChart.tsx";
import { SleepNeedCard } from "../components/SleepNeedCard.tsx";
import { SleepPerformanceCard } from "../components/SleepPerformanceCard.tsx";
import { TimeRangeSelector } from "../components/TimeRangeSelector.tsx";
import { trpc } from "../lib/trpc.ts";
import { assertRows } from "../lib/utils.ts";

const sleepRowSchema = z.object({
  started_at: z.string(),
  duration_minutes: z.number().nullable(),
  deep_minutes: z.number().nullable(),
  rem_minutes: z.number().nullable(),
  light_minutes: z.number().nullable(),
  awake_minutes: z.number().nullable(),
  efficiency_pct: z.number().nullable(),
});

function isSleepInsight(metric: string): boolean {
  return /sleep|deep|rem|efficiency/i.test(metric);
}

export function SleepPage() {
  const [days, setDays] = useState(30);

  const sleepData = trpc.sleep.list.useQuery({ days });
  const latestStages = trpc.sleep.latestStages.useQuery();
  const sleepNeed = trpc.sleepNeed.calculate.useQuery();
  const sleepPerformance = trpc.sleepNeed.performance.useQuery();
  const insightsQuery = trpc.insights.compute.useQuery({ days: Math.max(days, 90) });

  const sleepInsights = useMemo(() => {
    const all: Insight[] = insightsQuery.data ?? [];
    return all
      .filter((i) => i.confidence !== "insufficient" && isSleepInsight(i.metric))
      .sort((a, b) => Math.abs(b.effectSize) - Math.abs(a.effectSize));
  }, [insightsQuery.data]);

  return (
    <PageLayout
      headerChildren={<TimeRangeSelector days={days} onChange={setDays} />}
      title="Sleep"
      subtitle="Sleep stages, debt, and patterns over time"
    >
      {/* Sleep Performance Score + Bedtime Recommendation */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SleepPerformanceCard data={sleepPerformance.data} loading={sleepPerformance.isLoading} />
        <SleepNeedCard data={sleepNeed.data} loading={sleepNeed.isLoading} />
      </div>

      {/* Sleep Stage Chart */}
      <PageSection title="Sleep Stages">
        <SleepChart
          data={assertRows(sleepData.data, sleepRowSchema)}
          loading={sleepData.isLoading}
        />
      </PageSection>

      {/* Last Night Hypnogram */}
      <PageSection title="Last Night">
        <Hypnogram data={latestStages.data ?? []} loading={latestStages.isLoading} />
      </PageSection>

      {/* Sleep Insights */}
      {insightsQuery.isLoading && (
        <PageSection title="Sleep Insights" card={false}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {["s1", "s2"].map((id) => (
              <CorrelationCardSkeleton key={id} />
            ))}
          </div>
        </PageSection>
      )}

      {!insightsQuery.isLoading && sleepInsights.length > 0 && (
        <PageSection title="Sleep Insights" card={false}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {sleepInsights.map((insight) => (
              <CorrelationCard key={insight.id} insight={insight} />
            ))}
          </div>
        </PageSection>
      )}
    </PageLayout>
  );
}
