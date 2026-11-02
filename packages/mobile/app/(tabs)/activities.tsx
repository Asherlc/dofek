import {
  type ActivityDataState,
  type ActivityMetric,
  activityDataStateLabel,
  formatActivityMetric,
} from "@dofek/format/activity-data-state";
import {
  formatDateForDisplay,
  formatDateYmd,
  formatDurationMinutes,
  isToday,
  isYesterday,
  parseValidDate,
} from "@dofek/format/format";
import {
  formatRecordLocalTime,
  type RecordLocalTimeContext,
} from "@dofek/format/record-local-time";
import { formatMeasurementText, type UnitConverter } from "@dofek/format/units";
import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import { processingPollInterval } from "@dofek/providers/processing-status";
import { providerSourceLabel } from "@dofek/providers/providers";
import type { ClimbingMapLocation } from "@dofek/training/climbing-map";
import { isIndoorCyclingModality } from "@dofek/training/endurance-types";
import { formatActivityTypeLabel } from "@dofek/training/training";
import type { ActivityLocation } from "dofek-server/types";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Alert,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { ActivityHeatmap } from "../../components/ActivityHeatmap";
import { ActivityMapTile } from "../../components/ActivityMapTile";
import { ActivityMetricStrip } from "../../components/ActivityMetricStrip";
import { ActivityOverview } from "../../components/ActivityOverview";
import { ActivityPhotoPreview } from "../../components/ActivityPhotoPreview";
import { ActivitySourceDisclosure } from "../../components/ActivitySourceDisclosure";
import { ActivityTypeIcon } from "../../components/ActivityTypeIcon";
import { PaginationControls } from "../../components/PaginationControls";
import { ProcessingStatusWidget } from "../../components/ProcessingStatusWidget";
import { QueryStatePanel } from "../../components/QueryStatePanel";
import { trpc } from "../../lib/trpc";
import { useUnitConverter } from "../../lib/units";
import { useProcessingStatus } from "../../lib/useProcessingStatus";
import { useRefresh } from "../../lib/useRefresh";
import { colors, radius, spacing } from "../../theme";

const DEFAULT_WEEKS = 4;
const ACTIVITY_PAGE_SIZE = 20;
const ALL_ACTIVITY_TYPES = "all";
const DATE_RANGE_OPTIONS = [
  { value: 4, label: "4 weeks" },
  { value: 8, label: "8 weeks" },
  { value: 12, label: "12 weeks" },
] as const;

function sourceLocationLabel(location: ClimbingMapLocation): string {
  return `${location.scope === "area" ? "Area location" : "Climb location"}${location.name ? `: ${location.name}` : ""} · ${providerSourceLabel(location.providerId)}`;
}

