import { formatNumber } from "@dofek/format/format";
import type { ActivityVariabilityRow } from "dofek-server/types";
import { ActivityTable, type ActivityTableColumn } from "./ActivityTable.tsx";

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
  const columns: ActivityTableColumn<ActivityVariabilityRow>[] = [
    {
      key: "date",
      label: "Date",
      headerClassName: "text-left py-2 px-3 text-muted font-medium",
      cellClassName: "py-2 px-3 text-foreground",
      renderCell: (row) =>
        new Date(row.date).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        }),
    },
    {
      key: "activity",
      label: "Activity",
      headerClassName: "text-left py-2 px-3 text-muted font-medium",
      cellClassName: "py-2 px-3 text-foreground max-w-[200px] truncate",
      renderCell: (row) => row.activityName,
    },
    {
      key: "normalizedPower",
      label: "Normalized Power (W)",
      headerClassName: "text-right py-2 px-3 text-muted font-medium",
      cellClassName: "py-2 px-3 text-right text-foreground",
      renderCell: (row) => formatNumber(row.normalizedPower),
    },
    {
      key: "averagePower",
      label: "Avg Power (W)",
      headerClassName: "text-right py-2 px-3 text-muted font-medium",
      cellClassName: "py-2 px-3 text-right text-foreground",
      renderCell: (row) => formatNumber(row.averagePower),
    },
    {
      key: "variabilityIndex",
      label: "Variability",
      headerClassName: "text-right py-2 px-3 text-muted font-medium",
      cellClassName: "py-2 px-3 text-right font-mono",
      renderCell: (row) => (
        <span className={getVariabilityColor(row.variabilityIndex)}>
          {formatNumber(row.variabilityIndex, 3)}
        </span>
      ),
    },
    {
      key: "intensityFactor",
      label: "Intensity",
      headerClassName: "text-right py-2 px-3 text-muted font-medium",
      cellClassName: "py-2 px-3 text-right text-foreground font-mono",
      renderCell: (row) => formatNumber(row.intensityFactor, 3),
    },
  ];
  const footer = (
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
  );

  return (
    <ActivityTable
      rows={data}
      columns={columns}
      getRowKey={(row) =>
        `${row.activityId}-${row.date}-${row.normalizedPower}-${row.averagePower}-${row.activityName}`
      }
      getActivityId={(row) => row.activityId}
      headerRowClassName="border-b border-border"
      rowClassName="border-b border-border hover:bg-surface-hover cursor-pointer"
      footer={footer}
    />
  );
}
