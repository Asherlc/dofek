import { useState } from "react";
import { AppHeader } from "../components/AppHeader.tsx";
import { InsightsPanel } from "../components/InsightsPanel.tsx";
import { LifeEventsPanel } from "../components/LifeEventsPanel.tsx";
import { SupplementStackPanel } from "../components/SupplementStackPanel.tsx";
import { TimeRangeSelector } from "../components/TimeRangeSelector.tsx";
import { trpc } from "../lib/trpc.ts";

export function InsightsPage() {
  const [days, setDays] = useState(365);
  const insightsData = trpc.insights.compute.useQuery({ days });

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <AppHeader activePage="insights">
        <TimeRangeSelector days={days} onChange={setDays} />
      </AppHeader>
      <main className="mx-auto max-w-7xl p-6 space-y-8">
        <section>
          <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-1">
            Insights
          </h2>
          <p className="text-xs text-zinc-600 mb-4">Actionable patterns from all your data</p>
          <InsightsPanel
            insights={(insightsData.data ?? []) as any[]}
            loading={insightsData.isLoading}
          />
        </section>

        <section>
          <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-1">
            Life Events
          </h2>
          <p className="text-xs text-zinc-600 mb-4">Track changes and see their impact</p>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <LifeEventsPanel />
          </div>
        </section>

        <section>
          <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-1">
            Supplement Stack
          </h2>
          <p className="text-xs text-zinc-600 mb-4">Daily supplements synced as nutrition data</p>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <SupplementStackPanel />
          </div>
        </section>
      </main>
    </div>
  );
}
