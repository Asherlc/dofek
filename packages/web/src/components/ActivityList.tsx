import {
  type ActivityDataState,
  activityDataStateLabel,
  formatActivityMetric,
} from "@dofek/format/activity-data-state";
import {
  formatDateMedium,
  formatDurationMinutes,
  formatNumber,
  parseValidDate,
} from "@dofek/format/format";
import { formatActivityTypeLabel } from "@dofek/training/training";
import { useId, useState } from "react";
import { useUnitConverter } from "../lib/unitContext.ts";
import type { ActivityMapPreview } from "./ActivityMapTile.tsx";
import { ActivityTable, type ActivityTableColumn } from "./ActivityTable.tsx";
import { ActivityTypeIcon } from "./ActivityTypeIcon.tsx";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";
import { PaginationControls } from "./PaginationControls.tsx";

export interface Activity {
  id: string;
  started_at: string;
  ended_at: string | null;
  canonical_type: string;
  name: string | null;
  provider_id: string;
  source_providers: string[] | null;
  distance_meters: number | null;
  distance_state: ActivityDataState;
  elevation_gain_m: number | null;
  elevation_state: ActivityDataState;
  location?: {
    centroidLat: number;
    centroidLng: number;
    mapPreview: ActivityMapPreview;
  } | null;
}

interface ActivityListProps {
  activities: Activity[];
  additionalColumns?: Array<ActivityTableColumn<Activity>>;
  loading?: boolean;
  error?: string;
  emptyMessage?: string;
  totalCount?: number;
  page?: number;
  pageSize?: number;
  onPageChange?: (page: number) => void;
  onBulkDelete?: (ids: string[]) => Promise<void> | void;
  bulkDeletePending?: boolean;
  bulkDeleteError?: string | null;
}

function formatActivityDate(startedAt: string): string {
  const formattedDate = formatDateMedium(startedAt);
  return formattedDate === "--" ? "—" : formattedDate;
}

function formatActivityDuration(startedAt: string, endedAt: string | null): string {
  if (!endedAt) return "—";
  const startedDate = parseValidDate(startedAt);
  const endedDate = parseValidDate(endedAt);
  if (!startedDate || !endedDate) return "—";
  const durationMinutes = Math.round((endedDate.getTime() - startedDate.getTime()) / 60000);
  return durationMinutes >= 0 ? formatDurationMinutes(durationMinutes) : "—";
}

