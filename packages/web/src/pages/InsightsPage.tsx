import { useState } from "react";
import { AppHeader } from "../components/AppHeader.tsx";
import {
  CorrelationCard,
  CorrelationCardSkeleton,
  type Insight,
} from "../components/CorrelationCard.tsx";
import { TimeRangeSelector } from "../components/TimeRangeSelector.tsx";
import { trpc } from "../lib/trpc.ts";

type ConfidenceFilter = "all" | "strong" | "emerging" | "early";

interface Category {
  key: string;
  label: string;
  match: (metric: string) => boolean;
}

const CATEGORIES: Category[] = [
  {
    key: "recovery",
    label: "Recovery",
    match: (m) => /hrv|resting.?hr|heart.?rate/i.test(m),
  },
  {
    key: "sleep",
    label: "Sleep",
    match: (m) => /sleep|deep|rem|efficiency/i.test(m),
  },
  {
    key: "body",
    label: "Body Composition",
    match: (m) => /weight|body.?fat|bmi/i.test(m),
  },
  {
    key: "performance",
    label: "Performance",
    match: (m) => /steps|energy|active|vo2/i.test(m),
  },
];

function categorize(metric: string): string {
  for (const cat of CATEGORIES) {
    if (cat.match(metric)) return cat.key;
  }
  return "other";
}

export function InsightsPage() {
  const [days, setDays] = useState(365);
  const [filter, setFilter] = useState<ConfidenceFilter>("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const insightsData = trpc.insights.compute.useQuery({ days });

  const allInsights = (insightsData.data ?? []) as Insight[];
  const filtered =
    filter === "all"
      ? allInsights.filter((i) => i.confidence !== "insufficient")
      : allInsights.filter((i) => i.confidence === filter);

  // Group by category
  const groups = new Map<string, Insight[]>();
  for (const insight of filtered) {
    const cat = categorize(insight.metric);
    const arr = groups.get(cat) ?? [];
    arr.push(insight);
    groups.set(cat, arr);
  }

  // Order: defined categories first, then "other"
  const orderedGroups = [
    ...CATEGORIES.filter((c) => groups.has(c.key)).map((c) => ({
      key: c.key,
      label: c.label,
      insights: groups.get(c.key)!,
    })),
    ...(groups.has("other")
      ? [{ key: "other", label: "Other", insights: groups.get("other")! }]
      : []),
  ];

  const toggle = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const filters: { value: ConfidenceFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "strong", label: "Strong" },
    { value: "emerging", label: "Emerging" },
    { value: "early", label: "Early" },
  ];

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <AppHeader activePage="insights">
        <TimeRangeSelector days={days} onChange={setDays} />
      </AppHeader>
      <main className="mx-auto max-w-7xl p-6 space-y-6">
        {/* Header + filters */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider">
              Correlations & Outcomes
            </h2>
            <p className="text-xs text-zinc-600 mt-0.5">
              Statistical associations in your health data. Correlation does not imply causation.
            </p>
          </div>
          <div className="flex gap-1">
            {filters.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setFilter(f.value)}
                className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                  filter === f.value
                    ? "bg-zinc-700 text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Loading */}
        {insightsData.isLoading && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <CorrelationCardSkeleton key={i} />
            ))}
          </div>
        )}

        {/* Empty state */}
        {!insightsData.isLoading && filtered.length === 0 && (
          <div className="flex items-center justify-center h-32 text-zinc-600 text-sm">
            {allInsights.length === 0
              ? "Not enough data to find correlations yet. Keep logging!"
              : "No insights match this filter."}
          </div>
        )}

        {/* Grouped insights */}
        {!insightsData.isLoading &&
          orderedGroups.map((group) => {
            const isCollapsed = collapsed.has(group.key);
            return (
              <section key={group.key}>
                <button
                  type="button"
                  onClick={() => toggle(group.key)}
                  className="flex items-center gap-2 mb-3 group cursor-pointer"
                >
                  <span className="text-xs text-zinc-500 group-hover:text-zinc-300 transition-colors">
                    {isCollapsed ? "+" : "-"}
                  </span>
                  <h3 className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
                    {group.label}
                  </h3>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-800 text-zinc-500">
                    {group.insights.length}
                  </span>
                </button>
                {!isCollapsed && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {group.insights.map((insight) => (
                      <CorrelationCard key={insight.id} insight={insight} />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
      </main>
    </div>
  );
}
