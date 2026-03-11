interface MetricCardProps {
  label: string;
  value: number | string | null | undefined;
  unit?: string;
  loading?: boolean;
}

export function MetricCard({ label, value, unit, loading }: MetricCardProps) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="text-xs font-medium text-zinc-400 uppercase tracking-wider">{label}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">
        {loading ? (
          <span className="text-zinc-600">—</span>
        ) : value != null ? (
          <>
            {typeof value === "number" ? formatNumber(value) : value}
            {unit && <span className="ml-1 text-sm font-normal text-zinc-500">{unit}</span>}
          </>
        ) : (
          <span className="text-zinc-600">—</span>
        )}
      </div>
    </div>
  );
}

function formatNumber(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toFixed(1);
}
