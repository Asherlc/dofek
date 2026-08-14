import { formatDateShort, formatIntensity, formatNumber } from "@dofek/format/format";
import { POWER_UNIT_LABEL } from "@dofek/format/units";
import { TRAINING_TERMINOLOGY } from "@dofek/training/terminology";
import type { ActivityVariabilityEmptyReason, ActivityVariabilityRow } from "dofek-server/types";
import { ActivityTable, type ActivityTableColumn } from "./ActivityTable.tsx";
import { PaginationControls } from "./PaginationControls.tsx";

interface ActivityVariabilityTableProps {
  data: ActivityVariabilityRow[];
  totalCount: number;
  offset: number;
  limit: number;
  onPageChange: (newOffset: number) => void;
  loading?: boolean;
  emptyReason?: ActivityVariabilityEmptyReason | null;
}

function getVariabilityColor(variabilityIndex: number): string {
  if (variabilityIndex < 1.05) return "text-green-400";
  if (variabilityIndex <= 1.1) return "text-yellow-400";
  return "text-red-400";
}

function getEmptyMessage(emptyReason: ActivityVariabilityEmptyReason | null | undefined): string {
  if (emptyReason === "no_ftp_estimate") {
    return "No recent cycling activities long enough to estimate threshold power.";
  }
  if (emptyReason === "no_normalized_power") {
    return "No cycling activities with enough power samples for variability yet.";
  }
  return "No cycling activities available.";
}

export function ActivityVariabilityTable({
  data,
  totalCount,
  offset,
  limit,
  onPageChange,
  loading,
  emptyReason,
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
        <span className="text-dim text-sm">{getEmptyMessage(emptyReason)}</span>
      </div>
    );
  }

  const currentPage = Math.floor(offset / limit);
  const columns: ActivityTableColumn<ActivityVariabilityRow>[] = [
    {
      key: "date",
      label: "Date",
      headerClassName: "text-left py-2 px-3 text-muted font-medium",
      cellClassName: "py-2 px-3 text-foreground",
      renderCell: (row) => formatDateShort(row.date),
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
      label: `${TRAINING_TERMINOLOGY.normalizedPower.plainLabel} (${POWER_UNIT_LABEL})`,
      headerClassName: "text-right py-2 px-3 text-muted font-medium",
      cellClassName: "py-2 px-3 text-right text-foreground",
      renderCell: (row) => formatNumber(row.normalizedPower),
    },
    {
      key: "averagePower",
      label: `Avg Power (${POWER_UNIT_LABEL})`,
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
      renderCell: (row) => formatIntensity(row.intensityFactor * 100),
    },
  ];
  const footer = (
    <div className="flex items-center justify-between mt-3">
      <p className="text-xs text-dim">
        Variability: <span className="text-green-400">&lt;1.05 steady</span> /{" "}
        <span className="text-yellow-400">1.05-1.1 moderate</span> /{" "}
        <span className="text-red-400">&gt;1.1 variable</span>
      </p>
      <PaginationControls
        page={currentPage}
        pageSize={limit}
        totalItems={totalCount}
        itemLabel="activities"
        onPageChange={(page) => onPageChange(page * limit)}
        className="min-w-[240px] border-t-0 pt-0"
      />
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
