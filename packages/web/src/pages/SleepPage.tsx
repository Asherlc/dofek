import { useMemo, useState } from "react";
import { z } from "zod";
import { AppHeader } from "../components/AppHeader.tsx";
import {
  CorrelationCard,
  CorrelationCardSkeleton,
  type Insight,
} from "../components/CorrelationCard.tsx";
import { Hypnogram } from "../components/Hypnogram.tsx";
import { SleepChart } from "../components/SleepChart.tsx";
import { SleepNeedCard } from "../components/SleepNeedCard.tsx";
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
  const insightsQuery = trpc.insights.compute.useQuery({ days: Math.max(days, 90) });

  const sleepInsights = useMemo(() => {
    const all: Insight[] = insightsQuery.data ?? [];
    return all
      .filter((i) => i.confidence !== "insufficient" && isSleepInsight(i.metric))
      .sort((a, b) => Math.abs(b.effectSize) - Math.abs(a.effectSize));
  }, [insightsQuery.data]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 overflow-x-hidden">
      <AppHeader>
        <TimeRangeSelector days={days} onChange={setDays} />
      </AppHeader>
      <main className="mx-auto max-w-7xl px-3 sm:px-6 py-4 sm:py-6 space-y-6 sm:space-y-8">
        <div>
          <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider">Sleep</h2>
          <p className="text-xs text-zinc-600 mt-0.5">Sleep stages, debt, and patterns over time</p>
        </div>

        {/* Sleep Coach */}
        <SleepNeedCard data={sleepNeed.data} loading={sleepNeed.isLoading} />

        {/* Last Night Hypnogram */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-2 sm:p-4">
          <h3 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2 px-2">
            Last Night
          </h3>
          <Hypnogram data={latestStages.data ?? []} loading={latestStages.isLoading} />
        </div>

        {/* Sleep Stage Chart */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-2 sm:p-4">
          <SleepChart
            data={assertRows(sleepData.data, sleepRowSchema)}
            loading={sleepData.isLoading}
          />
        </div>

        {/* Sleep Insights */}
        {insightsQuery.isLoading && (
          <section>
            <h3 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-3">
              Sleep Insights
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {["s1", "s2"].map((id) => (
                <CorrelationCardSkeleton key={id} />
              ))}
            </div>
          </section>
        )}

        {!insightsQuery.isLoading && sleepInsights.length > 0 && (
          <section>
            <h3 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-3">
              Sleep Insights
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {sleepInsights.map((insight) => (
                <CorrelationCard key={insight.id} insight={insight} />
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
