import { formatNumber, parseValidDate } from "@dofek/format/format";
import { formatActivityTypeLabel } from "@dofek/training/training";
import { useUnitConverter } from "../lib/unitContext.ts";
import { ActivityTable, type ActivityTableColumn } from "./ActivityTable.tsx";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

export interface Activity {
  id: string;
  started_at: string;
  ended_at: string | null;
  activity_type: string;
  name: string | null;
  provider_id: string;
  source_providers: string[] | null;
  distance_meters?: number | null;
  calories?: number | null;
}

interface ActivityListProps {
  activities: Activity[];
  loading?: boolean;
  error?: string;
  totalCount?: number;
  page?: number;
  pageSize?: number;
  onPageChange?: (page: number) => void;
}

function formatActivityDate(startedAt: string): string {
  const startedDate = parseValidDate(startedAt);
  return startedDate ? startedDate.toLocaleDateString() : "—";
}

function formatActivityDuration(startedAt: string, endedAt: string | null): string {
  if (!endedAt) return "—";
  const startedDate = parseValidDate(startedAt);
  const endedDate = parseValidDate(endedAt);
  if (!startedDate || !endedDate) return "—";
  const durationMinutes = Math.round((endedDate.getTime() - startedDate.getTime()) / 60000);
  return durationMinutes >= 0 ? `${durationMinutes}m` : "—";
}

export function ActivityList({
  activities,
  loading,
  error,
  totalCount,
  page,
  pageSize,
  onPageChange,
}: ActivityListProps) {
  const units = useUnitConverter();

  if (loading) {
    return <ChartLoadingSkeleton height={100} />;
  }

  if (error) {
    return <p className="text-sm text-red-400 py-4">{error}</p>;
  }

  if (activities.length === 0) {
    return <div className="text-subtle text-sm py-4">No recent activities</div>;
  }

  const totalPages =
    totalCount != null && pageSize != null ? Math.ceil(totalCount / pageSize) : undefined;
  const currentPage = page ?? 0;
  const columns: ActivityTableColumn<Activity>[] = [
    {
      key: "date",
      label: "Date",
      headerClassName: "pb-2 pr-4 whitespace-nowrap",
      cellClassName: "py-2 pr-4 text-foreground whitespace-nowrap",
      renderCell: (activity) => formatActivityDate(activity.started_at),
    },
    {
      key: "type",
      label: "Type",
      headerClassName: "pb-2 pr-4 whitespace-nowrap",
      cellClassName: "py-2 pr-4 whitespace-nowrap",
      renderCell: (activity) => formatActivityTypeLabel(activity.activity_type),
    },
    {
      key: "name",
      label: "Name",
      headerClassName: "pb-2 pr-4 whitespace-nowrap",
      cellClassName: "py-2 pr-4 text-foreground max-w-[200px] truncate",
      renderCell: (activity) => activity.name ?? "—",
    },
    {
      key: "duration",
      label: "Duration",
      headerClassName: "pb-2 pr-4 whitespace-nowrap",
      cellClassName: "py-2 pr-4 tabular-nums whitespace-nowrap",
      renderCell: (activity) => formatActivityDuration(activity.started_at, activity.ended_at),
    },
    {
      key: "distance",
      label: "Distance",
      headerClassName: "pb-2 pr-4 whitespace-nowrap",
      cellClassName: "py-2 pr-4 tabular-nums whitespace-nowrap text-foreground",
      renderCell: (activity) =>
        activity.distance_meters
          ? `${formatNumber(units.convertDistance(activity.distance_meters / 1000))} ${units.distanceLabel}`
          : "—",
    },
    {
      key: "calories",
      label: "Calories",
      headerClassName: "pb-2 pr-4 whitespace-nowrap",
      cellClassName: "py-2 pr-4 tabular-nums whitespace-nowrap text-foreground",
      renderCell: (activity) => (activity.calories ? `${Math.round(activity.calories)} kcal` : "—"),
    },
    {
      key: "provider",
      label: "Provider",
      headerClassName: "pb-2 pr-4 whitespace-nowrap",
      cellClassName: "py-2 pr-4 text-muted whitespace-nowrap",
      renderCell: (activity) => activity.provider_id,
    },
    {
      key: "sources",
      label: "Sources",
      headerClassName: "pb-2 whitespace-nowrap",
      cellClassName: "py-2 text-subtle text-xs whitespace-nowrap",
      renderCell: (activity) => activity.source_providers?.join(", "),
    },
  ];
  const footer =
    totalPages != null && totalPages > 1 && onPageChange ? (
      <div className="flex items-center justify-between pt-3 border-t border-border/50 mt-2">
        <span className="text-xs text-subtle tabular-nums">{totalCount} activities</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onPageChange(currentPage - 1)}
            disabled={currentPage <= 0}
            className="px-2 py-1 text-xs text-muted hover:text-foreground disabled:text-dim disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            Previous
          </button>
          <span className="text-xs text-subtle tabular-nums">
            {currentPage + 1} / {totalPages}
          </span>
          <button
            type="button"
            onClick={() => onPageChange(currentPage + 1)}
            disabled={currentPage >= totalPages - 1}
            className="px-2 py-1 text-xs text-muted hover:text-foreground disabled:text-dim disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            Next
          </button>
        </div>
      </div>
    ) : null;

  return (
    <ActivityTable
      rows={activities}
      columns={columns}
      getRowKey={(activity) => activity.id}
      getActivityId={(activity) => activity.id}
      rowClassName="border-b border-border/50 hover:bg-surface-hover cursor-pointer activity-row"
      footer={footer}
    />
  );
}
