import {
  type ActivityDataState,
  type ActivityMetric,
  activityDataStateLabel,
  formatActivityMetric,
} from "@dofek/format/activity-data-state";
import {
  type ActivityOverviewComparison,
  type ActivityOverviewKey,
  activityOverviewChangeForKey,
  formatActivityOverviewChange,
} from "@dofek/format/activity-overview";
import {
  formatDateForDisplay,
  formatDateYmd,
  formatDurationMinutes,
  isToday,
  isYesterday,
  parseValidDate,
} from "@dofek/format/format";
import { formatMeasurementText } from "@dofek/format/units";
import { formatActivityTypeLabel } from "@dofek/training/training";
import { Link } from "@tanstack/react-router";
import { useId, useMemo, useState } from "react";
import { ActivityCardContent, type ActivityCardData } from "../components/ActivityCardContent.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { PaginationControls } from "../components/PaginationControls.tsx";
import { ProcessingStatusWidget } from "../components/ProcessingStatusWidget.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { useProcessingStatus } from "../hooks/useProcessingStatus.ts";
import { trpc } from "../lib/trpc.ts";
import { useUnitConverter } from "../lib/unitContext.ts";

const DEFAULT_WEEKS = 4;
const ACTIVITY_PAGE_SIZE = 20;
const ALL_ACTIVITY_TYPES = "all";
const DATE_RANGE_OPTIONS = [
  { value: 4, label: "4 weeks" },
  { value: 8, label: "8 weeks" },
  { value: 12, label: "12 weeks" },
] as const;

