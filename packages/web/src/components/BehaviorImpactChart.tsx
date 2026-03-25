import { trpc } from "../lib/trpc.ts";

function ImpactBar({
  label,
  impactPercent,
  category,
}: {
  label: string;
  impactPercent: number;
  category: string;
}) {
  const maxBar = 50; // max percentage width
  const barWidth = Math.min(Math.abs(impactPercent), maxBar);
  const isPositive = impactPercent >= 0;
  const barColor = isPositive ? "bg-emerald-500" : "bg-red-500";
  const sign = isPositive ? "+" : "";

  return (
    <div className="flex items-center gap-3 py-2">
      <div className="w-32 text-right shrink-0">
        <span className="text-xs text-foreground">{label}</span>
        <span className="text-[10px] text-dim ml-1">({category})</span>
      </div>
      <div className="flex-1 flex items-center">
        {/* Left side (hurts) */}
        <div className="flex-1 flex justify-end">
          {!isPositive && (
            <div
              className={`h-5 rounded-l ${barColor} transition-all`}
              style={{ width: `${(barWidth / maxBar) * 100}%` }}
            />
          )}
        </div>
        {/* Center line */}
        <div className="w-px bg-border-strong h-7 mx-1 shrink-0" />
        {/* Right side (helps) */}
        <div className="flex-1">
          {isPositive && (
            <div
              className={`h-5 rounded-r ${barColor} transition-all`}
              style={{ width: `${(barWidth / maxBar) * 100}%` }}
            />
          )}
        </div>
      </div>
      <div className="w-16 text-right shrink-0">
        <span className={`text-xs font-medium ${isPositive ? "text-emerald-400" : "text-red-400"}`}>
          {sign}
          {impactPercent.toFixed(1)}%
        </span>
      </div>
    </div>
  );
}

export function BehaviorImpactChart({ days }: { days: number }) {
  const { data, isLoading, error } = trpc.behaviorImpact.impactSummary.useQuery({ days });

  if (isLoading) {
    return (
      <div className="card p-6 animate-pulse">
        <div className="h-4 bg-surface-hover rounded w-48 mb-4" />
        <div className="space-y-3">
          <div className="h-5 bg-surface-hover rounded" />
          <div className="h-5 bg-surface-hover rounded" />
          <div className="h-5 bg-surface-hover rounded" />
          <div className="h-5 bg-surface-hover rounded" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card p-6">
        <p className="text-sm text-red-400">Failed to load behavior impact data.</p>
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="card p-6">
        <h3 className="text-sm font-medium text-muted uppercase tracking-wider mb-2">
          Behavior Impact
        </h3>
        <p className="text-xs text-dim">
          Not enough journal data yet. Log boolean journal entries (yes/no) for at least 5 days each
          to see how behaviors affect your next-day readiness.
        </p>
      </div>
    );
  }

  return (
    <div className="card p-6">
      <h3 className="text-sm font-medium text-muted uppercase tracking-wider mb-4">
        Behavior Impact on Next-Day Readiness
      </h3>
      <div className="flex items-center justify-between text-[10px] text-dim mb-1 px-32">
        <span>HURTS</span>
        <span>HELPS</span>
      </div>
      <div className="divide-y divide-border">
        {data.map((item) => (
          <ImpactBar
            key={item.questionSlug}
            label={item.displayName}
            impactPercent={item.impactPercent}
            category={item.category}
          />
        ))}
      </div>
    </div>
  );
}
