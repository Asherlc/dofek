interface Insight {
  id: string;
  type: "conditional" | "correlation" | "discovery";
  confidence: "strong" | "emerging" | "early" | "insufficient";
  metric: string;
  action: string;
  message: string;
  detail: string;
  whenTrue: { mean: number; n: number };
  whenFalse: { mean: number; n: number };
  effectSize: number;
  pValue: number;
  explanation?: string;
  confounders?: string[];
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
  discovery: "🔍",
};

export function InsightsPanel({ insights, loading }: InsightsPanelProps) {
  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
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
      <p className="text-xs text-zinc-600 leading-relaxed">
        Statistical patterns found in your health data.{" "}
        <strong className="text-zinc-500">Strong</strong> patterns are highly consistent;{" "}
        <strong className="text-zinc-500">Emerging</strong> patterns need more data to confirm;{" "}
        <strong className="text-zinc-500">Early signals</strong> are preliminary and may not hold
        up. Correlation ≠ causation — these show associations, not proven causes.
      </p>
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

            {insight.explanation && (
              <p className="text-xs text-zinc-400 italic">{insight.explanation}</p>
            )}

            {insight.type === "conditional" && (
              <ComparisonBars
                actionLabel={insight.action}
                actionValue={insight.whenTrue.mean}
                actionN={insight.whenTrue.n}
                baselineValue={insight.whenFalse.mean}
                baselineN={insight.whenFalse.n}
                metric={insight.metric}
              />
            )}

            {insight.confounders && insight.confounders.length > 0 && (
              <div className="text-[11px] text-amber-700 bg-amber-950/30 border border-amber-900/30 rounded px-2 py-1.5">
                <p className="font-medium text-amber-600 mb-0.5">Possible confounders:</p>
                <ul className="list-disc list-inside space-y-0.5">
                  {insight.confounders.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>
            )}

            <p className="text-[11px] text-zinc-600">{insight.detail}</p>
          </div>
        );
      })}
    </div>
  );
}

function ComparisonBars({
  actionLabel,
  actionValue,
  actionN,
  baselineValue,
  baselineN,
}: {
  actionLabel: string;
  actionValue: number;
  actionN: number;
  baselineValue: number;
  baselineN: number;
  metric?: string;
}) {
  const diff = actionValue - baselineValue;
  const pctDiff = baselineValue !== 0 ? (diff / Math.abs(baselineValue)) * 100 : 0;
  const sign = diff > 0 ? "+" : "";

  return (
    <div className="flex items-center gap-3 text-xs">
      <div className="text-center">
        <p className="text-zinc-500 mb-0.5">With {actionLabel}</p>
        <p className="text-lg tabular-nums font-semibold text-zinc-100">
          {formatValue(actionValue)}
        </p>
        <p className="text-zinc-600">n={actionN}</p>
      </div>

      <div className="text-center px-3">
        <span className="text-zinc-500 tabular-nums font-medium">
          {sign}
          {pctDiff.toFixed(0)}%
        </span>
      </div>

      <div className="text-center">
        <p className="text-zinc-500 mb-0.5">Without</p>
        <p className="text-lg tabular-nums font-semibold text-zinc-400">
          {formatValue(baselineValue)}
        </p>
        <p className="text-zinc-600">n={baselineN}</p>
      </div>
    </div>
  );
}

function formatValue(v: number): string {
  if (Number.isInteger(v)) return v.toLocaleString();
  return v.toFixed(1);
}