export function ActivitiesPage() {
  const [weeks, setWeeks] = useState(DEFAULT_WEEKS);
  const [activityType, setActivityType] = useState(ALL_ACTIVITY_TYPES);
  const [showHidden, setShowHidden] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [selectedActivityIds, setSelectedActivityIds] = useState<Set<string>>(new Set());
  const [deletedActivityIds, setDeletedActivityIds] = useState<Set<string>>(new Set());
  const [activityPage, setActivityPage] = useState(0);
  const endDate = useMemo(() => formatDateYmd(), []);
  const units = useUnitConverter();
  const selectedActivityType = activityType === ALL_ACTIVITY_TYPES ? undefined : activityType;
  const queryInput = {
    weeks,
    endDate,
    ...(selectedActivityType ? { activityType: selectedActivityType } : {}),
    ...(showHidden ? { includeProviderAbsent: true } : {}),
  };
  const trpcUtils = trpc.useUtils();
  const query = trpc.calendar.weekList.useQuery(queryInput, {
    placeholderData: (previousData) => previousData,
  });
  const overviewQuery = trpc.calendar.activityOverview.useQuery(queryInput, {
    placeholderData: (previousData) => previousData,
  });
  const processingStatus = useProcessingStatus({ datasets: ["activity"] });
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
    onError: (_error, variables) => {
      setDeletedActivityIds((current) => {
        const next = new Set(current);
        for (const activityId of variables.ids) {
          next.delete(activityId);
        }
        return next;
      });
    },
  });
  const restoreProviderAbsent = trpc.activity.restoreProviderAbsent.useMutation({
    onSuccess: async () => {
      await Promise.all([
        trpcUtils.calendar.weekList.invalidate(),
        trpcUtils.calendar.activityOverview.invalidate(),
        trpcUtils.activity.list.invalidate(),
      ]);
      setSelectedActivityIds(new Set());
      setSelectMode(false);
      setConfirmRestore(false);
    },
  });

  const dayGroups = useMemo(() => {
    if (!query.data) return undefined;
    return query.data
      .map((day) => ({
        ...day,
        activities: day.activities.filter((activity) => !deletedActivityIds.has(activity.id)),
      }))
      .filter((day) => day.activities.length > 0);
  }, [query.data, deletedActivityIds]);
  const hiddenActivityIds = useMemo(() => {
    const ids = new Set<string>();
    for (const day of dayGroups ?? []) {
      for (const activity of day.activities) {
        if (activity.isProviderAbsent) {
          ids.add(activity.id);
        }
      }
    }
    return ids;
  }, [dayGroups]);
  const hasActivities = dayGroups?.some((day) => day.activities.length > 0) ?? false;
  const activityCount = dayGroups?.reduce((total, day) => total + day.activities.length, 0) ?? 0;
  const totalActivityPages = Math.ceil(activityCount / ACTIVITY_PAGE_SIZE);
  const currentActivityPage = Math.min(activityPage, Math.max(totalActivityPages - 1, 0));
  const visibleDayGroups = useMemo(() => {
    if (!dayGroups) return undefined;
    const visibleActivities = dayGroups
      .flatMap((day) =>
        day.activities.map((activity) => ({
          date: day.date,
          activity,
        })),
      )
      .slice(
        currentActivityPage * ACTIVITY_PAGE_SIZE,
        (currentActivityPage + 1) * ACTIVITY_PAGE_SIZE,
      );
    const grouped = new Map<string, typeof visibleActivities>();
    for (const entry of visibleActivities) {
      const existing = grouped.get(entry.date) ?? [];
      existing.push(entry);
      grouped.set(entry.date, existing);
    }
    return [...grouped.entries()].map(([date, entries]) => ({
      date,
      activities: entries.map((entry) => entry.activity),
    }));
  }, [currentActivityPage, dayGroups]);
  const selectedCount = selectedActivityIds.size;
  const selectedHiddenCount = [...selectedActivityIds].filter((id) =>
    hiddenActivityIds.has(id),
  ).length;
  const selectedVisibleCount = selectedCount - selectedHiddenCount;
  const subtitle = `Last ${weeks} weeks`;

  const cancelSelection = () => {
    setSelectedActivityIds(new Set());
    setSelectMode(false);
    setConfirmDelete(false);
    setConfirmRestore(false);
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
    if (selectedVisibleCount === 0) return;
    const ids = [...selectedActivityIds].filter((id) => !hiddenActivityIds.has(id));
    setDeletedActivityIds((current) => new Set([...current, ...ids]));
    bulkDelete.mutate({ ids });
  };

  const handleConfirmRestore = () => {
    if (selectedHiddenCount === 0) return;
    restoreProviderAbsent.mutate({
      ids: [...selectedActivityIds].filter((id) => hiddenActivityIds.has(id)),
    });
  };

  const updateActivityType = (nextActivityType: string) => {
    setActivityType(nextActivityType);
    setActivityPage(0);
    cancelSelection();
  };

  const updateWeeks = (nextWeeks: number) => {
    setWeeks(nextWeeks);
    setActivityPage(0);
    cancelSelection();
  };

  const updateShowHidden = (nextShowHidden: boolean) => {
    setShowHidden(nextShowHidden);
    setActivityPage(0);
    cancelSelection();
  };

  return (
    <PageLayout title="Activities" subtitle={subtitle}>
      <ProcessingStatusWidget
        data={processingStatus.data}
        error={processingStatus.error}
        loading={processingStatus.isLoading}
      />
      <div className="space-y-4">
        <ActivityControls
          activityTypes={overviewQuery.data?.activityTypes ?? []}
          activityType={activityType}
          weeks={weeks}
          showHidden={showHidden}
          canSelect={hasActivities}
          selectMode={selectMode}
          confirmDelete={confirmDelete}
          confirmRestore={confirmRestore}
          selectedCount={selectedCount}
          selectedHiddenCount={selectedHiddenCount}
          selectedVisibleCount={selectedVisibleCount}
          deletePending={bulkDelete.isPending}
          restorePending={restoreProviderAbsent.isPending}
          onActivityTypeChange={updateActivityType}
          onWeeksChange={updateWeeks}
          onShowHiddenChange={updateShowHidden}
          onSelect={() => setSelectMode(true)}
          onCancelSelection={cancelSelection}
          onDeleteSelected={() => setConfirmDelete(true)}
          onRestoreSelected={() => setConfirmRestore(true)}
          onConfirmDelete={handleConfirmDelete}
          onConfirmRestore={handleConfirmRestore}
        />
        {bulkDelete.error ? <QueryStatePanel error={bulkDelete.error} height={80} /> : null}
        {restoreProviderAbsent.error ? (
          <QueryStatePanel error={restoreProviderAbsent.error} height={80} />
        ) : null}
        {overviewQuery.isLoading && !overviewQuery.data ? (
          <QueryStatePanel variant="loading" height={120} />
        ) : overviewQuery.isError && !overviewQuery.data ? (
          <QueryStatePanel error={overviewQuery.error} height={120} />
        ) : (
          <>
            {overviewQuery.isError ? (
              <QueryStatePanel error={overviewQuery.error} height={72} />
            ) : null}
            <ActivityOverview overview={overviewQuery.data} units={units} />
          </>
        )}
      </div>
      {query.isLoading && !query.data ? (
        <QueryStatePanel variant="loading" height={400} />
      ) : query.isError && !query.data ? (
        <QueryStatePanel error={query.error} height={200} />
      ) : !dayGroups || dayGroups.length === 0 ? (
        <QueryStatePanel
          variant="empty"
          message={
            showHidden
              ? `No activities in the last ${weeks} weeks, including hidden ones.`
              : `No activities in the last ${weeks} weeks.`
          }
          height={200}
        />
      ) : (
        <div className="space-y-7">
          {query.isError ? <QueryStatePanel error={query.error} height={72} /> : null}
          {visibleDayGroups?.map((day) => (
            <section key={day.date}>
              <div className="mb-2 flex items-center gap-3">
                <h3 className="text-xs font-semibold text-muted uppercase tracking-wider">
                  {formatDayHeader(day.date)}
                </h3>
                <div className="h-px flex-1 bg-border/60" />
              </div>
              <div data-testid="activity-card-grid" className="grid gap-3 lg:grid-cols-2">
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
          <PaginationControls
            page={currentActivityPage}
            pageSize={ACTIVITY_PAGE_SIZE}
            totalItems={activityCount}
            itemLabel="activities"
            onPageChange={setActivityPage}
          />
        </div>
      )}
    </PageLayout>
  );
}

interface ActivityControlsProps {
  activityTypes: string[];
  activityType: string;
  weeks: number;
  showHidden: boolean;
  canSelect: boolean;
  selectMode: boolean;
  confirmDelete: boolean;
  confirmRestore: boolean;
  selectedCount: number;
  selectedHiddenCount: number;
  selectedVisibleCount: number;
  deletePending: boolean;
  restorePending: boolean;
  onActivityTypeChange: (activityType: string) => void;
  onWeeksChange: (weeks: number) => void;
  onShowHiddenChange: (showHidden: boolean) => void;
  onSelect: () => void;
  onCancelSelection: () => void;
  onDeleteSelected: () => void;
  onRestoreSelected: () => void;
  onConfirmDelete: () => void;
  onConfirmRestore: () => void;
}

function ActivityControls({
  activityTypes,
  activityType,
  weeks,
  showHidden,
  canSelect,
  selectMode,
  confirmDelete,
  confirmRestore,
  selectedCount,
  selectedHiddenCount,
  selectedVisibleCount,
  deletePending,
  restorePending,
  onActivityTypeChange,
  onWeeksChange,
  onShowHiddenChange,
  onSelect,
  onCancelSelection,
  onDeleteSelected,
  onRestoreSelected,
  onConfirmDelete,
  onConfirmRestore,
}: ActivityControlsProps) {
  const selectionGuidanceId = useId();
  const selectionGuidance = showHidden
    ? "Choose visible activities to delete or hidden activities to restore."
    : "Choose one or more activities to delete.";
  const selectedCountLabel = `${selectedCount} ${
    selectedCount === 1 ? "activity" : "activities"
  } selected`;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-solid p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Activity log</p>
          {canSelect ? (
            <p id={selectionGuidanceId} className="mt-0.5 text-xs text-muted">
              {selectionGuidance}
            </p>
          ) : null}
        </div>
        {canSelect && !selectMode ? (
          <button
            type="button"
            onClick={onSelect}
            aria-describedby={selectionGuidanceId}
            className="px-3 py-1.5 text-xs rounded bg-accent/10 text-foreground hover:bg-surface-hover transition-colors cursor-pointer"
          >
            Select activities
          </button>
        ) : null}
      </div>
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
                onClick={onConfirmDelete}
                disabled={deletePending || selectedVisibleCount === 0}
                className="px-3 py-1.5 text-xs rounded bg-red-600 text-white hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
              >
                {deletePending ? "Deleting..." : "Confirm Delete"}
              </button>
            </>
          ) : confirmRestore ? (
            <>
              <span className="text-xs text-muted">
                Restore selected hidden activities? They will reappear in your activity log.
              </span>
              <button
                type="button"
                onClick={onConfirmRestore}
                disabled={restorePending || selectedHiddenCount === 0}
                className="px-3 py-1.5 text-xs rounded bg-accent text-on-accent hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
              >
                {restorePending ? "Restoring..." : "Confirm Restore"}
              </button>
            </>
          ) : (
            <>
              {showHidden ? (
                <button
                  type="button"
                  onClick={onRestoreSelected}
                  disabled={restorePending || selectedHiddenCount === 0}
                  className="px-3 py-1.5 text-xs rounded bg-accent text-on-accent hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
                >
                  Restore
                </button>
              ) : null}
              <button
                type="button"
                onClick={onDeleteSelected}
                disabled={deletePending || selectedVisibleCount === 0}
                className="px-3 py-1.5 text-xs rounded bg-red-600 text-white hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
              >
                Delete
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onCancelSelection}
            disabled={deletePending || restorePending}
            className="px-3 py-1.5 text-xs rounded bg-accent/10 text-foreground hover:bg-surface-hover disabled:opacity-50 transition-colors cursor-pointer"
          >
            Cancel
          </button>
        </div>
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
        <label className="flex items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(event) => onShowHiddenChange(event.target.checked)}
            className="h-4 w-4 accent-accent cursor-pointer"
          />
          Show hidden activities
        </label>
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
  activity: ActivityCardData;
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
  const isHidden = activity.isProviderAbsent === true;
  const cardClassName = [
    "card block h-full overflow-hidden transition-colors",
    selectMode ? "cursor-pointer hover:bg-surface-elevated" : "hover:bg-surface-elevated",
    selected ? "ring-2 ring-accent bg-surface-hover" : "",
    isHidden ? "border-l-4 border-l-amber-500/80 bg-amber-500/5" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const content = (
    <ActivityCardContent
      activity={activity}
      units={units}
      selectMode={selectMode}
      selected={selected}
    />
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
  totalDistanceMeters: number | null;
  totalDistanceState: ActivityDataState;
  totalElevationGainM: number | null;
  totalElevationState: ActivityDataState;
  comparison?: ActivityOverviewComparison;
}

type ActivityOverviewItem =
  | { key: "activityCount"; label: string; value: string }
  | { key: "totalMinutes"; label: string; value: string }
  | (ActivityMetric & { key: "totalDistanceMeters" })
  | (ActivityMetric & { key: "totalElevationGainM" });

function ActivityOverview({
  overview,
  units,
}: {
  overview: ActivityOverviewData | undefined;
  units: ReturnType<typeof useUnitConverter>;
}) {
  const items: ActivityOverviewItem[] = overview
    ? [
        { key: "activityCount", label: "Activities", value: String(overview.activityCount) },
        { key: "totalMinutes", label: "Time", value: formatDurationMinutes(overview.totalMinutes) },
        {
          key: "totalDistanceMeters",
          ...formatActivityMetric(
            "Distance",
            overview.totalDistanceMeters,
            overview.totalDistanceState,
            (distanceMeters) => formatMeasurementText(units.formatDistance(distanceMeters / 1000)),
          ),
        },
        {
          key: "totalElevationGainM",
          ...formatActivityMetric(
            "Elevation",
            overview.totalElevationGainM,
            overview.totalElevationState,
            (elevationMeters) => formatMeasurementText(units.formatElevation(elevationMeters)),
          ),
        },
      ]
    : [
        { key: "activityCount", label: "Activities", value: "Loading…" },
        { key: "totalMinutes", label: "Time", value: "Loading…" },
        { key: "totalDistanceMeters", status: "missing", label: "Distance", reason: "Loading…" },
        {
          key: "totalElevationGainM",
          status: "missing",
          label: "Elevation",
          reason: "Loading…",
        },
      ];

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {items.map((item) => {
        const isMetric = "status" in item;
        const comparison = overview?.comparison
          ? activityOverviewChangeForKey(overview.comparison, item.key)
          : undefined;
        const formatComparisonMagnitude: Record<ActivityOverviewKey, (value: number) => string> = {
          activityCount: (value) => String(value),
          totalMinutes: (value) => formatDurationMinutes(value),
          totalDistanceMeters: (value) => formatMeasurementText(units.formatDistance(value / 1000)),
          totalElevationGainM: (value) => formatMeasurementText(units.formatElevation(value)),
        };
        return (
          <div
            key={item.key}
            className="rounded-lg border border-border bg-surface-solid p-3"
            data-state={isMetric ? item.status : undefined}
          >
            <div className="text-lg font-semibold tabular-nums">
              {isMetric && item.status !== "available"
                ? `${item.label} ${activityDataStateLabel(item.status)}`
                : item.value}
            </div>
            <div className="mt-0.5 text-[11px] font-medium uppercase tracking-wider text-muted">
              {isMetric && item.status !== "available" ? item.reason : item.label}
            </div>
            {comparison ? (
              <div className="mt-1 text-xs text-subtle">
                {formatActivityOverviewChange(
                  comparison,
                  overview?.comparison?.periodLabel ?? "previous period",
                  formatComparisonMagnitude[item.key],
                )}
              </div>
            ) : null}
          </div>
        );
      })}
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
