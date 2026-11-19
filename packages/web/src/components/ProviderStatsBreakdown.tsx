import {
  type ProviderStats,
  providerStatsBreakdown,
  providerStatsTotal,
} from "@dofek/providers/provider-stats";

/**
 * Compact variant: total only (used in provider list cards).
 * Full variant: total + responsive multi-column grid (used in detail pages).
 */
export function ProviderStatsBreakdown({
  stats,
  variant = "compact",
}: {
  stats: ProviderStats;
  variant?: "compact" | "full";
}) {
  const total = providerStatsTotal(stats);

  if (variant === "full") {
    const breakdown = providerStatsBreakdown(stats);
    return (
      <section className="card p-4">
        <div className="flex items-baseline gap-2 mb-3">
          <span className="text-2xl font-bold text-foreground tabular-nums">
            {total.toLocaleString()}
          </span>
          <span className="text-sm text-subtle">total records</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {breakdown.map((stat) => (
            <div key={stat.label} className="text-center">
              <div className="text-lg font-semibold text-foreground tabular-nums">
                {stat.count.toLocaleString()}
              </div>
              <div className="text-xs text-subtle">{stat.label}</div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  return (
    <div className="mt-2 pt-2 border-t border-border/50">
      <div className="flex items-baseline gap-2">
        <span className="text-lg font-bold text-foreground tabular-nums">
          {total.toLocaleString()}
        </span>
        <span className="text-xs text-subtle">records</span>
      </div>
    </div>
  );
}
