interface Insight {
  id: string;
  type: "conditional" | "correlation" | "trend";
  confidence: "strong" | "emerging" | "early" | "insufficient";
  metric: string;
  action: string;
  message: string;
  detail: string;
  whenTrue: { mean: number; n: number };
  whenFalse: { mean: number; n: number };
  effectSize: number;
  pValue: number;
}

interface InsightsPanelProps {
  insights: Insight[];
  loading?: boolean;
}

const confidenceBadge = {
  strong: {
    label: "Strong pattern",
    className: "bg-emerald-900/50 text-emerald-400 border-emerald-800",
  },
  emerging: { label: "Emerging", className: "bg-amber-900/50 text-amber-400 border-amber-800" },
  early: { label: "Early signal", className: "bg-zinc-800 text-zinc-400 border-zinc-700" },
  insufficient: {
    label: "Insufficient data",
    className: "bg-zinc-800 text-zinc-600 border-zinc-700",
  },
};

const typeIcon = {
  conditional: "↕",
  correlation: "↗",
  trend: "→",
};

export function InsightsPanel({ insights, loading }: InsightsPanelProps) {
  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton
          <div key={i} className="h-24 rounded-lg bg-zinc-800 animate-pulse" />
        ))}
      </div>
    );
  }

  if (insights.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-zinc-600 text-sm">
        Not enough data to generate insights yet. Keep logging!
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {insights.map((insight) => {
        const badge = confidenceBadge[insight.confidence];
        const icon = typeIcon[insight.type];

        return (
          <div
            key={insight.id}
            className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 space-y-2"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-lg" aria-hidden="true">
                  {icon}
                </span>
                <p className="text-sm text-zinc-100 font-medium">{insight.message}</p>
              </div>
              <span
                className={`shrink-0 text-[10px] px-2 py-0.5 rounded-full border ${badge.className}`}
              >
                {badge.label}
              </span>
            </div>

            {insight.type === "conditional" && (
              <div className="flex gap-4 text-xs text-zinc-400">
                <ComparisonBar
                  label={`With ${insight.action}`}
                  value={insight.whenTrue.mean}
                  n={insight.whenTrue.n}
                  isHigher={insight.whenTrue.mean >= insight.whenFalse.mean}
                />
                <ComparisonBar
                  label="Without"
                  value={insight.whenFalse.mean}
                  n={insight.whenFalse.n}
                  isHigher={insight.whenFalse.mean > insight.whenTrue.mean}
                />
              </div>
            )}

            <p className="text-[11px] text-zinc-600">{insight.detail}</p>
          </div>
        );
      })}
    </div>
  );
}

function ComparisonBar({
  label,
  value,
  n,
  isHigher,
}: {
  label: string;
  value: number;
  n: number;
  isHigher: boolean;
}) {
  return (
    <div className="flex-1">
      <div className="flex justify-between mb-1">
        <span>{label}</span>
        <span className="text-zinc-500">n={n}</span>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 h-2 rounded-full bg-zinc-800 overflow-hidden">
          <div
            className={`h-full rounded-full ${isHigher ? "bg-emerald-500" : "bg-zinc-600"}`}
            style={{ width: "100%" }}
          />
        </div>
        <span
          className={`tabular-nums font-medium ${isHigher ? "text-emerald-400" : "text-zinc-500"}`}
        >
          {formatValue(value)}
        </span>
      </div>
    </div>
  );
}

function formatValue(v: number): string {
  if (Number.isInteger(v)) return v.toLocaleString();
  return v.toFixed(1);
}