export function ActivityList({
  activities,
  additionalColumns = [],
  loading,
  error,
  emptyMessage = "No recent activities",
  totalCount,
  page,
  pageSize,
  onPageChange,
  onBulkDelete,
  bulkDeletePending = false,
  bulkDeleteError,
}: ActivityListProps) {
  const units = useUnitConverter();
  const [selectMode, setSelectMode] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [selectedActivityIds, setSelectedActivityIds] = useState<Set<string>>(new Set());
  const selectionGuidanceId = useId();

  if (loading) {
    return <ChartLoadingSkeleton height={100} />;
  }

  if (error) {
    return <p className="text-sm text-red-400 py-4">{error}</p>;
  }

  if (activities.length === 0) {
    return <div className="text-subtle text-sm py-4">{emptyMessage}</div>;
  }

  const currentPage = page ?? 0;
  const selectedCount = selectedActivityIds.size;
  const selectedIds = [...selectedActivityIds];
  const selectedCountLabel = `${selectedCount} ${
    selectedCount === 1 ? "activity" : "activities"
  } selected`;

  const toggleSelected = (activityId: string) => {
    setSelectedActivityIds((current) => {
      const next = new Set(current);
      if (next.has(activityId)) {
        next.delete(activityId);
      } else {
        next.add(activityId);
      }
      return next;
    });
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setConfirmDelete(false);
    setSelectedActivityIds(new Set());
  };

  const handleConfirmDelete = async () => {
    if (!onBulkDelete || selectedIds.length === 0) return;
    const result = onBulkDelete(selectedIds);
    if (result instanceof Promise) {
      await result;
      exitSelectMode();
      return;
    }
    exitSelectMode();
  };

  const selectionColumn: ActivityTableColumn<Activity> = {
    key: "select",
    label: "",
    headerClassName: "pb-2 pr-3 w-8",
    cellClassName: "py-2 pr-3 w-8",
    renderCell: (activity) => (
      <input
        type="checkbox"
        aria-label={`Select ${activity.name ?? formatActivityTypeLabel(activity.canonical_type)}`}
        checked={selectedActivityIds.has(activity.id)}
        onChange={() => toggleSelected(activity.id)}
        onClick={(event) => event.stopPropagation()}
        className="h-4 w-4 accent-accent cursor-pointer"
      />
    ),
  };

  const baseColumns: ActivityTableColumn<Activity>[] = [
    {
      key: "map",
      label: "Map",
      headerClassName: "pb-2 pr-4 whitespace-nowrap",
      cellClassName: "py-2 pr-4 whitespace-nowrap",
      renderCell: (activity) => {
        if (!activity.location) {
          return <ActivityTypeIcon activityType={activity.canonical_type} variant="compact" />;
        }
        const { mapPreview } = activity.location;

        return (
          <div className="relative h-12 w-16 overflow-hidden rounded bg-surface-hover">
            <div
              data-testid="activity-route-viewport"
              className="absolute inset-0 h-full w-full brightness-[0.95] contrast-[0.92] saturate-[0.85]"
              role="img"
              aria-label="Activity route map summary"
            >
              {mapPreview.tiles.map((tile) => (
                <img
                  key={`${tile.url}-${tile.x}-${tile.y}`}
                  data-testid="activity-map-preview-tile"
                  src={tile.url}
                  alt=""
                  className="absolute max-w-none"
                  loading="lazy"
                  referrerPolicy="origin"
                  style={{
                    left: `${(tile.x / mapPreview.width) * 100}%`,
                    top: `${(tile.y / mapPreview.height) * 100}%`,
                    width: `${(tile.width / mapPreview.width) * 100}%`,
                    height: `${(tile.height / mapPreview.height) * 100}%`,
                  }}
                />
              ))}
              <ActivityRouteOverlay mapPreview={mapPreview} />
            </div>
          </div>
        );
      },
    },
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
      renderCell: (activity) => formatActivityTypeLabel(activity.canonical_type),
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
      renderCell: (activity) => {
        const metric = formatActivityMetric(
          "Distance",
          activity.distance_meters,
          activity.distance_state,
          (value) => `${formatNumber(units.convertDistance(value / 1000))} ${units.distanceLabel}`,
        );
        if (metric.status !== "available") {
          return (
            <span data-state={metric.status}>
              {metric.label} {activityDataStateLabel(metric.status)}: {metric.reason}
            </span>
          );
        }
        return <span data-state="available">{metric.value}</span>;
      },
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
  const activityColumns = [...baseColumns, ...additionalColumns];
  const columns = selectMode ? [selectionColumn, ...activityColumns] : activityColumns;
  const footer =
    totalCount != null && pageSize != null && onPageChange ? (
      <PaginationControls
        page={currentPage}
        pageSize={pageSize}
        totalItems={totalCount}
        itemLabel="activities"
        onPageChange={onPageChange}
        className="mt-2"
      />
    ) : null;

  return (
    <div className="space-y-3">
      {onBulkDelete ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p id={selectionGuidanceId} className="text-xs text-muted">
            Choose one or more activities to delete.
          </p>
          {selectMode ? (
            <div className="flex flex-wrap items-center gap-2">
              <output
                aria-live="polite"
                aria-atomic="true"
                className="text-xs text-subtle tabular-nums"
              >
                {selectedCountLabel}
              </output>
              {confirmDelete ? (
                <>
                  <span className="text-xs text-muted">
                    Delete selected activities? This cannot be undone.
                  </span>
                  <button
                    type="button"
                    onClick={handleConfirmDelete}
                    disabled={bulkDeletePending || selectedCount === 0}
                    className="px-3 py-1.5 text-xs rounded bg-red-600 text-white hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
                  >
                    {bulkDeletePending ? "Deleting..." : "Confirm Delete"}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  disabled={bulkDeletePending || selectedCount === 0}
                  className="px-3 py-1.5 text-xs rounded bg-red-600 text-white hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
                >
                  Delete
                </button>
              )}
              <button
                type="button"
                onClick={exitSelectMode}
                disabled={bulkDeletePending}
                className="px-3 py-1.5 text-xs rounded bg-accent/10 text-foreground hover:bg-surface-hover disabled:opacity-50 transition-colors cursor-pointer"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setSelectMode(true)}
              aria-describedby={selectionGuidanceId}
              className="px-3 py-1.5 text-xs rounded bg-accent/10 text-foreground hover:bg-surface-hover transition-colors cursor-pointer"
            >
              Select activities
            </button>
          )}
        </div>
      ) : null}
      {bulkDeleteError ? <p className="text-sm text-red-400">{bulkDeleteError}</p> : null}
      <ActivityTable
        rows={activities}
        columns={columns}
        getRowKey={(activity) => activity.id}
        getActivityId={(activity) => activity.id}
        rowClassName={(activity) =>
          [
            "border-b border-border/50 hover:bg-surface-hover cursor-pointer activity-row",
            selectedActivityIds.has(activity.id) ? "bg-surface-hover" : "",
          ]
            .filter(Boolean)
            .join(" ")
        }
        onRowClick={selectMode ? (activity) => toggleSelected(activity.id) : undefined}
        footer={footer}
      />
    </div>
  );
}

function ActivityRouteOverlay({ mapPreview }: { mapPreview: ActivityMapPreview }) {
  const routePath = mapPreview.routePath;
  if (routePath == null || routePath.length < 2) return null;

  const points = routePath.map((point) => `${point.x},${point.y}`).join(" ");
  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox={`0 0 ${mapPreview.width} ${mapPreview.height}`}
      preserveAspectRatio="none"
    >
      <title>Activity route path</title>
      <polyline
        points={points}
        fill="none"
        stroke="white"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="6"
        vectorEffect="non-scaling-stroke"
      />
      <polyline
        data-testid="activity-route-path"
        points={points}
        fill="none"
        stroke="rgb(22 163 74)"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="3"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
