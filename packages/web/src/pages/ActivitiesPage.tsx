import {
  type ActivityAgendaPreset,
  activityAgendaRange,
  filterUpcomingActivityAgenda,
  formatActivityAgendaCaption,
  upcomingActivityAgendaRange,
} from "@dofek/format/activity-agenda";
import {
  type ActivityDataState,
  type ActivityMetric,
  activityDataStateLabel,
  formatActivityMetric,
} from "@dofek/format/activity-data-state";
import {
  type ActivityOverviewComparison,
  activityOverviewChangeForKey,
  createActivityOverviewComparisonFormatters,
  formatActivityOverviewChange,
} from "@dofek/format/activity-overview";
import {
  formatDateForDisplay,
  formatDurationMinutes,
  isToday,
  isYesterday,
  parseValidDate,
} from "@dofek/format/format";
import { formatMeasurementText } from "@dofek/format/units";
import { isConnectionFailure, userFacingErrorMessage } from "@dofek/format/user-facing-error";
import { processingPollInterval } from "@dofek/providers/processing-status";
import { ACTIVITY_IMAGES_QUERY_OPTIONS } from "@dofek/training/activity-images";
import { formatActivityTypeLabel } from "@dofek/training/training";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ActivityCardContent, type ActivityCardData } from "../components/ActivityCardContent.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { PaginationControls } from "../components/PaginationControls.tsx";
import { PlannedWorkoutCard } from "../components/PlannedWorkoutCard.tsx";
import { ProcessingStatusWidget } from "../components/ProcessingStatusWidget.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { useProcessingStatus } from "../hooks/useProcessingStatus.ts";
import { useTodayQueryDate } from "../hooks/useTodayQueryDate.ts";
import { trpc } from "../lib/trpc.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import { ActivityControls } from "./ActivityControls.tsx";
import { ActivitySearchControls, type ActivitySearchSelection } from "./ActivitySearchControls.tsx";

const ACTIVITY_PAGE_SIZE = 20;
const ALL_ACTIVITY_TYPES = "all";
const DEFAULT_PRESET: ActivityAgendaPreset = "this-week";
const ACTIVITY_VIEWS = [
  { id: "completed", title: "Completed" },
  { id: "upcoming", title: "Upcoming" },
] as const;
type ActivityView = (typeof ACTIVITY_VIEWS)[number]["id"];

