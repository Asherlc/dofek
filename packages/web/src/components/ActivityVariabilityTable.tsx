import type { ActivityVariabilityRow } from "dofek-server/types";
import { formatNumber } from "../lib/format.ts";

interface ActivityVariabilityTableProps {
  data: ActivityVariabilityRow[];
  totalCount: number;
  offset: number;
  limit: number;
  onPageChange: (newOffset: number) => void;
  loading?: boolean;
}

function getVariabilityColor(variabilityIndex: number): string {
  if (variabilityIndex < 1.05) return "text-green-400";
  if (variabilityIndex <= 1.1) return "text-yellow-400";
  return "text-red-400";
}

export function ActivityVariabilityTable({
  data,
  totalCount,
  offset,
  limit,
  onPageChange,
  loading,
}: ActivityVariabilityTableProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[200px]">
        <span className="text-dim text-sm">Loading variability data...</span>
      </div>
    );
  }

  if (data.length === 0 && offset === 0) {
    return (
      <div className="flex items-center justify-center h-[100px]">
        <span className="text-dim text-sm">No activities with power data available</span>
      </div>
    );
  }

  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(totalCount / limit);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left py-2 px-3 text-muted font-medium">Date</th>
            <th className="text-left py-2 px-3 text-muted font-medium">Activity</th>
            <th className="text-right py-2 px-3 text-muted font-medium">Normalized Power (W)</th>
            <th className="text-right py-2 px-3 text-muted font-medium">Avg Power (W)</th>
            <th className="text-right py-2 px-3 text-muted font-medium">Variability</th>
            <th className="text-right py-2 px-3 text-muted font-medium">Intensity</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr
              key={`${row.date}-${row.activityName}-${row.normalizedPower}-${row.averagePower}`}
              className="border-b border-border hover:bg-surface-hover"
            >
              <td className="py-2 px-3 text-foreground">
                {new Date(row.date).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </td>
              <td className="py-2 px-3 text-foreground max-w-[200px] truncate">
                {row.activityName}
              </td>
              <td className="py-2 px-3 text-right text-foreground">
                {formatNumber(row.normalizedPower)}
              </td>
              <td className="py-2 px-3 text-right text-foreground">
                {formatNumber(row.averagePower)}
              </td>
              <td
                className={`py-2 px-3 text-right font-mono ${getVariabilityColor(row.variabilityIndex)}`}
              >
                {formatNumber(row.variabilityIndex, 3)}
              </td>
              <td className="py-2 px-3 text-right text-foreground font-mono">
                {formatNumber(row.intensityFactor, 3)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center justify-between mt-3">
        <p className="text-xs text-dim">
          Variability: <span className="text-green-400">&lt;1.05 steady</span> /{" "}
          <span className="text-yellow-400">1.05-1.1 moderate</span> /{" "}
          <span className="text-red-400">&gt;1.1 variable</span>
        </p>
        {totalPages > 1 && (
          <div className="flex items-center gap-2 text-xs">
            <button
              type="button"
              disabled={offset === 0}
              onClick={() => onPageChange(Math.max(0, offset - limit))}
              className="px-2 py-1 rounded border border-border-strong text-muted hover:bg-surface-hover disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Previous
            </button>
            <span className="text-subtle">
              {currentPage} / {totalPages}
            </span>
            <button
              type="button"
              disabled={offset + limit >= totalCount}
              onClick={() => onPageChange(offset + limit)}
              className="px-2 py-1 rounded border border-border-strong text-muted hover:bg-surface-hover disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