function displayRecordLocalTime(
  startedAt: string,
  localTimeContext: RecordLocalTimeContext,
): string {
  const localTime = formatRecordLocalTime(
    startedAt,
    localTimeContext,
    "start",
    undefined,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  return localTime === "--" ? "Local time unavailable" : localTime;
}

function formatActivityAccessibilityLabel(
  action: "Open" | "Select" | "Deselect",
  activity: {
    activityType: string;
    primaryActivityType: string | null;
    modality: string | null;
    durationMin: number;
    localTimeContext: RecordLocalTimeContext;
    name: string | null;
    startedAt: string;
    distanceMeters: number | null;
    distanceState: ActivityDataState;
    elevationGainM: number | null;
    elevationState: ActivityDataState;
    location: ActivityLocation | null;
    stats: ActivityMetric[];
  },
  units: UnitConverter,
): string {
  const activityTypeLabel = formatActivityTypeLabel(
    activity.primaryActivityType ?? activity.activityType,
  );
  const labelParts = [
    activity.name ?? activityTypeLabel,
    displayRecordLocalTime(activity.startedAt, activity.localTimeContext),
    formatDurationMinutes(activity.durationMin),
  ];

  if (activity.name !== null && activity.name !== activityTypeLabel) {
    labelParts.push(activityTypeLabel);
  }

  const isIndoorCycling =
    activity.activityType === "cycling" && isIndoorCyclingModality(activity.modality);
  const hasRouteMetrics =
    !isIndoorCycling &&
    (activity.location?.kind === "recorded_gps" ||
      activity.distanceState.status !== "missing" ||
      activity.elevationState.status !== "missing");
  if (hasRouteMetrics) {
    const routeMetrics = [
      formatActivityMetric(
        "Distance",
        activity.distanceMeters,
        activity.distanceState,
        (distanceMeters) => formatMeasurementText(units.formatDistance(distanceMeters / 1000)),
      ),
      formatActivityMetric(
        "Elevation",
        activity.elevationGainM,
        activity.elevationState,
        (elevationMeters) => formatMeasurementText(units.formatElevation(elevationMeters)),
      ),
    ];
    for (const metric of routeMetrics) {
      if (metric.status === "available") {
        labelParts.push(`${metric.label} ${metric.value}`);
      } else {
        labelParts.push(
          `${metric.label} ${activityDataStateLabel(metric.status)}: ${metric.reason}`,
        );
      }
    }
  } else {
    for (const metric of activity.stats) {
      if (metric.status === "available") {
        labelParts.push(`${metric.label} ${metric.value}`);
      } else {
        labelParts.push(
          `${metric.label} ${activityDataStateLabel(metric.status)}: ${metric.reason}`,
        );
      }
    }
  }

  if (activity.location?.kind === "climbing_source") {
    labelParts.push(
      `Climbing source locations: ${activity.location.sourcePoints.map((point) => sourceLocationLabel(point.location)).join("; ")}`,
    );
  } else if (activity.location?.kind === "processing") {
    labelParts.push("Processing map");
  }

  return `${action} ${labelParts.join(", ")}`;
}

export default function ActivitiesScreen() {
  const router = useRouter();
  const units = useUnitConverter();
  const endDate = useMemo(() => formatDateYmd(), []);
  const [weeks, setWeeks] = useState(DEFAULT_WEEKS);
  const [activityType, setActivityType] = useState(ALL_ACTIVITY_TYPES);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedActivities, setSelectedActivities] = useState<Map<string, string>>(new Map());
  const selectedActivityIds = new Set(selectedActivities.keys());
  const [activityPage, setActivityPage] = useState(0);
  const selectedActivityType = activityType === ALL_ACTIVITY_TYPES ? undefined : activityType;
  const queryInput = useMemo(
    () => ({
      weeks,
      endDate,
      ...(selectedActivityType ? { activityType: selectedActivityType } : {}),
    }),
    [weeks, endDate, selectedActivityType],
  );
  const trpcUtils = trpc.useUtils();
  const pageInput = useMemo(
    () => ({ ...queryInput, page: activityPage, pageSize: ACTIVITY_PAGE_SIZE }),
    [queryInput, activityPage],
  );
  const rangeKey = JSON.stringify(queryInput);
  const lastSuccessfulInput = useRef<{ rangeKey: string; input: typeof pageInput } | undefined>(
    undefined,
  );
  const query = trpc.calendar.weekListV2.useQuery(pageInput, {
    placeholderData: (previousData) => previousData,
    refetchInterval: (query) =>
      query.state.data?.days.some((day) =>
        day.activities.some((activity) => activity.location?.kind === "processing"),
      )
        ? processingPollInterval("active")
        : false,
  });
  const overviewQuery = trpc.calendar.activityOverview.useQuery(queryInput, {
    placeholderData: (previousData) => previousData,
  });
  useEffect(() => {
    if (query.data && !query.isPlaceholderData && !query.isError) {
      lastSuccessfulInput.current = { rangeKey, input: pageInput };
    }
  }, [query.data, query.isPlaceholderData, query.isError, rangeKey, pageInput]);
  const previousInput = lastSuccessfulInput.current;
  const pageData =
    query.data ??
    (previousInput?.rangeKey === rangeKey
      ? trpcUtils.calendar.weekListV2.getData(previousInput.input)
      : undefined);
  const calendarQuery = trpc.calendar.calendarData.useQuery(
    { days: weeks * 7 },
    {
      placeholderData: (previousData) =>
        previousData && previousData.length > 0 ? previousData : undefined,
    },
  );
  const processingStatus = useProcessingStatus({ datasets: ["activity"] });
  const bulkDelete = trpc.activity.bulkDelete.useMutation({
    onSuccess: async () => {
      await trpcUtils.calendar.weekListV2.invalidate();
      await trpcUtils.calendar.activityOverview.invalidate();
      await trpcUtils.calendar.calendarData.invalidate();
      await trpcUtils.activity.list.invalidate();
      setSelectedActivities(new Map());
      setSelectMode(false);
    },
  });
  const mergeActivities = trpc.activity.merge.useMutation({
    onSuccess: async () => {
      await trpcUtils.calendar.weekListV2.invalidate();
      await trpcUtils.calendar.activityOverview.invalidate();
      await trpcUtils.calendar.calendarData.invalidate();
      await trpcUtils.activity.list.invalidate();
      setSelectedActivities(new Map());
      setSelectMode(false);
    },
    onError: (error) => Alert.alert("Unable to merge activities", error.message),
  });
  const { refreshing, onRefresh } = useRefresh({
    invalidate: () =>
      Promise.all([
        trpcUtils.calendar.weekListV2.invalidate(),
        trpcUtils.calendar.activityOverview.invalidate(),
        trpcUtils.calendar.calendarData.invalidate(),
        trpcUtils.activity.list.invalidate(),
        trpcUtils.processing.status.invalidate(),
      ]).then(() => undefined),
  });

  const dayGroups = pageData?.days;
  const hasActivities = dayGroups?.some((day) => day.activities.length > 0) ?? false;
  const activityCount = pageData?.totalCount ?? 0;
  const currentActivityPage = pageData?.page ?? activityPage;
  const visibleDayGroups = dayGroups;
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
  const cancelSelection = () => {
    setSelectedActivities(new Map());
    setSelectMode(false);
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
        error={processingStatus.error}
        loading={processingStatus.isLoading}
      />

      <ActivityControls
        activityTypes={overviewQuery.data?.activityTypes ?? []}
        activityType={activityType}
        weeks={weeks}
        canSelect={hasActivities}
        selectMode={selectMode}
        selectedCount={selectedCount}
        deletePending={bulkDelete.isPending}
        mergePending={mergeActivities.isPending}
        mergeEligible={mergeEligible}
        mixedTypes={selectedTypes.size > 1}
        onActivityTypeChange={updateActivityType}
        onWeeksChange={updateWeeks}
        onSelect={() => setSelectMode(true)}
        onCancelSelection={cancelSelection}
        onDeleteSelected={confirmBulkDelete}
        onMergeSelected={confirmMerge}
      />

      {bulkDelete.error ? (
        <QueryStatePanel variant="error" message={userFacingErrorMessage(bulkDelete.error)} />
      ) : null}

      {overviewQuery.isLoading && !overviewQuery.data ? (
        <QueryStatePanel variant="loading" minHeight={100} />
      ) : overviewQuery.isError && !overviewQuery.data ? (
        <QueryStatePanel variant="error" message={userFacingErrorMessage(overviewQuery.error)} />
      ) : (
        <>
          {overviewQuery.isError ? (
            <QueryStatePanel
              variant="error"
              message={userFacingErrorMessage(overviewQuery.error)}
              minHeight={72}
              style={styles.backgroundErrorPanel}
            />
          ) : null}
          <ActivityOverview overview={overviewQuery.data} units={units} />
        </>
      )}

      {calendarQuery.isLoading && !calendarQuery.data ? (
        <QueryStatePanel variant="loading" minHeight={180} />
      ) : calendarQuery.isError && !calendarQuery.data ? (
        <QueryStatePanel variant="error" message={userFacingErrorMessage(calendarQuery.error)} />
      ) : (
        <>
          {calendarQuery.isError ? (
            <QueryStatePanel
              variant="error"
              message={userFacingErrorMessage(calendarQuery.error)}
              minHeight={72}
              style={styles.backgroundErrorPanel}
            />
          ) : null}
          <ActivityHeatmap data={calendarQuery.data ?? []} />
        </>
      )}

      {query.isLoading && !pageData ? (
        <QueryStatePanel variant="loading" minHeight={200} />
      ) : query.isError && !pageData ? (
        <QueryStatePanel
          variant="error"
          message={userFacingErrorMessage(query.error)}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : !dayGroups || dayGroups.length === 0 ? (
        <QueryStatePanel variant="empty" message={`No activities in the last ${weeks} weeks.`} />
      ) : (
        <>
          {query.isError ? (
            <QueryStatePanel
              variant="error"
              message={userFacingErrorMessage(query.error)}
              minHeight={72}
              style={styles.backgroundErrorPanel}
              onRetry={() => void query.refetch()}
              retrying={query.isFetching}
            />
          ) : null}
          {visibleDayGroups?.map((day) => (
            <View key={day.date} style={styles.daySection}>
              <View style={styles.dayHeaderRow}>
                <Text style={styles.dayHeader}>{formatDayHeader(day.date)}</Text>
                <View style={styles.dayHeaderRule} />
              </View>
              {day.activities.map((activity) => (
                <View
                  key={activity.id}
                  style={[
                    styles.card,
                    selectedActivityIds.has(activity.id) ? styles.cardSelected : null,
                  ]}
                >
                  <TouchableOpacity
                    activeOpacity={0.7}
                    onPress={() => {
                      if (selectMode) {
                        toggleSelectedActivity(activity.id, activity.activityType);
                        return;
                      }
                      router.push(`/activity/${activity.id}`);
                    }}
                    style={styles.cardAction}
                    accessibilityRole="button"
                    accessibilityLabel={formatActivityAccessibilityLabel(
                      selectMode
                        ? selectedActivityIds.has(activity.id)
                          ? "Deselect"
                          : "Select"
                        : "Open",
                      activity,
                      units,
                    )}
                    accessibilityState={{
                      selected: selectMode ? selectedActivityIds.has(activity.id) : undefined,
                    }}
                  />
                  <View style={styles.cardContent} pointerEvents="box-none">
                    <View
                      pointerEvents="none"
                      accessibilityElementsHidden
                      importantForAccessibility="no-hide-descendants"
                    >
                      <ActivityTypeIcon
                        activityType={activity.primaryActivityType ?? activity.activityType}
                        size={40}
                      />
                    </View>
                    <View style={styles.cardMain} pointerEvents="box-none">
                      <View
                        style={styles.titleRow}
                        pointerEvents="none"
                        accessibilityElementsHidden
                        importantForAccessibility="no-hide-descendants"
                      >
                        <Text style={styles.activityName} numberOfLines={1}>
                          {activity.name ??
                            formatActivityTypeLabel(
                              activity.primaryActivityType ?? activity.activityType,
                            )}
                        </Text>
                        {selectMode ? (
                          <Text
                            style={[
                              styles.selectionPill,
                              selectedActivityIds.has(activity.id)
                                ? styles.selectionPillSelected
                                : null,
                            ]}
                          >
                            {selectedActivityIds.has(activity.id) ? "Selected" : "Select"}
                          </Text>
                        ) : null}
                        {activity.name !== null &&
                        activity.name !==
                          formatActivityTypeLabel(
                            activity.primaryActivityType ?? activity.activityType,
                          ) ? (
                          <Text style={styles.typePill}>
                            {formatActivityTypeLabel(
                              activity.primaryActivityType ?? activity.activityType,
                            )}
                          </Text>
                        ) : null}
                      </View>
                      <View style={styles.metaRow} pointerEvents="box-none">
                        <View
                          pointerEvents="none"
                          accessibilityElementsHidden
                          importantForAccessibility="no-hide-descendants"
                        >
                          <Text style={styles.activityMeta}>
                            {displayRecordLocalTime(activity.startedAt, activity.localTimeContext)}{" "}
                            · {formatDurationMinutes(activity.durationMin)}
                          </Text>
                        </View>
                      </View>
                      <View
                        pointerEvents="none"
                        accessibilityElementsHidden
                        importantForAccessibility="no-hide-descendants"
                      >
                        <ActivityMetricStrip activity={activity} units={units} />
                      </View>
                    </View>
                  </View>
                  {activity.location ? (
                    <View
                      style={styles.mapPanel}
                      pointerEvents="none"
                      accessibilityElementsHidden
                      importantForAccessibility="no-hide-descendants"
                    >
                      <ActivityMapTile location={activity.location} />
                    </View>
                  ) : !activity.isProviderAbsent ? (
                    <View pointerEvents="none">
                      <ActivityPhotoPreview activityId={activity.id} />
                    </View>
                  ) : null}
                  <ActivitySourceDisclosure tree={activity.source.tree} />
                </View>
              ))}
            </View>
          ))}
          <PaginationControls
            page={currentActivityPage}
            pageSize={ACTIVITY_PAGE_SIZE}
            totalItems={activityCount}
            itemLabel="activities"
            onPageChange={setActivityPage}
          />
        </>
      )}
    </ScrollView>
  );
}

interface ActivityControlsProps {
  activityTypes: string[];
  activityType: string;
  weeks: number;
  canSelect: boolean;
  selectMode: boolean;
  selectedCount: number;
  deletePending: boolean;
  mergePending: boolean;
  mergeEligible: boolean;
  mixedTypes: boolean;
  onActivityTypeChange: (activityType: string) => void;
  onWeeksChange: (weeks: number) => void;
  onSelect: () => void;
  onCancelSelection: () => void;
  onDeleteSelected: () => void;
  onMergeSelected: () => void;
}

function ActivityControls({
  activityTypes,
  activityType,
  weeks,
  canSelect,
  selectMode,
  selectedCount,
  deletePending,
  mergePending,
  mergeEligible,
  mixedTypes,
  onActivityTypeChange,
  onWeeksChange,
  onSelect,
  onCancelSelection,
  onDeleteSelected,
  onMergeSelected,
}: ActivityControlsProps) {
  const selectedCountLabel = `${selectedCount} ${
    selectedCount === 1 ? "activity" : "activities"
  } selected`;

  useEffect(() => {
    if (selectMode && Platform.OS === "ios") {
      AccessibilityInfo.announceForAccessibility(selectedCountLabel);
    }
  }, [selectMode, selectedCountLabel]);

  return (
    <View style={styles.controlsPanel}>
      {canSelect && !selectMode ? (
        <View style={styles.controlsHeader}>
          <TouchableOpacity
            style={styles.selectButton}
            onPress={onSelect}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Select activities"
            accessibilityHint="Choose activities to merge or delete"
          >
            <Text style={styles.selectButtonText}>Select activities</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {canSelect && selectMode ? (
        <Text style={styles.selectionGuidance}>Choose activities to merge or delete.</Text>
      ) : null}
      {selectMode ? (
        <View style={styles.bulkActionRow}>
          <Text style={styles.selectedCount} accessibilityLiveRegion="polite">
            {selectedCountLabel}
          </Text>
          <TouchableOpacity
            style={[
              styles.deleteSelectionButton,
              !mergeEligible || mergePending ? styles.disabledAction : null,
            ]}
            onPress={onMergeSelected}
            disabled={!mergeEligible || mergePending}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Merge selected activities"
            accessibilityState={{ busy: mergePending, disabled: !mergeEligible || mergePending }}
          >
            <Text style={styles.deleteSelectionButtonText}>
              {mergePending ? "Merging..." : "Merge"}
            </Text>
          </TouchableOpacity>
          {mixedTypes ? (
            <Text style={styles.selectionGuidance}>Select activities of one type to merge.</Text>
          ) : null}
          <TouchableOpacity
            style={[
              styles.deleteSelectionButton,
              selectedCount === 0 ? styles.disabledAction : null,
            ]}
            onPress={onDeleteSelected}
            disabled={selectedCount === 0 || deletePending}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Delete selected activities"
            accessibilityState={{
              busy: deletePending,
              disabled: selectedCount === 0 || deletePending,
            }}
          >
            <Text style={styles.deleteSelectionButtonText}>
              {deletePending ? "Deleting..." : "Delete"}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.cancelSelectionButton}
            onPress={onCancelSelection}
            disabled={deletePending || mergePending}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Cancel activity selection"
            accessibilityState={{
              busy: deletePending || mergePending,
              disabled: deletePending || mergePending,
            }}
          >
            <Text style={styles.cancelSelectionButtonText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      <View style={styles.chipRow}>
        {DATE_RANGE_OPTIONS.map((option) => (
          <TouchableOpacity
            key={option.value}
            style={[styles.filterChip, weeks === option.value ? styles.filterChipSelected : null]}
            onPress={() => onWeeksChange(option.value)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={option.label}
            accessibilityState={{ selected: weeks === option.value }}
          >
            <Text
              style={[
                styles.filterChipText,
                weeks === option.value ? styles.filterChipTextSelected : null,
              ]}
            >
              {option.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={styles.chipRow}>
        <TouchableOpacity
          style={[
            styles.filterChip,
            activityType === ALL_ACTIVITY_TYPES ? styles.filterChipSelected : null,
          ]}
          onPress={() => onActivityTypeChange(ALL_ACTIVITY_TYPES)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="All activities"
          accessibilityState={{ selected: activityType === ALL_ACTIVITY_TYPES }}
        >
          <Text
            style={[
              styles.filterChipText,
              activityType === ALL_ACTIVITY_TYPES ? styles.filterChipTextSelected : null,
            ]}
          >
            All activities
          </Text>
        </TouchableOpacity>
        {activityTypes.map((type) => (
          <TouchableOpacity
            key={type}
            style={[styles.filterChip, activityType === type ? styles.filterChipSelected : null]}
            onPress={() => onActivityTypeChange(type)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={formatActivityTypeLabel(type)}
            accessibilityState={{ selected: activityType === type }}
          >
            <Text
              style={[
                styles.filterChipText,
                activityType === type ? styles.filterChipTextSelected : null,
              ]}
            >
              {formatActivityTypeLabel(type)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

function formatDayHeader(dateStr: string): string {
  const date = parseValidDate(`${dateStr}T00:00:00`);
  if (!date) return dateStr;
  if (isToday(date)) return "Today";
  if (isYesterday(date)) return "Yesterday";
  return formatDateForDisplay(date);
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: spacing.md,
    gap: spacing.md,
  },
  backgroundErrorPanel: {
    marginBottom: spacing.md,
  },
  controlsPanel: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.sm,
  },
  controlsHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: spacing.sm,
  },
  selectButton: {
    borderColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  selectButtonText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
  },
  selectionGuidance: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  bulkActionRow: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  selectedCount: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
  },
  deleteSelectionButton: {
    backgroundColor: colors.danger,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  deleteSelectionButtonText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
  },
  cancelSelectionButton: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  cancelSelectionButtonText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "600",
  },
  disabledAction: {
    opacity: 0.5,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
  },
  filterChip: {
    borderColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  filterChipSelected: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  filterChipText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
  },
  filterChipTextSelected: {
    color: "#fff",
  },
  daySection: {
    gap: spacing.sm,
  },
  dayHeaderRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  dayHeader: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  dayHeaderRule: {
    backgroundColor: colors.surfaceSecondary,
    flex: 1,
    height: 1,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    overflow: "hidden",
  },
  cardSelected: {
    borderColor: colors.accent,
    borderWidth: 1,
  },
  cardAction: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  cardContent: {
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.sm,
  },
  cardMain: {
    flex: 1,
    minWidth: 0,
    padding: spacing.xs,
  },
  titleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.xs,
  },
  activityName: {
    color: colors.text,
    flex: 1,
    fontSize: 15,
    fontWeight: "600",
  },
  typePill: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.sm,
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "600",
    overflow: "hidden",
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
  },
  selectionPill: {
    borderColor: colors.surfaceSecondary,
    borderRadius: radius.sm,
    borderWidth: 1,
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "600",
    overflow: "hidden",
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
  },
  selectionPillSelected: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
    color: "#fff",
  },
  activityMeta: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    flexWrap: "wrap",
  },
  mapPanel: {
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.sm,
  },
});