export function ActivitiesPage() {
  const tabsId = useId();
  const [view, setView] = useState<ActivityView>("completed");
  const [upcomingSport, setUpcomingSport] = useState<string>();
  const [preset, setPreset] = useState<ActivityAgendaPreset>(DEFAULT_PRESET);
  const [activityType, setActivityType] = useState(ALL_ACTIVITY_TYPES);
  const [showHidden, setShowHidden] = useState(false);
  const [searchSelection, setSearchSelection] = useState<ActivitySearchSelection>();
  const searchTitle = searchSelection?.kind === "title" ? searchSelection.name : undefined;
  const searchLocation =
    searchSelection?.kind === "nearby"
      ? {
          kind: "nearby" as const,
          latitude: searchSelection.latitude,
          longitude: searchSelection.longitude,
        }
      : searchSelection?.kind === "name"
        ? { kind: "name" as const, name: searchSelection.name }
        : undefined;
  const searching = view === "completed" && searchSelection !== undefined;
  const [selectMode, setSelectMode] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [selectedActivities, setSelectedActivities] = useState<
    Map<
      string,
      {
        activityType: string;
        isProviderAbsent?: boolean;
      }
    >
  >(new Map());
  const selectedActivityIds = new Set(selectedActivities.keys());
  const [deletedActivityIds, setDeletedActivityIds] = useState<Set<string>>(new Set());
  const [activityPage, setActivityPage] = useState(0);
  const today = useTodayQueryDate();
  const units = useUnitConverter();
  const selectedActivityType = activityType === ALL_ACTIVITY_TYPES ? undefined : activityType;
  const agendaRange = useMemo(() => activityAgendaRange(preset, today), [preset, today]);
  const dateOrder = "newest" as const;
  const futureOnly = view === "upcoming";
  const showOverview = !futureOnly;
  const upcomingRange = useMemo(() => upcomingActivityAgendaRange(today), [today]);
  const agendaSpanKey = `${agendaRange.startDate}:${agendaRange.endDate}`;
  const [observedAgendaSpanKey, setObservedAgendaSpanKey] = useState(agendaSpanKey);
  const cancelSelection = () => {
    setSelectedActivities(new Map());
    setSelectMode(false);
    setConfirmDelete(false);
    setConfirmMerge(false);
    setConfirmRestore(false);
  };
  const selectView = (next: ActivityView) => {
    if (view === next) return;
    setView(next);
    cancelSelection();
  };
  // When start/end change (day rollover or preset), query page 0 and clear selection before paint.
  const agendaSpanChanged = observedAgendaSpanKey !== agendaSpanKey;
  if (agendaSpanChanged) {
    setObservedAgendaSpanKey(agendaSpanKey);
    setActivityPage(0);
    cancelSelection();
  }
  const resolvedActivityPage = agendaSpanChanged ? 0 : activityPage;
  const lastSportTypes = useRef<string[]>([]);
  const queryInput = useMemo(
    () => ({
      weeks: agendaRange.weeks,
      startDate: agendaRange.startDate,
      endDate: agendaRange.endDate,
      dateOrder,
      ...(selectedActivityType ? { activityType: selectedActivityType } : {}),
      ...(showHidden ? { includeProviderAbsent: true } : {}),
    }),
    [agendaRange, dateOrder, selectedActivityType, showHidden],
  );
  const trpcUtils = trpc.useUtils();
  const titleSearchQuery = trpc.calendar.searchActivities.useInfiniteQuery(
    { title: searchTitle ?? "", activityType: selectedActivityType, pageSize: ACTIVITY_PAGE_SIZE },
    {
      enabled: !futureOnly && searchTitle !== undefined,
      getNextPageParam: (page) => page.next ?? undefined,
      gcTime: 0,
      meta: { persist: false },
    },
  );
  const locationSearchQuery = trpc.activityLocation.search.useInfiniteQuery(
    {
      location: searchLocation ?? { kind: "name", name: "" },
      activityType: selectedActivityType,
      pageSize: ACTIVITY_PAGE_SIZE,
    },
    {
      enabled: !futureOnly && searchLocation !== undefined,
      getNextPageParam: (page) => page.next ?? undefined,
      refetchInterval: (query) =>
        query.state.data?.pages.some((page) =>
          page.activities.some((activity) => activity.location?.kind === "processing"),
        )
          ? processingPollInterval("active")
          : false,
      gcTime: 0,
      meta: { persist: false },
    },
  );
  const searchQuery = searchLocation ? locationSearchQuery : titleSearchQuery;
  const pageInput = useMemo(
    () => ({ ...queryInput, page: resolvedActivityPage, pageSize: ACTIVITY_PAGE_SIZE }),
    [queryInput, resolvedActivityPage],
  );
  const rangeKey = JSON.stringify(queryInput);
  const lastSuccessfulInput = useRef<{ rangeKey: string; input: typeof pageInput } | undefined>(
    undefined,
  );
  const query = trpc.calendar.weekListV2.useQuery(pageInput, {
    enabled: !searching && !futureOnly,
    placeholderData: (previousData) => previousData,
    refetchInterval: (query) =>
      query.state.data?.days.some((day) =>
        day.activities.some((activity) => activity.location?.kind === "processing"),
      )
        ? processingPollInterval("active")
        : false,
  });
  const overviewQuery = trpc.calendar.activityOverview.useQuery(
    {
      weeks: agendaRange.weeks,
      endDate: agendaRange.endDate,
      ...(selectedActivityType ? { activityType: selectedActivityType } : {}),
      ...(showHidden ? { includeProviderAbsent: true } : {}),
    },
    {
      enabled: showOverview && !searching,
      placeholderData: (previousData) => previousData,
    },
  );
  useEffect(() => {
    if (overviewQuery.data?.activityTypes) {
      lastSportTypes.current = overviewQuery.data.activityTypes;
    }
  }, [overviewQuery.data?.activityTypes]);
  useEffect(() => {
    if (query.data && !query.isPlaceholderData && !query.isError) {
      lastSuccessfulInput.current = { rangeKey, input: pageInput };
    }
  }, [query.data, query.isPlaceholderData, query.isError, rangeKey, pageInput]);
  const previousInput = lastSuccessfulInput.current;
  // Ignore cross-range placeholder cards; keep same-range soft pagination/refetch.
  const pageData =
    query.data && (!query.isPlaceholderData || previousInput?.rangeKey === rangeKey)
      ? query.data
      : previousInput?.rangeKey === rangeKey
        ? trpcUtils.calendar.weekListV2.getData(previousInput.input)
        : undefined;
  const upcomingQuery = trpc.calendar.upcomingWorkouts.useQuery(
    { dateRange: upcomingRange },
    { enabled: futureOnly },
  );
  const processingStatus = useProcessingStatus({ datasets: ["activity"] });
  const previousProcessingStatus = useRef(processingStatus.data?.overallStatus);
  useEffect(() => {
    const status = processingStatus.data?.overallStatus;
    const previous = previousProcessingStatus.current;
    previousProcessingStatus.current = status;
    if (previous !== undefined && previous !== "ready" && status === "ready") {
      void trpcUtils.calendar.upcomingWorkouts.invalidate();
    }
  }, [processingStatus.data?.overallStatus, trpcUtils]);
  const bulkDelete = trpc.activity.bulkDelete.useMutation({
    onSuccess: async () => {
      await Promise.all([
        trpcUtils.calendar.weekListV2.invalidate(),
        trpcUtils.calendar.searchActivities.invalidate(),
        trpcUtils.activityLocation.search.invalidate(),
        trpcUtils.calendar.activityOverview.invalidate(),
        trpcUtils.calendar.upcomingWorkouts.invalidate(),
        trpcUtils.activity.list.invalidate(),
      ]);
      setSelectedActivities(new Map());
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
  const mergeActivities = trpc.activity.merge.useMutation({
    onSuccess: async () => {
      await Promise.all([
        trpcUtils.calendar.weekListV2.invalidate(),
        trpcUtils.calendar.searchActivities.invalidate(),
        trpcUtils.activityLocation.search.invalidate(),
        trpcUtils.calendar.activityOverview.invalidate(),
        trpcUtils.calendar.calendarData.invalidate(),
        trpcUtils.calendar.upcomingWorkouts.invalidate(),
        trpcUtils.activity.list.invalidate(),
      ]);
      setSelectedActivities(new Map());
      setSelectMode(false);
      setConfirmMerge(false);
    },
  });
  const restoreProviderAbsent = trpc.activity.restoreProviderAbsent.useMutation({
    onSuccess: async () => {
      await Promise.all([
        trpcUtils.calendar.weekListV2.invalidate(),
        trpcUtils.calendar.searchActivities.invalidate(),
        trpcUtils.activityLocation.search.invalidate(),
        trpcUtils.calendar.activityOverview.invalidate(),
        trpcUtils.calendar.upcomingWorkouts.invalidate(),
        trpcUtils.activity.list.invalidate(),
      ]);
      setSelectedActivities(new Map());
      setSelectMode(false);
      setConfirmRestore(false);
    },
  });

  const completedDays = useMemo(() => {
    const days = searching
      ? searchQuery.data?.pages.flatMap(({ activities }) =>
          activities.map(({ date, ...activity }) => ({ date, activities: [activity] })),
        )
      : pageData?.days;
    return days?.map((day) => ({
      ...day,
      activities: day.activities.filter((activity) => !deletedActivityIds.has(activity.id)),
    }));
  }, [pageData, deletedActivityIds, searching, searchQuery.data]);
  const listQuery = searching ? searchQuery : query;
  const hasListData = searching ? !!searchQuery.data : !!pageData;
  const upcomingAgenda = useMemo(
    () => filterUpcomingActivityAgenda(upcomingQuery.data, upcomingSport),
    [upcomingQuery.data, upcomingSport],
  );
  const agendaDays = futureOnly
    ? upcomingAgenda.days.map((day) => ({ ...day, activities: [] }))
    : (completedDays ?? [])
        .filter((day) => day.activities.length > 0)
        .map((day) => ({ ...day, workouts: [] }));
  const hiddenActivityIds = new Set(
    [...selectedActivities].filter(([, activity]) => activity.isProviderAbsent).map(([id]) => id),
  );
  const hasActivities = agendaDays.some((day) => day.activities.length > 0);
  const sportTypes = overviewQuery.data?.activityTypes ?? lastSportTypes.current;
  const activeQuery = futureOnly ? upcomingQuery : listQuery;
  const showAgendaLoading = agendaDays.length === 0 && activeQuery.isLoading;
  const showRangeEmpty =
    agendaDays.length === 0 &&
    activeQuery.isSuccess &&
    !activeQuery.isFetching &&
    (futureOnly || pageData?.totalCount === 0);
  const visibleQueries = [
    ...(!searching && showOverview ? [overviewQuery] : []),
    activeQuery,
    processingStatus,
  ];
  const connectionFailures = visibleQueries.filter(
    (query) => query.error != null && isConnectionFailure(query.error),
  );
  const sharedConnectionFailure = connectionFailures.length > 1;
  const isSharedConnectionFailure = (error: unknown) =>
    sharedConnectionFailure && isConnectionFailure(error);
  const retryConnectionFailures = () => {
    for (const query of connectionFailures) void query.refetch?.();
  };
  const retryingConnectionFailures = connectionFailures.some((query) => query.isFetching === true);
  const activityCount = pageData?.totalCount ?? 0;
  const currentActivityPage = pageData?.page ?? resolvedActivityPage;
  const { startDate, endDate } = futureOnly ? upcomingRange : agendaRange;
  const rangeCaption = formatActivityAgendaCaption(startDate, endDate);
  useEffect(() => {
    if (query.data && !query.isPlaceholderData) setActivityPage(query.data.page);
  }, [query.data, query.isPlaceholderData]);
  const selectedCount = selectedActivityIds.size;
  const selectedHiddenCount = [...selectedActivityIds].filter((id) =>
    hiddenActivityIds.has(id),
  ).length;
  const selectedVisibleCount = selectedCount - selectedHiddenCount;
  const selectedTypes = new Set(
    [...selectedActivities.values()]
      .filter((activity) => !activity.isProviderAbsent)
      .map((activity) => activity.activityType),
  );
  const mergeEligible =
    selectedVisibleCount >= 2 && selectedTypes.size === 1 && selectedCount === selectedVisibleCount;

  const toggleSelectedActivity = (activity: ActivityCardData) => {
    setSelectedActivities((current) => {
      const next = new Map(current);
      if (next.has(activity.id)) {
        next.delete(activity.id);
      } else {
        next.set(activity.id, {
          activityType: activity.activityType,
          isProviderAbsent: activity.isProviderAbsent,
        });
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

  const updatePreset = (nextPreset: ActivityAgendaPreset) => {
    setPreset(nextPreset);
    setActivityPage(0);
    cancelSelection();
  };

  const updateShowHidden = (nextShowHidden: boolean) => {
    setShowHidden(nextShowHidden);
    setActivityPage(0);
    cancelSelection();
  };

  return (
    <PageLayout title="Activities">
      <ProcessingStatusWidget
        data={processingStatus.data}
        error={
          isSharedConnectionFailure(processingStatus.error) ? undefined : processingStatus.error
        }
        loading={processingStatus.isLoading}
      />
      <div
        role="tablist"
        aria-label="Activity views"
        className="grid w-full max-w-xs grid-cols-2 gap-1 rounded-lg border border-border bg-surface p-1"
      >
        {ACTIVITY_VIEWS.map(({ id, title }) => (
          <button
            key={id}
            id={`${tabsId}-${id}`}
            type="button"
            role="tab"
            aria-selected={view === id}
            aria-controls={`${tabsId}-${id}-panel`}
            tabIndex={view === id ? 0 : -1}
            onClick={() => selectView(id)}
            onKeyDown={(event) => {
              let next: ActivityView;
              switch (event.key) {
                case "Home":
                  next = "completed";
                  break;
                case "End":
                  next = "upcoming";
                  break;
                case "ArrowLeft":
                case "ArrowRight":
                  next = id === "completed" ? "upcoming" : "completed";
                  break;
                default:
                  return;
              }
              event.preventDefault();
              selectView(next);
              document.getElementById(`${tabsId}-${next}`)?.focus();
            }}
            className={`min-h-11 cursor-pointer rounded-md px-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${view === id ? "bg-accent/15 text-accent" : "text-muted hover:bg-surface-hover"}`}
          >
            {title}
          </button>
        ))}
      </div>
      {ACTIVITY_VIEWS.map(({ id }) => (
        <div
          key={id}
          id={`${tabsId}-${id}-panel`}
          role="tabpanel"
          aria-labelledby={`${tabsId}-${id}`}
          tabIndex={id === "upcoming" ? 0 : undefined}
          hidden={view !== id}
          className="space-y-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {id === "completed" ? (
            <ActivitySearchControls
              active={view === id}
              selection={searchSelection}
              onSearch={(selection) => {
                setSearchSelection(selection);
                cancelSelection();
              }}
            />
          ) : null}
          {view === id ? (
            <>
              <div className="space-y-4">
                {!futureOnly ? (
                  <ActivityControls
                    activityTypes={sportTypes}
                    activityType={activityType}
                    preset={preset}
                    showHidden={showHidden && !searching}
                    searching={searching}
                    canSelect={hasActivities}
                    selectMode={selectMode}
                    confirmDelete={confirmDelete}
                    confirmMerge={confirmMerge}
                    confirmRestore={confirmRestore}
                    selectedCount={selectedCount}
                    selectedHiddenCount={selectedHiddenCount}
                    selectedVisibleCount={selectedVisibleCount}
                    mergeEligible={mergeEligible}
                    mergePending={mergeActivities.isPending}
                    mixedTypes={selectedTypes.size > 1}
                    deletePending={bulkDelete.isPending}
                    restorePending={restoreProviderAbsent.isPending}
                    onActivityTypeChange={updateActivityType}
                    onPresetChange={updatePreset}
                    onShowHiddenChange={updateShowHidden}
                    onSelect={() => setSelectMode(true)}
                    onCancelSelection={cancelSelection}
                    onDeleteSelected={() => setConfirmDelete(true)}
                    onMergeSelected={() => setConfirmMerge(true)}
                    onRestoreSelected={() => setConfirmRestore(true)}
                    onConfirmDelete={handleConfirmDelete}
                    onConfirmMerge={() => mergeActivities.mutate({ ids: [...selectedActivityIds] })}
                    onConfirmRestore={handleConfirmRestore}
                  />
                ) : upcomingAgenda.sports.length > 0 ? (
                  <label className="flex w-fit items-center gap-2 text-xs text-muted">
                    Activity type
                    <select
                      className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-foreground"
                      value={upcomingSport ?? ""}
                      onChange={(event) => setUpcomingSport(event.target.value || undefined)}
                    >
                      <option value="">All activities</option>
                      {upcomingAgenda.sports.map((type) => (
                        <option key={type} value={type}>
                          {formatActivityTypeLabel(type)}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {!futureOnly && bulkDelete.error ? (
                  <QueryStatePanel error={bulkDelete.error} height={80} />
                ) : null}
                {!futureOnly && mergeActivities.error ? (
                  <QueryStatePanel error={mergeActivities.error} height={80} />
                ) : null}
                {!futureOnly && restoreProviderAbsent.error ? (
                  <QueryStatePanel error={restoreProviderAbsent.error} height={80} />
                ) : null}
                {searching || !showOverview ? null : overviewQuery.isLoading &&
                  !overviewQuery.data ? (
                  <QueryStatePanel variant="loading" height={120} />
                ) : overviewQuery.isError && !overviewQuery.data ? (
                  isSharedConnectionFailure(overviewQuery.error) ? null : (
                    <QueryStatePanel error={overviewQuery.error} height={120} />
                  )
                ) : (
                  <>
                    {overviewQuery.isError && !isSharedConnectionFailure(overviewQuery.error) ? (
                      <QueryStatePanel error={overviewQuery.error} height={72} />
                    ) : null}
                    <ActivityOverview overview={overviewQuery.data} units={units} />
                  </>
                )}
              </div>
              {sharedConnectionFailure ? (
                <QueryStatePanel
                  error={connectionFailures[0]?.error}
                  height={72}
                  onRetry={retryConnectionFailures}
                  retrying={retryingConnectionFailures}
                />
              ) : null}
              {searching ? (
                listQuery.isLoading && !hasListData ? (
                  <QueryStatePanel variant="loading" height={400} />
                ) : listQuery.isError &&
                  !isSharedConnectionFailure(listQuery.error) &&
                  (!hasListData || !hasActivities) ? (
                  <QueryStatePanel
                    error={listQuery.error}
                    height={200}
                    onRetry={() => void listQuery.refetch()}
                    retrying={listQuery.isFetching}
                  />
                ) : !hasActivities &&
                  !searchQuery.hasNextPage &&
                  !isSharedConnectionFailure(listQuery.error) ? (
                  <QueryStatePanel variant="empty" message="No matching activities." height={200} />
                ) : (
                  <div className="space-y-7">
                    {listQuery.isError && !isSharedConnectionFailure(listQuery.error) ? (
                      <QueryStatePanel
                        error={listQuery.error}
                        height={72}
                        onRetry={() => void listQuery.refetch()}
                        retrying={listQuery.isFetching}
                      />
                    ) : null}
                    {agendaDays.map((day) => (
                      <section key={day.activities[0]?.id ?? day.date}>
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
                              onToggleSelected={() => toggleSelectedActivity(activity)}
                            />
                          ))}
                        </div>
                      </section>
                    ))}
                    {searchQuery.hasNextPage ? (
                      <button
                        type="button"
                        disabled={searchQuery.isFetching}
                        className="rounded-md border border-border px-3 py-2 text-sm"
                        onClick={() => void searchQuery.fetchNextPage()}
                      >
                        {searchQuery.isFetchingNextPage ? "Loading…" : "Load more"}
                      </button>
                    ) : null}
                  </div>
                )
              ) : (
                <section aria-labelledby="workout-calendar-heading" className="space-y-4">
                  <header className="space-y-1">
                    <h2
                      id="workout-calendar-heading"
                      className="text-sm font-semibold text-foreground tracking-wide"
                    >
                      Workout calendar
                    </h2>
                    <p className="text-xs text-muted">{rangeCaption}</p>
                  </header>
                  <div className="space-y-7">
                    {!futureOnly &&
                    listQuery.isError &&
                    !isSharedConnectionFailure(listQuery.error) ? (
                      <QueryStatePanel
                        error={listQuery.error}
                        height={72}
                        onRetry={() => void listQuery.refetch()}
                        retrying={listQuery.isFetching}
                      />
                    ) : null}
                    {futureOnly &&
                    upcomingQuery.isError &&
                    !isSharedConnectionFailure(upcomingQuery.error) ? (
                      <QueryStatePanel
                        contextLabel="Planned workouts"
                        error={upcomingQuery.error}
                        height={72}
                        onRetry={() => void upcomingQuery.refetch()}
                        retrying={upcomingQuery.isFetching}
                      />
                    ) : null}
                    {showAgendaLoading ? (
                      <QueryStatePanel variant="loading" height={400} />
                    ) : showRangeEmpty ? (
                      <QueryStatePanel
                        variant="empty"
                        message="No workouts in this date range."
                        height={200}
                      />
                    ) : (
                      agendaDays.map((day) => (
                        <section key={day.date}>
                          <div className="mb-2 flex items-center gap-3">
                            <h3 className="text-xs font-semibold text-muted uppercase tracking-wider">
                              {formatDayHeader(day.date)}
                            </h3>
                            <div className="h-px flex-1 bg-border/60" />
                          </div>
                          <div
                            data-testid="activity-card-grid"
                            className="grid gap-3 lg:grid-cols-2"
                          >
                            {day.workouts.map((workout) => (
                              <PlannedWorkoutCard
                                key={`${workout.providerId}:${workout.id}`}
                                workout={workout}
                              />
                            ))}
                            {day.activities.map((activity) => (
                              <ActivityCard
                                key={activity.id}
                                activity={activity}
                                units={units}
                                selectMode={selectMode}
                                selected={selectedActivityIds.has(activity.id)}
                                onToggleSelected={() => toggleSelectedActivity(activity)}
                              />
                            ))}
                          </div>
                        </section>
                      ))
                    )}
                    {!futureOnly ? (
                      <PaginationControls
                        page={currentActivityPage}
                        pageSize={ACTIVITY_PAGE_SIZE}
                        totalItems={activityCount}
                        itemLabel="activities"
                        onPageChange={setActivityPage}
                      />
                    ) : null}
                  </div>
                </section>
              )}
            </>
          ) : null}
        </div>
      ))}
    </PageLayout>
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
  const cardRef = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const photoEnabled = !activity.location && !isHidden && visible;
  const photos = trpc.activity.images.useQuery(
    { id: activity.id },
    { ...ACTIVITY_IMAGES_QUERY_OPTIONS, enabled: photoEnabled },
  );
  useEffect(() => {
    if (activity.location || isHidden || !cardRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: "200px" },
    );
    observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, [activity.location, isHidden]);
  const cardClassName = [
    "card relative block h-full overflow-hidden transition-colors",
    selectMode ? "cursor-pointer hover:bg-surface-elevated" : "hover:bg-surface-elevated",
    selected ? "ring-2 ring-accent bg-surface-hover" : "",
    isHidden ? "border-l-4 border-l-amber-500/80 bg-amber-500/5" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const activityLabel =
    activity.name ?? formatActivityTypeLabel(activity.primaryActivityType ?? activity.activityType);
  const actionClassName =
    "text-left after:absolute after:inset-0 after:z-10 focus-visible:outline-none focus-visible:after:rounded-lg focus-visible:after:outline-2 focus-visible:after:outline-accent";
  const headingAction = selectMode ? (
    <button
      type="button"
      onClick={onToggleSelected}
      aria-pressed={selected}
      className={actionClassName}
    >
      {activityLabel}
    </button>
  ) : (
    <Link to="/activity/$id" params={{ id: activity.id }} className={actionClassName}>
      {activityLabel}
    </Link>
  );

  return (
    <article ref={cardRef} className={cardClassName}>
      <ActivityCardContent
        activity={activity}
        units={units}
        selectMode={selectMode}
        selected={selected}
        headingAction={headingAction}
        onToggleSelected={onToggleSelected}
        photo={photos.data?.images[0]}
      />
      {!activity.location && !isHidden && photos.error ? (
        <p role="alert" className="px-4 pb-3 text-xs text-red-400">
          {userFacingErrorMessage(photos.error)}
        </p>
      ) : null}
    </article>
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
  const formatComparisonMagnitude = createActivityOverviewComparisonFormatters(units);

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {items.map((item) => {
        const isMetric = "status" in item;
        const comparison = overview?.comparison
          ? activityOverviewChangeForKey(overview.comparison, item.key)
          : undefined;
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
