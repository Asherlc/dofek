import {
  type ActivityAgendaPreset,
  activityAgendaRange,
  filterUpcomingActivityAgenda,
  formatActivityAgendaCaption,
  upcomingActivityAgendaRange,
} from "@dofek/format/activity-agenda";
import {
  formatDateForDisplay,
  formatDurationMinutes,
  isToday,
  isYesterday,
  parseValidDate,
} from "@dofek/format/format";
import { isConnectionFailure, userFacingErrorMessage } from "@dofek/format/user-facing-error";
import { processingPollInterval } from "@dofek/providers/processing-status";
import { formatActivityTypeLabel } from "@dofek/training/training";
import { Link, useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { ActivityControls } from "../../components/ActivityControls";
import { ActivityHeatmap } from "../../components/ActivityHeatmap";
import { ActivityOverview } from "../../components/ActivityOverview";
import { styles } from "../../components/activities.styles";
import { CompletedActivityCard } from "../../components/CompletedActivityCard";
import { PaginationControls } from "../../components/PaginationControls";
import { PlannedWorkoutCard } from "../../components/PlannedWorkoutCard";
import { ProcessingStatusWidget } from "../../components/ProcessingStatusWidget";
import { QueryStatePanel } from "../../components/QueryStatePanel";
import { ScreenSections } from "../../components/ScreenSections";
import { trpc } from "../../lib/trpc";
import { useUnitConverter } from "../../lib/units";
import { useProcessingStatus } from "../../lib/useProcessingStatus";
import { useRefresh } from "../../lib/useRefresh";
import { useTodayQueryDate } from "../../lib/useTodayQueryDate";
import { colors } from "../../theme";

const ACTIVITY_PAGE_SIZE = 20;
const ALL_ACTIVITY_TYPES = "all";
const DEFAULT_PRESET: ActivityAgendaPreset = "this-week";
const ACTIVITY_VIEWS = [
  { id: "completed", title: "Completed" },
  { id: "upcoming", title: "Upcoming" },
] as const;
type ActivityView = (typeof ACTIVITY_VIEWS)[number]["id"];

type ActivitySearchSelection =
  | { kind: "title" | "name"; name: string }
  | { kind: "nearby"; latitude: number; longitude: number; label: string };

export default function ActivitiesScreen() {
  const router = useRouter();
  const units = useUnitConverter();
  const today = useTodayQueryDate();
  const [view, setView] = useState<ActivityView>("completed");
  const [upcomingSport, setUpcomingSport] = useState<string>();
  const [preset, setPreset] = useState<ActivityAgendaPreset>(DEFAULT_PRESET);
  const [activityType, setActivityType] = useState(ALL_ACTIVITY_TYPES);
  const [trainingTimeExpanded, setTrainingTimeExpanded] = useState(false);
  const [searchMode, setSearchMode] = useState<"title" | "location">("title");
  const [searchDraft, setSearchDraft] = useState("");
  const [searchSelection, setSearchSelection] = useState<ActivitySearchSelection>();
  const [placeLookup, setPlaceLookup] = useState<string>();
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
  const searchName = searchDraft.trim();
  const searchLabel =
    searchMode === "location" ? "Search activity locations" : "Search activity titles";
  const [selectMode, setSelectMode] = useState(false);
  const [selectedActivities, setSelectedActivities] = useState<Map<string, string>>(new Map());
  const selectedActivityIds = new Set(selectedActivities.keys());
  const [activityPage, setActivityPage] = useState(0);
  const selectedActivityType = activityType === ALL_ACTIVITY_TYPES ? undefined : activityType;
  const agendaRange = useMemo(() => activityAgendaRange(preset, today), [preset, today]);
  const dateOrder = "newest" as const;
  const futureOnly = view === "upcoming";
  const showOverview = agendaRange.weeks != null && !futureOnly;
  const upcomingRange = useMemo(() => upcomingActivityAgendaRange(today), [today]);
  const agendaSpanKey = `${agendaRange.startDate}:${agendaRange.endDate}`;
  const [observedAgendaSpanKey, setObservedAgendaSpanKey] = useState(agendaSpanKey);
  const cancelSelection = () => {
    setSelectedActivities(new Map());
    setSelectMode(false);
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
      weeks: agendaRange.weeks ?? 4,
      startDate: agendaRange.startDate,
      endDate: agendaRange.endDate,
      dateOrder,
      ...(selectedActivityType ? { activityType: selectedActivityType } : {}),
    }),
    [agendaRange, dateOrder, selectedActivityType],
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
  const places = trpc.activityLocation.places.useQuery(
    { query: placeLookup ?? "" },
    {
      enabled: !futureOnly && placeLookup !== undefined,
      staleTime: Number.POSITIVE_INFINITY,
      retry: false,
      gcTime: 0,
      meta: { persist: false },
    },
  );
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
      weeks: agendaRange.weeks ?? 4,
      endDate: agendaRange.endDate,
      ...(selectedActivityType ? { activityType: selectedActivityType } : {}),
    },
    {
      enabled: showOverview && !searching,
      placeholderData: (previousData) => previousData,
    },
  );
  const trainingTotals = overviewQuery.isPlaceholderData ? undefined : overviewQuery.data;
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
  const calendarQuery = trpc.calendar.calendarData.useQuery(
    { days: (agendaRange.weeks ?? 1) * 7 },
    {
      enabled: showOverview && !searching,
      placeholderData: (previousData) =>
        previousData && previousData.length > 0 ? previousData : undefined,
    },
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
      await trpcUtils.calendar.weekListV2.invalidate();
      await trpcUtils.calendar.searchActivities.invalidate();
      await trpcUtils.activityLocation.search.invalidate();
      await trpcUtils.calendar.activityOverview.invalidate();
      await trpcUtils.calendar.calendarData.invalidate();
      await trpcUtils.activity.list.invalidate();
      await trpcUtils.calendar.upcomingWorkouts.invalidate();
      await trpcUtils.trainingProgression.strength.reset();
      await trpcUtils.trainingProgression.cycling.reset();
      setSelectedActivities(new Map());
      setSelectMode(false);
    },
  });
  const mergeActivities = trpc.activity.merge.useMutation({
    onSuccess: async () => {
      await trpcUtils.calendar.weekListV2.invalidate();
      await trpcUtils.calendar.searchActivities.invalidate();
      await trpcUtils.activityLocation.search.invalidate();
      await trpcUtils.calendar.activityOverview.invalidate();
      await trpcUtils.calendar.calendarData.invalidate();
      await trpcUtils.activity.list.invalidate();
      await trpcUtils.calendar.upcomingWorkouts.invalidate();
      await trpcUtils.trainingProgression.strength.reset();
      await trpcUtils.trainingProgression.cycling.reset();
      setSelectedActivities(new Map());
      setSelectMode(false);
    },
    onError: (error) => Alert.alert("Unable to merge activities", error.message),
  });
  const { refreshing, onRefresh } = useRefresh({
    invalidate: () =>
      Promise.all([
        trpcUtils.calendar.weekListV2.invalidate(),
        trpcUtils.calendar.searchActivities.invalidate(),
        trpcUtils.activityLocation.search.invalidate(),
        trpcUtils.calendar.activityOverview.invalidate(),
        trpcUtils.calendar.calendarData.invalidate(),
        trpcUtils.calendar.upcomingWorkouts.invalidate(),
        trpcUtils.activity.list.invalidate(),
        trpcUtils.processing.status.invalidate(),
      ]).then(() => undefined),
  });

  const completedDays = searching
    ? searchQuery.data?.pages.flatMap(({ activities }) =>
        activities.map(({ date, ...activity }) => ({ date, activities: [activity] })),
      )
    : pageData?.days;
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
  const hasActivities = agendaDays.some((day) => day.activities.length > 0);
  const sportTypes = overviewQuery.data?.activityTypes ?? lastSportTypes.current;
  const { startDate, endDate } = futureOnly ? upcomingRange : agendaRange;
  const rangeCaption = formatActivityAgendaCaption(startDate, endDate);
  const activeQuery = futureOnly ? upcomingQuery : listQuery;
  const showAgendaLoading = agendaDays.length === 0 && activeQuery.isLoading;
  const showRangeEmpty =
    agendaDays.length === 0 &&
    activeQuery.isSuccess &&
    !activeQuery.isFetching &&
    (futureOnly || pageData?.totalCount === 0);
  // Only count failures the person can actually see: overview and calendar are
  // hidden while searching or browsing Upcoming, and the calendar is
  // hidden while collapsed.
  const visibleQueries = [
    ...(!searching && showOverview ? [overviewQuery] : []),
    ...(!searching && showOverview && trainingTimeExpanded ? [calendarQuery] : []),
    activeQuery,
    processingStatus,
    ...(!futureOnly && placeLookup ? [places] : []),
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
  useEffect(() => {
    if (query.data && !query.isPlaceholderData) setActivityPage(query.data.page);
  }, [query.data, query.isPlaceholderData]);
  const selectedCount = selectedActivityIds.size;
  const selectedTypes = new Set(selectedActivities.values());
  const mergeEligible = selectedCount >= 2 && selectedTypes.size === 1;
  const toggleSelectedActivity = (activityId: string, activityType: string) => {
    setSelectedActivities((current) => {
      const next = new Map(current);
      if (next.has(activityId)) {
        next.delete(activityId);
      } else {
        next.set(activityId, activityType);
      }
      return next;
    });
  };
  const submitSearch = () => {
    setPlaceLookup(undefined);
    setSearchSelection(
      searchName
        ? { kind: searchMode === "location" ? "name" : "title", name: searchName }
        : undefined,
    );
    cancelSelection();
  };

  const clearSearch = () => {
    setSearchDraft("");
    setSearchSelection(undefined);
    setPlaceLookup(undefined);
    cancelSelection();
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
  const confirmBulkDelete = () => {
    if (selectedCount === 0) return;
    Alert.alert(
      "Delete Activities",
      `Delete ${selectedCount} selected ${selectedCount === 1 ? "activity" : "activities"}? This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            bulkDelete.mutate({ ids: [...selectedActivityIds] });
          },
        },
      ],
    );
  };
  const confirmMerge = () => {
    if (!mergeEligible) return;
    Alert.alert(
      "Merge Activities",
      "Combine the selected activities into one activity spanning their times? Original provider records remain.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Merge", onPress: () => mergeActivities.mutate({ ids: [...selectedActivityIds] }) },
      ],
    );
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.textSecondary}
        />
      }
    >
      <ProcessingStatusWidget
        data={processingStatus.data}
        error={
          isSharedConnectionFailure(processingStatus.error) ? undefined : processingStatus.error
        }
        loading={processingStatus.isLoading}
      />

      {sharedConnectionFailure ? (
        <QueryStatePanel
          variant="error"
          message={userFacingErrorMessage(connectionFailures[0]?.error)}
          minHeight={72}
          onRetry={retryConnectionFailures}
          retrying={retryingConnectionFailures}
        />
      ) : null}

      <ScreenSections
        label="Activity views"
        sections={ACTIVITY_VIEWS}
        selected={view}
        onSelect={(next) => {
          if (next === view) return;
          setView(next);
          cancelSelection();
        }}
      />
      {!futureOnly ? (
        <>
          <View style={styles.searchRow}>
            {(["title", "location"] as const).map((mode) => (
              <TouchableOpacity
                key={mode}
                style={styles.filterChip}
                accessibilityRole="button"
                accessibilityState={{ selected: mode === searchMode }}
                onPress={() => {
                  if (mode === searchMode) return;
                  setSearchMode(mode);
                  clearSearch();
                }}
              >
                <Text style={[styles.filterChipText, mode === searchMode && styles.filterCurrent]}>
                  {mode === "title" ? "Title" : "Location"}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={styles.searchRow}>
            <TextInput
              accessibilityLabel={searchLabel}
              placeholder={searchLabel}
              placeholderTextColor={colors.textSecondary}
              value={searchDraft}
              maxLength={200}
              onChangeText={(value) => {
                setSearchDraft(value);
                setPlaceLookup(undefined);
              }}
              onSubmitEditing={submitSearch}
              returnKeyType="search"
              style={styles.searchInput}
            />
            <TouchableOpacity
              style={styles.selectButton}
              accessibilityRole="button"
              onPress={submitSearch}
            >
              <Text style={styles.selectButtonText}>Search</Text>
            </TouchableOpacity>
            {searchMode === "location" ? (
              <TouchableOpacity
                style={styles.selectButton}
                accessibilityRole="button"
                accessibilityState={{ disabled: !searchName }}
                disabled={!searchName}
                onPress={() => {
                  setSearchSelection({ kind: "name", name: searchName });
                  setPlaceLookup(searchName);
                  cancelSelection();
                }}
              >
                <Text style={styles.selectButtonText}>Look up a place</Text>
              </TouchableOpacity>
            ) : null}
            {searching ? (
              <TouchableOpacity
                style={styles.selectButton}
                accessibilityRole="button"
                onPress={clearSearch}
              >
                <Text style={styles.selectButtonText}>Clear search</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          {placeLookup && places.isFetching && !places.data ? (
            <QueryStatePanel variant="loading" minHeight={44} />
          ) : placeLookup && places.isError && !isSharedConnectionFailure(places.error) ? (
            <QueryStatePanel
              variant="error"
              message={places.error?.message}
              minHeight={60}
              retryLabel="Retry place lookup"
              onRetry={() => void places.refetch()}
            />
          ) : placeLookup && places.data?.length === 0 ? (
            <Text style={styles.selectionGuidance} accessibilityLiveRegion="polite">
              No places found.
            </Text>
          ) : placeLookup && places.data ? (
            <View style={styles.controlsPanel}>
              <Text style={styles.selectionGuidance}>
                Choose a place to find nearby GPS activities.
              </Text>
              {places.data.map(({ id, label, latitude, longitude }) => (
                <TouchableOpacity
                  key={id}
                  style={styles.selectButton}
                  accessibilityRole="button"
                  onPress={() => {
                    setPlaceLookup(undefined);
                    setSearchSelection({ kind: "nearby", latitude, longitude, label });
                    cancelSelection();
                  }}
                >
                  <Text style={styles.selectButtonText}>{label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : null}
          {searchSelection?.kind === "nearby" ? (
            <Text style={styles.selectionGuidance} accessibilityLiveRegion="polite">
              Near {searchSelection.label}
            </Text>
          ) : null}
          {(placeLookup && !!places.data?.length) || searchSelection?.kind === "nearby" ? (
            <Text style={styles.selectionGuidance}>
              Place lookup by <Link href="https://www.geoapify.com/">Geoapify</Link>
              {" · "}
              <Link href="https://www.openstreetmap.org/copyright">
                © OpenStreetMap contributors
              </Link>
            </Text>
          ) : null}

          <ActivityControls
            activityTypes={sportTypes}
            activityType={activityType}
            preset={preset}
            searching={searching}
            canSelect={hasActivities}
            selectMode={selectMode}
            selectedCount={selectedCount}
            deletePending={bulkDelete.isPending}
            mergePending={mergeActivities.isPending}
            mergeEligible={mergeEligible}
            mixedTypes={selectedTypes.size > 1}
            onActivityTypeChange={updateActivityType}
            onPresetChange={updatePreset}
            onSelect={() => setSelectMode(true)}
            onCancelSelection={cancelSelection}
            onDeleteSelected={confirmBulkDelete}
            onMergeSelected={confirmMerge}
          />
        </>
      ) : upcomingAgenda.sports.length > 0 ? (
        <View style={styles.searchRow}>
          {[undefined, ...upcomingAgenda.sports].map((type) => (
            <TouchableOpacity
              key={type === undefined ? "all" : `sport:${type}`}
              accessibilityRole="button"
              accessibilityState={{ selected: upcomingSport === type }}
              onPress={() => setUpcomingSport(type)}
              style={styles.filterChip}
            >
              <Text style={[styles.filterChipText, upcomingSport === type && styles.filterCurrent]}>
                {type === undefined ? "All activities" : formatActivityTypeLabel(type)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}
      {!futureOnly && bulkDelete.error ? (
        <QueryStatePanel variant="error" message={userFacingErrorMessage(bulkDelete.error)} />
      ) : null}

      {!searching && showOverview ? (
        <>
          <View style={styles.trainingSummary}>
            <TouchableOpacity
              accessibilityRole="button"
              aria-expanded={trainingTimeExpanded}
              accessibilityState={{ expanded: trainingTimeExpanded }}
              onPress={() => setTrainingTimeExpanded((expanded) => !expanded)}
              style={styles.summaryButton}
            >
              <Text style={styles.summaryTitle}>Training time</Text>
              {overviewQuery.isPlaceholderData ? (
                <Text style={styles.summaryMeta}>
                  {overviewQuery.isPaused ? "Waiting for a connection" : "Updating…"}
                </Text>
              ) : trainingTotals ? (
                <Text style={styles.summaryMeta}>
                  {trainingTotals.activityCount}{" "}
                  {trainingTotals.activityCount === 1 ? "activity" : "activities"} ·{" "}
                  {formatDurationMinutes(trainingTotals.totalMinutes)}
                </Text>
              ) : null}
              <Text style={styles.summaryMeta} aria-hidden>
                {trainingTimeExpanded ? "⌃" : "⌄"}
              </Text>
            </TouchableOpacity>
          </View>

          {overviewQuery.isLoading && !overviewQuery.data ? (
            <QueryStatePanel variant="loading" minHeight={60} />
          ) : overviewQuery.isError && !isSharedConnectionFailure(overviewQuery.error) ? (
            <QueryStatePanel
              variant="error"
              message={userFacingErrorMessage(overviewQuery.error)}
              minHeight={72}
            />
          ) : null}

          {trainingTimeExpanded ? (
            <>
              {trainingTotals ? <ActivityOverview overview={trainingTotals} units={units} /> : null}
              {calendarQuery.isLoading && !calendarQuery.data ? (
                <QueryStatePanel variant="loading" minHeight={180} />
              ) : null}
              {calendarQuery.isError && !isSharedConnectionFailure(calendarQuery.error) ? (
                <QueryStatePanel
                  variant="error"
                  message={userFacingErrorMessage(calendarQuery.error)}
                  minHeight={72}
                />
              ) : null}
              {calendarQuery.data || (!calendarQuery.isLoading && !calendarQuery.isError) ? (
                <ActivityHeatmap
                  data={(calendarQuery.data ?? []).filter(
                    (day) => day.date >= agendaRange.startDate && day.date <= agendaRange.endDate,
                  )}
                />
              ) : null}
            </>
          ) : null}
        </>
      ) : null}

      {searching ? (
        listQuery.isLoading && !hasListData ? (
          <QueryStatePanel variant="loading" minHeight={200} />
        ) : listQuery.isError &&
          !isSharedConnectionFailure(listQuery.error) &&
          (!hasListData || !hasActivities) ? (
          <QueryStatePanel
            variant="error"
            message={userFacingErrorMessage(listQuery.error)}
            onRetry={() => void listQuery.refetch()}
            retrying={listQuery.isFetching}
          />
        ) : !hasActivities &&
          !searchQuery.hasNextPage &&
          !isSharedConnectionFailure(listQuery.error) ? (
          <QueryStatePanel variant="empty" message="No matching activities." minHeight={120} />
        ) : (
          <>
            {listQuery.isError && !isSharedConnectionFailure(listQuery.error) ? (
              <QueryStatePanel
                variant="error"
                message={userFacingErrorMessage(listQuery.error)}
                minHeight={72}
                style={styles.backgroundErrorPanel}
                onRetry={() => void listQuery.refetch()}
                retrying={listQuery.isFetching}
              />
            ) : null}
            {agendaDays.map((day) => (
              <View key={day.activities[0]?.id ?? day.date} style={styles.daySection}>
                <View style={styles.dayHeaderRow}>
                  <Text style={styles.dayHeader}>{formatDayHeader(day.date)}</Text>
                  <View style={styles.dayHeaderRule} />
                </View>
                {day.activities.map((activity) => (
                  <CompletedActivityCard
                    key={activity.id}
                    activity={activity}
                    units={units}
                    selectMode={selectMode}
                    selected={selectedActivityIds.has(activity.id)}
                    onPress={() => {
                      if (selectMode) {
                        toggleSelectedActivity(activity.id, activity.activityType);
                        return;
                      }
                      router.push(`/activity/${activity.id}`);
                    }}
                  />
                ))}
              </View>
            ))}
            {searchQuery.hasNextPage ? (
              <TouchableOpacity
                style={styles.selectButton}
                accessibilityRole="button"
                disabled={searchQuery.isFetching}
                onPress={() => void searchQuery.fetchNextPage()}
              >
                <Text style={styles.selectButtonText}>
                  {searchQuery.isFetchingNextPage ? "Loading…" : "Load more"}
                </Text>
              </TouchableOpacity>
            ) : null}
          </>
        )
      ) : (
        <View style={styles.daySection}>
          <Text accessibilityRole="header" style={styles.dayHeader}>
            Workout calendar
          </Text>
          <Text style={styles.activityMeta}>{rangeCaption}</Text>
          {!futureOnly && listQuery.isError && !isSharedConnectionFailure(listQuery.error) ? (
            <QueryStatePanel
              variant="error"
              message={userFacingErrorMessage(listQuery.error)}
              minHeight={72}
              style={styles.backgroundErrorPanel}
              onRetry={() => void listQuery.refetch()}
              retrying={listQuery.isFetching}
            />
          ) : null}
          {futureOnly &&
          upcomingQuery.isError &&
          !isSharedConnectionFailure(upcomingQuery.error) ? (
            <QueryStatePanel
              variant="error"
              title="Planned workouts: Could not load this section"
              message={userFacingErrorMessage(upcomingQuery.error)}
              minHeight={72}
              onRetry={() => void upcomingQuery.refetch()}
              retrying={upcomingQuery.isFetching}
            />
          ) : null}
          {showAgendaLoading ? (
            <QueryStatePanel variant="loading" minHeight={200} />
          ) : showRangeEmpty ? (
            <QueryStatePanel
              variant="empty"
              message="No workouts in this date range."
              minHeight={120}
            />
          ) : (
            agendaDays.map((day) => (
              <View key={day.date} style={styles.daySection}>
                <View style={styles.dayHeaderRow}>
                  <Text style={styles.dayHeader}>{formatDayHeader(day.date)}</Text>
                  <View style={styles.dayHeaderRule} />
                </View>
                {day.workouts.map((workout) => (
                  <PlannedWorkoutCard
                    key={`${workout.providerId}:${workout.id}`}
                    workout={workout}
                  />
                ))}
                {day.activities.map((activity) => (
                  <CompletedActivityCard
                    key={activity.id}
                    activity={activity}
                    units={units}
                    selectMode={selectMode}
                    selected={selectedActivityIds.has(activity.id)}
                    onPress={() => {
                      if (selectMode) {
                        toggleSelectedActivity(activity.id, activity.activityType);
                        return;
                      }
                      router.push(`/activity/${activity.id}`);
                    }}
                  />
                ))}
              </View>
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
        </View>
      )}
    </ScrollView>
  );
}

function formatDayHeader(dateStr: string): string {
  const date = parseValidDate(`${dateStr}T00:00:00`);
  if (!date) return dateStr;
  if (isToday(date)) return "Today";
  if (isYesterday(date)) return "Yesterday";
  return formatDateForDisplay(date);
}
