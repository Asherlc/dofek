import {
  formatDateForDisplay,
  formatDateYmd,
  formatDurationMinutes,
  formatTime,
  isToday,
  isYesterday,
  parseValidDate,
} from "@dofek/format/format";
import { formatMeasurementText } from "@dofek/format/units";
import { formatActivityTypeLabel } from "@dofek/training/training";
import { Link } from "@tanstack/react-router";
import { type CSSProperties, useMemo, useState } from "react";
import { PageLayout } from "../components/PageLayout.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { trpc } from "../lib/trpc.ts";
import { useUnitConverter } from "../lib/unitContext.ts";

const DEFAULT_WEEKS = 4;
const ALL_ACTIVITY_TYPES = "all";
const ROUTE_THUMBNAIL_PADDING_PERCENT = 20;
const MAX_ROUTE_THUMBNAIL_SCALE = 2.5;
const MIN_ROUTE_THUMBNAIL_SPAN_PERCENT = 1;
const DATE_RANGE_OPTIONS = [
  { value: 4, label: "4 weeks" },
  { value: 8, label: "8 weeks" },
  { value: 12, label: "12 weeks" },
] as const;

type RoutePathPoint = { x: number; y: number };

function formatRouteViewportNumber(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function getRouteViewportStyle(routePath?: RoutePathPoint[] | null): CSSProperties | undefined {
  if (routePath == null || routePath.length < 2) return undefined;

  const firstPoint = routePath[0];
  if (!firstPoint) return undefined;

  let minX = firstPoint.x;
  let maxX = firstPoint.x;
  let minY = firstPoint.y;
  let maxY = firstPoint.y;

  for (const point of routePath) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }

  const routeWidth = Math.max(maxX - minX, MIN_ROUTE_THUMBNAIL_SPAN_PERCENT);
  const routeHeight = Math.max(maxY - minY, MIN_ROUTE_THUMBNAIL_SPAN_PERCENT);
  const fittedScale = Math.min(
    (100 - ROUTE_THUMBNAIL_PADDING_PERCENT * 2) / routeWidth,
    (100 - ROUTE_THUMBNAIL_PADDING_PERCENT * 2) / routeHeight,
  );
  const scale = Math.max(1, Math.min(MAX_ROUTE_THUMBNAIL_SCALE, fittedScale));
  const routeCenterX = (minX + maxX) / 2;
  const routeCenterY = (minY + maxY) / 2;
  const minTranslate = 100 * (1 - scale);
  const translateX = Math.min(0, Math.max(minTranslate, 50 - routeCenterX * scale));
  const translateY = Math.min(0, Math.max(minTranslate, 50 - routeCenterY * scale));

  return {
    transform: `translate(${formatRouteViewportNumber(translateX)}%, ${formatRouteViewportNumber(
      translateY,
    )}%) scale(${formatRouteViewportNumber(scale)})`,
    transformOrigin: "top left",
  };
}

