interface HealthMetric {
  label: string;
  value: number | null | undefined;
  avg: number | null | undefined;
  stddev: number | null | undefined;
  unit: string;
  /** Whether lower is better (e.g., resting HR) */
  lowerBetter?: boolean;
}

interface HealthStatusBarProps {
  metrics: HealthMetric[];
  loading?: boolean;
}

function getStatus(
  value: number | null | undefined,
  avg: number | null | undefined,
  stddev: number | null | undefined,
  lowerBetter?: boolean,
): "green" | "yellow" | "red" | "unknown" {
  if (value == null || avg == null || stddev == null || stddev === 0) return "unknown";
  const rawZScore = (value - avg) / stddev;

  // When we know the direction, deviations in the "good" direction stay green
  if (lowerBetter !== undefined) {
    const isBadDirection = lowerBetter ? rawZScore > 0 : rawZScore < 0;
    if (!isBadDirection) return "green";
  }

  const absZScore = Math.abs(rawZScore);
  if (absZScore < 1) return "green";
  if (absZScore < 2) return "yellow";
  return "red";
}

const statusColors = {
  green: "bg-emerald-500",
  yellow: "bg-amber-500",
  red: "bg-red-500",
  unknown: "bg-dim",
};

const statusText = {
  green: "Normal",
  yellow: "Elevated",
  red: "Abnormal",
  unknown: "—",
};

export function HealthStatusBar({ metrics, loading }: HealthStatusBarProps) {
  if (loading) {
    return (
      <div className="flex gap-3">
        {["skeleton-1", "skeleton-2", "skeleton-3", "skeleton-4", "skeleton-5"].map((id) => (
          <div key={id} className="flex-1 h-16 rounded-lg bg-skeleton animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex gap-3 overflow-x-auto">
      {metrics.map((m) => {
        const status = getStatus(m.value, m.avg, m.stddev, m.lowerBetter);
        return (
          <div
            key={m.label}
            className="flex-1 min-w-[120px] card p-3"
          >
            <div className="flex items-center gap-2 mb-1">
              <div className={`w-2 h-2 rounded-full ${statusColors[status]}`} />
              <span className="text-xs text-muted uppercase tracking-wider">{m.label}</span>
            </div>
            <div className="text-lg font-semibold tabular-nums">
              {m.value != null ? (
                <>
                  {typeof m.value === "number" && !Number.isInteger(m.value)
                    ? m.value.toFixed(1)
                    : m.value}
                  <span className="ml-1 text-xs font-normal text-subtle">{m.unit}</span>
                </>
              ) : (
                <span className="text-dim">—</span>
              )}
            </div>
            <div className="text-[10px] text-subtle">
              {status !== "unknown" && m.avg != null
                ? `avg ${Number(m.avg).toFixed(1)} · ${statusText[status]}`
                : ""}
            </div>
          </div>
        );
      })}
    </div>
  );
}
