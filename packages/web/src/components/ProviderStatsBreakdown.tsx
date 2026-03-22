import {
  type ProviderStats,
  providerStatsBreakdown,
  providerStatsTotal,
} from "@dofek/providers/provider-stats";

/**
 * Compact variant: total + 2-column grid (used in provider cards).
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
  const breakdown = providerStatsBreakdown(stats);

  if (total === 0) return null;

  if (variant === "full") {
    return (
      <section className="card p-4">
        <div className="flex items-baseline gap-2 mb-3">
          <span className="text-2xl font-bold text-foreground tabular-nums">
            {total.toLocaleString()}
          </span>
          <span className="text-sm text-subtle">total records</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {breakdown.map((b) => (
            <div key={b.label} className="text-center">
              <div className="text-lg font-semibold text-foreground tabular-nums">
                {b.count.toLocaleString()}
              </div>
              <div className="text-xs text-subtle">{b.label}</div>
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
      {breakdown.length > 1 && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 mt-1">
          {breakdown.map((b) => (
            <div key={b.label} className="flex justify-between text-xs">
              <span className="text-subtle">{b.label}</span>
              <span className="text-muted tabular-nums">{b.count.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