export function ActivitiesPage() {
  const [weeks, setWeeks] = useState(DEFAULT_WEEKS);
  const [activityType, setActivityType] = useState(ALL_ACTIVITY_TYPES);
  const [selectMode, setSelectMode] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [selectedActivityIds, setSelectedActivityIds] = useState<Set<string>>(new Set());
  const endDate = useMemo(() => formatDateYmd(), []);
  const units = useUnitConverter();
  const selectedActivityType = activityType === ALL_ACTIVITY_TYPES ? undefined : activityType;
  const queryInput = {
    weeks,
    endDate,
    ...(selectedActivityType ? { activityType: selectedActivityType } : {}),
  };
  const trpcUtils = trpc.useUtils();
  const query = trpc.calendar.weekList.useQuery(queryInput);
  const overviewQuery = trpc.calendar.activityOverview.useQuery(queryInput, {
    placeholderData: (previousData) => previousData,
  });
  const bulkDelete = trpc.activity.bulkDelete.useMutation({
    onSuccess: async () => {
      await Promise.all([
        trpcUtils.calendar.weekList.invalidate(),
        trpcUtils.calendar.activityOverview.invalidate(),
        trpcUtils.activity.list.invalidate(),
      ]);
      setSelectedActivityIds(new Set());
      setSelectMode(false);
      setConfirmDelete(false);
    },
  });

  const dayGroups = query.data;
  const hasActivities = dayGroups?.some((day) => day.activities.length > 0) ?? false;
  const selectedCount = selectedActivityIds.size;
  const subtitle = `Last ${weeks} weeks`;

  const cancelSelection = () => {
    setSelectedActivityIds(new Set());
    setSelectMode(false);
    setConfirmDelete(false);
  };

  const toggleSelectedActivity = (activityId: string) => {
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

  const handleConfirmDelete = () => {
    if (selectedCount === 0) return;
    bulkDelete.mutate({ ids: [...selectedActivityIds] });
  };

  const updateActivityType = (nextActivityType: string) => {
    setActivityType(nextActivityType);
    cancelSelection();
  };

  const updateWeeks = (nextWeeks: number) => {
    setWeeks(nextWeeks);
    cancelSelection();
  };

  return (
    <PageLayout title="Activities" subtitle={subtitle}>
      <div className="space-y-4">
        <ActivityControls
          activityTypes={overviewQuery.data?.activityTypes ?? []}
          activityType={activityType}
          weeks={weeks}
          canSelect={hasActivities}
          selectMode={selectMode}
          confirmDelete={confirmDelete}
          selectedCount={selectedCount}
          deletePending={bulkDelete.isPending}
          onActivityTypeChange={updateActivityType}
          onWeeksChange={updateWeeks}
          onSelect={() => setSelectMode(true)}
          onCancelSelection={cancelSelection}
          onDeleteSelected={() => setConfirmDelete(true)}
          onConfirmDelete={handleConfirmDelete}
        />
        {bulkDelete.error ? <QueryStatePanel error={bulkDelete.error} height={80} /> : null}
        {overviewQuery.isLoading ? (
          <QueryStatePanel variant="loading" height={120} />
        ) : overviewQuery.isError ? (
          <QueryStatePanel error={overviewQuery.error} height={120} />
        ) : (
          <ActivityOverview overview={overviewQuery.data} units={units} />
        )}
      </div>
      {query.isLoading ? (
        <QueryStatePanel variant="loading" height={400} />
      ) : query.isError ? (
        <QueryStatePanel error={query.error} height={200} />
      ) : !dayGroups || dayGroups.length === 0 ? (
        <QueryStatePanel
          variant="empty"
          message={`No activities in the last ${weeks} weeks.`}
          height={200}
        />
      ) : (
        <div className="space-y-7">
          {dayGroups.map((day) => (
            <section key={day.date}>
              <div className="mb-2 flex items-center gap-3">
                <h3 className="text-xs font-semibold text-muted uppercase tracking-wider">
                  {formatDayHeader(day.date)}
                </h3>
                <div className="h-px flex-1 bg-border/60" />
              </div>
              <div className="space-y-2">
                {day.activities.map((activity) => (
                  <ActivityCard
                    key={activity.id}
                    activity={activity}
                    units={units}
                    selectMode={selectMode}
                    selected={selectedActivityIds.has(activity.id)}
                    onToggleSelected={() => toggleSelectedActivity(activity.id)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </PageLayout>
  );
}

interface ActivityControlsProps {
  activityTypes: string[];
  activityType: string;
  weeks: number;
  canSelect: boolean;
  selectMode: boolean;
  confirmDelete: boolean;
  selectedCount: number;
  deletePending: boolean;
  onActivityTypeChange: (activityType: string) => void;
  onWeeksChange: (weeks: number) => void;
  onSelect: () => void;
  onCancelSelection: () => void;
  onDeleteSelected: () => void;
  onConfirmDelete: () => void;
}

function ActivityControls({
  activityTypes,
  activityType,
  weeks,
  canSelect,
  selectMode,
  confirmDelete,
  selectedCount,
  deletePending,
  onActivityTypeChange,
  onWeeksChange,
  onSelect,
  onCancelSelection,
  onDeleteSelected,
  onConfirmDelete,
}: ActivityControlsProps) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-solid p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-semibold">Activity log</p>
        {canSelect && !selectMode ? (
          <button
            type="button"
            onClick={onSelect}
            className="px-3 py-1.5 text-xs rounded bg-accent/10 text-foreground hover:bg-surface-hover transition-colors cursor-pointer"
          >
            Select
          </button>
        ) : null}
      </div>
      {selectMode ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-subtle tabular-nums">{selectedCount} selected</span>
          {confirmDelete ? (
            <>
              <span className="text-xs text-muted">
                Delete selected activities? This cannot be undone.
              </span>
              <button
                type="button"
                onClick={onConfirmDelete}
                disabled={deletePending || selectedCount === 0}
                className="px-3 py-1.5 text-xs rounded bg-red-600 text-white hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
              >
                {deletePending ? "Deleting..." : "Confirm Delete"}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onDeleteSelected}
              disabled={deletePending || selectedCount === 0}
              className="px-3 py-1.5 text-xs rounded bg-red-600 text-white hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              Delete
            </button>
          )}
          <button
            type="button"
            onClick={onCancelSelection}
            disabled={deletePending}
            className="px-3 py-1.5 text-xs rounded bg-accent/10 text-foreground hover:bg-surface-hover disabled:opacity-50 transition-colors cursor-pointer"
          >
            Cancel
          </button>
        </div>
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
        <label className="flex items-center gap-2 text-xs text-muted">
          Date range
          <select
            value={weeks}
            onChange={(event) => onWeeksChange(Number(event.target.value))}
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-foreground"
          >
            {DATE_RANGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-muted">
          Activity type
          <select
            value={activityType}
            onChange={(event) => onActivityTypeChange(event.target.value)}
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-foreground"
          >
            <option value={ALL_ACTIVITY_TYPES}>All activities</option>
            {activityTypes.map((type) => (
              <option key={type} value={type}>
                {formatActivityTypeLabel(type)}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

interface ActivityCardProps {
  activity: {
    id: string;
    name: string | null;
    activityType: string;
    startedAt: string;
    durationMin: number;
    location: ActivityMapTileProps["location"] | null;
    stats: { label: string; value: string }[];
  };
  units: ReturnType<typeof useUnitConverter>;
  selectMode: boolean;
  selected: boolean;
  onToggleSelected: () => void;
}

function ActivityCard({
  activity,
  units,
  selectMode,
  selected,
  onToggleSelected,
}: ActivityCardProps) {
  const cardClassName = [
    "card block overflow-hidden transition-colors",
    selectMode ? "cursor-pointer hover:bg-surface-elevated" : "hover:bg-surface-elevated",
    selected ? "ring-2 ring-accent bg-surface-hover" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const content = (
    <div className="flex flex-col sm:flex-row sm:items-stretch">
      <div className="flex min-w-0 flex-1 flex-col gap-3 p-3 sm:flex-row sm:items-center sm:p-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {selectMode ? (
              <input
                type="checkbox"
                aria-label={`Select ${activity.name ?? formatActivityTypeLabel(activity.activityType)}`}
                checked={selected}
                readOnly
                className="h-4 w-4 accent-accent cursor-pointer"
              />
            ) : null}
            <h4 className="truncate text-sm font-semibold">
              {activity.name ?? formatActivityTypeLabel(activity.activityType)}
            </h4>
            <span className="rounded border border-border bg-surface-secondary px-1.5 py-0.5 text-[11px] font-medium text-muted">
              {formatActivityTypeLabel(activity.activityType)}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted">
            {formatTime(activity.startedAt)} · {formatDurationMinutes(activity.durationMin)}
          </p>
        </div>
        <ActivityMetricStrip activity={activity} units={units} />
      </div>
      {activity.location ? <ActivityMapTile location={activity.location} units={units} /> : null}
    </div>
  );

  if (selectMode) {
    return (
      <button
        type="button"
        onClick={onToggleSelected}
        className={`${cardClassName} w-full text-left`}
      >
        {content}
      </button>
    );
  }

  return (
    <Link to="/activity/$id" params={{ id: activity.id }} className={cardClassName}>
      {content}
    </Link>
  );
}

interface ActivityOverviewData {
  activityCount: number;
  totalMinutes: number;
  totalDistanceMeters: number;
  totalElevationGainM: number;
}

function ActivityOverview({
  overview,
  units,
}: {
  overview: ActivityOverviewData | undefined;
  units: ReturnType<typeof useUnitConverter>;
}) {
  const items = [
    { label: "Activities", value: overview ? String(overview.activityCount) : "—" },
    {
      label: "Time",
      value: overview ? formatDurationMinutes(overview.totalMinutes) : "—",
    },
    {
      label: "Distance",
      value: overview
        ? formatMeasurementText(units.formatDistance(overview.totalDistanceMeters / 1000))
        : "—",
    },
    {
      label: "Elevation",
      value: overview
        ? formatMeasurementText(units.formatElevation(overview.totalElevationGainM))
        : "—",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="rounded-lg border border-border bg-surface-solid p-3">
          <div className="text-lg font-semibold tabular-nums">{item.value}</div>
          <div className="mt-0.5 text-[11px] font-medium uppercase tracking-wider text-muted">
            {item.label}
          </div>
        </div>
      ))}
    </div>
  );
}

interface ActivityMapTileProps {
  location: {
    tileUrl: string;
    routePath?: { x: number; y: number }[] | null;
    distanceMeters: number | null;
    elevationGainM: number | null;
  };
  units: ReturnType<typeof useUnitConverter>;
}

function ActivityMapTile({ location, units }: ActivityMapTileProps) {
  const [loadFailed, setLoadFailed] = useState(false);
  const routeViewportStyle = getRouteViewportStyle(location.routePath);

  return (
    <div className="relative h-24 overflow-hidden bg-surface-secondary sm:h-auto sm:w-36 sm:shrink-0">
      {loadFailed ? (
        <div className="w-full h-full flex items-center justify-center text-xs text-muted">
          Map unavailable
        </div>
      ) : (
        <div
          data-testid="activity-route-viewport"
          className="absolute inset-0 h-full w-full"
          style={routeViewportStyle}
        >
          <img
            src={location.tileUrl}
            alt="Activity location map"
            className="w-full h-full object-cover"
            loading="lazy"
            referrerPolicy="origin"
            onError={() => setLoadFailed(true)}
          />
          <ActivityRouteOverlay routePath={location.routePath} />
        </div>
      )}
      <div className="absolute bottom-2 left-2 flex flex-wrap gap-1">
        {location.distanceMeters != null ? (
          <span className="bg-black/60 text-white text-[11px] font-semibold px-2 py-0.5 rounded">
            {formatMeasurementText(units.formatDistance(location.distanceMeters / 1000))}
          </span>
        ) : null}
        {location.elevationGainM != null ? (
          <span className="bg-black/60 text-white text-[11px] font-semibold px-2 py-0.5 rounded">
            ↑ {formatMeasurementText(units.formatElevation(location.elevationGainM))}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function ActivityRouteOverlay({ routePath }: { routePath?: { x: number; y: number }[] | null }) {
  if (routePath == null || routePath.length < 2) return null;

  const points = routePath.map((point) => `${point.x},${point.y}`).join(" ");
  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 100 100"
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

function ActivityMetricStrip({
  activity,
  units,
}: {
  activity: {
    location: {
      distanceMeters: number | null;
      elevationGainM: number | null;
    } | null;
    stats: { label: string; value: string }[];
  };
  units: ReturnType<typeof useUnitConverter>;
}) {
  const locationStats =
    activity.location != null
      ? [
          {
            label: "Distance",
            value:
              activity.location.distanceMeters != null
                ? formatMeasurementText(
                    units.formatDistance(activity.location.distanceMeters / 1000),
                  )
                : "—",
          },
          {
            label: "Elevation",
            value:
              activity.location.elevationGainM != null
                ? formatMeasurementText(units.formatElevation(activity.location.elevationGainM))
                : "—",
          },
        ]
      : activity.stats;

  return (
    <div className="grid grid-cols-2 gap-2 sm:w-72 sm:shrink-0">
      {locationStats.slice(0, 2).map((stat) => (
        <div key={stat.label} className="rounded-md bg-surface-secondary px-2 py-1.5 text-right">
          <div className="text-sm font-semibold tabular-nums">{stat.value}</div>
          <div className="mt-0.5 text-[11px] text-muted">{stat.label}</div>
        </div>
      ))}
    </div>
  );
}

function formatDayHeader(dateStr: string): string {
  const date = parseValidDate(`${dateStr}T00:00:00`);
  if (!date) return dateStr;
  if (isToday(date)) return "Today";
  if (isYesterday(date)) return "Yesterday";
  return formatDateForDisplay(date);
}
