import {
  type ActivityDataState,
  type ActivityMetric,
  activityDataStateLabel,
  formatActivityMetric,
} from "@dofek/format/activity-data-state";
import {
  type ActivityOverviewComparison,
  activityOverviewChangeForLabel,
  formatActivityOverviewChange,
} from "@dofek/format/activity-overview";
import {
  formatDateForDisplay,
  formatDateYmd,
  formatDurationMinutes,
  formatRelativeTime,
  isToday,
  isYesterday,
  parseValidDate,
} from "@dofek/format/format";
import {
  formatRecordLocalTime,
  type RecordLocalTimeContext,
} from "@dofek/format/record-local-time";
import { formatMeasurementText, type UnitConverter } from "@dofek/format/units";
import { formatActivityTypeLabel } from "@dofek/training/training";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
  AccessibilityInfo,
  Alert,
  Image,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Svg, { Polyline } from "react-native-svg";
import { ActivityMetricStrip } from "../../components/ActivityMetricStrip";
import { ActivityTypeIcon } from "../../components/ActivityTypeIcon";
import { PaginationControls } from "../../components/PaginationControls";
import { ProcessingStatusWidget } from "../../components/ProcessingStatusWidget";
import { QueryStatePanel } from "../../components/QueryStatePanel";
import { trpc } from "../../lib/trpc";
import { useUnitConverter } from "../../lib/units";
import { useProcessingStatus } from "../../lib/useProcessingStatus";
import { useRefresh } from "../../lib/useRefresh";
import { colors, radius, spacing } from "../../theme";

const TILE_SIZE = 96;
const DEFAULT_WEEKS = 4;
const ACTIVITY_PAGE_SIZE = 20;
const ALL_ACTIVITY_TYPES = "all";
const DATE_RANGE_OPTIONS = [
  { value: 4, label: "4 weeks" },
  { value: 8, label: "8 weeks" },
  { value: 12, label: "12 weeks" },
] as const;

type RoutePathPoint = { x: number; y: number };
type ActivityMapPreviewTile = {
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

type ActivityMapPreview = {
  width: number;
  height: number;
  tiles: ActivityMapPreviewTile[];
  routePath: RoutePathPoint[] | null;
};

function formatRouteCoordinate(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function displayRecordLocalTime(
  startedAt: string,
  localTimeContext: RecordLocalTimeContext,
): string {
  const localTime = formatRecordLocalTime(startedAt, localTimeContext, "start");
  return localTime === "--" ? "Local time unavailable" : localTime;
}

function formatActivityAccessibilityLabel(
  action: "Open" | "Select" | "Deselect",
  activity: {
    activityType: string;
    durationMin: number;
    localTimeContext: RecordLocalTimeContext;
    name: string | null;
    startedAt: string;
    distanceMeters: number | null;
    distanceState: ActivityDataState;
    elevationGainM: number | null;
    elevationState: ActivityDataState;
    location: { mapPreview: unknown } | null;
    stats: ActivityMetric[];
  },
  units: UnitConverter,
): string {
  const activityTypeLabel = formatActivityTypeLabel(activity.activityType);
  const labelParts = [
    activity.name ?? activityTypeLabel,
    displayRecordLocalTime(activity.startedAt, activity.localTimeContext),
    formatDurationMinutes(activity.durationMin),
  ];

  if (activity.name !== null) {
    labelParts.push(activityTypeLabel);
  }

  const hasRouteMetrics =
    activity.location != null ||
    activity.distanceState.status !== "missing" ||
    activity.elevationState.status !== "missing";
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
      if (metric.status !== "available") {
        labelParts.push(
          `${metric.label} ${activityDataStateLabel(metric.status)}: ${metric.reason}`,
        );
      }
    }
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
  const [selectedActivityIds, setSelectedActivityIds] = useState<Set<string>>(new Set());
  const [activityPage, setActivityPage] = useState(0);
  const selectedActivityType = activityType === ALL_ACTIVITY_TYPES ? undefined : activityType;
  const queryInput = {
    weeks,
    endDate,
    ...(selectedActivityType ? { activityType: selectedActivityType } : {}),
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
      await trpcUtils.calendar.weekList.invalidate();
      await trpcUtils.calendar.activityOverview.invalidate();
      await trpcUtils.activity.list.invalidate();
      setSelectedActivityIds(new Set());
      setSelectMode(false);
    },
  });
  const { refreshing, onRefresh } = useRefresh({
    invalidate: () =>
      Promise.all([
        trpcUtils.calendar.weekList.invalidate(),
        trpcUtils.calendar.activityOverview.invalidate(),
        trpcUtils.activity.list.invalidate(),
        trpcUtils.processing.status.invalidate(),
      ]).then(() => undefined),
  });

  const dayGroups = query.data;
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
  const cancelSelection = () => {
    setSelectedActivityIds(new Set());
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
      <TouchableOpacity
        style={styles.recordButton}
        onPress={() => router.push("/record")}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel="Record Activity"
      >
        <Text style={styles.recordButtonText}>Record Activity</Text>
      </TouchableOpacity>

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
        onActivityTypeChange={updateActivityType}
        onWeeksChange={updateWeeks}
        onSelect={() => setSelectMode(true)}
        onCancelSelection={cancelSelection}
        onDeleteSelected={confirmBulkDelete}
      />

      {bulkDelete.error ? (
        <QueryStatePanel variant="error" message={bulkDelete.error.message} />
      ) : null}

      {overviewQuery.isLoading && !overviewQuery.data ? (
        <QueryStatePanel variant="loading" minHeight={100} />
      ) : overviewQuery.isError && !overviewQuery.data ? (
        <QueryStatePanel variant="error" message={overviewQuery.error.message} />
      ) : (
        <>
          {overviewQuery.isError ? (
            <QueryStatePanel
              variant="error"
              message={overviewQuery.error.message}
              minHeight={72}
              style={styles.backgroundErrorPanel}
            />
          ) : null}
          <ActivityOverview overview={overviewQuery.data} units={units} />
        </>
      )}

      {query.isLoading && !query.data ? (
        <QueryStatePanel variant="loading" minHeight={200} />
      ) : query.isError && !query.data ? (
        <QueryStatePanel variant="error" message={query.error.message} />
      ) : !dayGroups || dayGroups.length === 0 ? (
        <QueryStatePanel variant="empty" message={`No activities in the last ${weeks} weeks.`} />
      ) : (
        <>
          {query.isError ? (
            <QueryStatePanel
              variant="error"
              message={query.error.message}
              minHeight={72}
              style={styles.backgroundErrorPanel}
            />
          ) : null}
          {visibleDayGroups?.map((day) => (
            <View key={day.date} style={styles.daySection}>
              <View style={styles.dayHeaderRow}>
                <Text style={styles.dayHeader}>{formatDayHeader(day.date)}</Text>
                <View style={styles.dayHeaderRule} />
              </View>
              {day.activities.map((activity) => (
                <TouchableOpacity
                  key={activity.id}
                  activeOpacity={0.7}
                  onPress={() => {
                    if (selectMode) {
                      toggleSelectedActivity(activity.id);
                      return;
                    }
                    router.push(`/activity/${activity.id}`);
                  }}
                  style={[
                    styles.card,
                    selectedActivityIds.has(activity.id) ? styles.cardSelected : null,
                  ]}
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
                >
                  <View style={styles.cardContent}>
                    <View style={styles.cardMain}>
                      <View style={styles.titleRow}>
                        <Text style={styles.activityName} numberOfLines={1}>
                          {activity.name ?? formatActivityTypeLabel(activity.activityType)}
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
                        <Text style={styles.typePill}>
                          {formatActivityTypeLabel(activity.activityType)}
                        </Text>
                      </View>
                      <Text style={styles.activityMeta}>
                        {displayRecordLocalTime(activity.startedAt, activity.localTimeContext)} ·{" "}
                        {formatDurationMinutes(activity.durationMin)}
                      </Text>
                      <View style={styles.provenanceRow}>
                        <Text style={styles.sourcePill}>{activity.source.primarySourceLabel}</Text>
                        {activity.lastProcessedAt &&
                        formatRelativeTime(activity.lastProcessedAt) ? (
                          <Text style={styles.processedAt}>
                            Processed {formatRelativeTime(activity.lastProcessedAt)}
                          </Text>
                        ) : null}
                      </View>
                      {activity.source.overlapSummary ? (
                        <Text style={styles.overlapSummary}>{activity.source.overlapSummary}</Text>
                      ) : null}
                      <ActivityMetricStrip activity={activity} units={units} />
                    </View>
                    {activity.location ? (
                      <ActivityMapTile location={activity.location} />
                    ) : (
                      <ActivityTypeIcon activityType={activity.activityType} />
                    )}
                  </View>
                </TouchableOpacity>
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
  onActivityTypeChange: (activityType: string) => void;
  onWeeksChange: (weeks: number) => void;
  onSelect: () => void;
  onCancelSelection: () => void;
  onDeleteSelected: () => void;
}

function ActivityControls({
  activityTypes,
  activityType,
  weeks,
  canSelect,
  selectMode,
  selectedCount,
  deletePending,
  onActivityTypeChange,
  onWeeksChange,
  onSelect,
  onCancelSelection,
  onDeleteSelected,
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
      <View style={styles.controlsHeader}>
        <Text style={styles.controlsTitle}>Activity log</Text>
        {canSelect && !selectMode ? (
          <TouchableOpacity
            style={styles.selectButton}
            onPress={onSelect}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Select activities"
            accessibilityHint="Choose one or more activities to delete"
          >
            <Text style={styles.selectButtonText}>Select activities</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {canSelect ? (
        <Text style={styles.selectionGuidance}>Choose one or more activities to delete.</Text>
      ) : null}
      {selectMode ? (
        <View style={styles.bulkActionRow}>
          <Text style={styles.selectedCount} accessibilityLiveRegion="polite">
            {selectedCountLabel}
          </Text>
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
            disabled={deletePending}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Cancel activity selection"
            accessibilityState={{ busy: deletePending, disabled: deletePending }}
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

interface ActivityOverviewData {
  activityCount: number;
  totalMinutes: number;
  totalDistanceMeters: number | null;
  totalDistanceState: ActivityDataState;
  totalElevationGainM: number | null;
  totalElevationState: ActivityDataState;
  comparison?: ActivityOverviewComparison;
}

function ActivityOverview({
  overview,
  units,
}: {
  overview: ActivityOverviewData | undefined;
  units: ReturnType<typeof useUnitConverter>;
}) {
  const items: Array<ActivityMetric | { label: string; value: string }> = overview
    ? [
        { label: "Activities", value: String(overview.activityCount) },
        { label: "Time", value: formatDurationMinutes(overview.totalMinutes) },
        formatActivityMetric(
          "Distance",
          overview.totalDistanceMeters,
          overview.totalDistanceState,
          (distanceMeters) => formatMeasurementText(units.formatDistance(distanceMeters / 1000)),
        ),
        formatActivityMetric(
          "Elevation",
          overview.totalElevationGainM,
          overview.totalElevationState,
          (elevationMeters) => formatMeasurementText(units.formatElevation(elevationMeters)),
        ),
      ]
    : [
        { label: "Activities", value: "Loading…" },
        { label: "Time", value: "Loading…" },
        { label: "Distance", value: "Loading…" },
        { label: "Elevation", value: "Loading…" },
      ];

  return (
    <View style={styles.overviewGrid}>
      {items.map((item) => {
        const isMetric = "status" in item;
        const comparison = overview?.comparison
          ? activityOverviewChangeForLabel(overview.comparison, item.label)
          : undefined;
        const formatComparisonMagnitude = {
          Activities: (value: number) => String(value),
          Time: (value: number) => formatDurationMinutes(value),
          Distance: (value: number) => formatMeasurementText(units.formatDistance(value / 1000)),
          Elevation: (value: number) => formatMeasurementText(units.formatElevation(value)),
        }[item.label];
        const comparisonText =
          comparison && formatComparisonMagnitude
            ? formatActivityOverviewChange(
                comparison,
                overview?.comparison?.periodLabel ?? "previous period",
                formatComparisonMagnitude,
              )
            : undefined;
        const currentAccessibilityLabel = isMetric
          ? item.status === "available"
            ? `${item.label} ${item.value}`
            : `${item.label} ${activityDataStateLabel(item.status)}: ${item.reason}`
          : undefined;
        return (
          <View
            key={item.label}
            style={styles.overviewItem}
            accessible={isMetric || comparisonText !== undefined}
            accessibilityLabel={
              [currentAccessibilityLabel, comparisonText].filter(Boolean).join(". ") || undefined
            }
          >
            <Text style={styles.overviewValue}>
              {isMetric && item.status !== "available"
                ? `${item.label} ${activityDataStateLabel(item.status)}`
                : item.value}
            </Text>
            <Text style={styles.overviewLabel}>
              {isMetric && item.status !== "available" ? item.reason : item.label}
            </Text>
            {comparisonText ? <Text style={styles.activityMeta}>{comparisonText}</Text> : null}
          </View>
        );
      })}
    </View>
  );
}

interface ActivityMapTileProps {
  location: {
    mapPreview: ActivityMapPreview;
  };
}

function ActivityMapTile({ location }: ActivityMapTileProps) {
  const [loadFailed, setLoadFailed] = useState(false);
  const previewScale = Math.min(
    TILE_SIZE / location.mapPreview.width,
    TILE_SIZE / location.mapPreview.height,
  );
  const previewWidth = location.mapPreview.width * previewScale;
  const previewHeight = location.mapPreview.height * previewScale;
  const previewLeft = (TILE_SIZE - previewWidth) / 2;
  const previewTop = (TILE_SIZE - previewHeight) / 2;

  return (
    <View style={styles.tileContainer}>
      {loadFailed ? (
        <View
          style={styles.tileFallback}
          accessibilityLabel="Activity location unavailable"
          accessible={true}
        >
          <Text style={styles.tileFallbackText}>Map unavailable</Text>
        </View>
      ) : (
        <View
          testID="activity-route-viewport"
          style={styles.routeViewport}
          accessibilityLabel="Activity location map"
          accessible={true}
        >
          {location.mapPreview.tiles.map((tile) => (
            <Image
              key={`${tile.url}-${tile.x}-${tile.y}`}
              testID="activity-map-preview-tile"
              source={{ uri: tile.url }}
              style={{
                ...styles.previewTile,
                left: previewLeft + tile.x * previewScale,
                top: previewTop + tile.y * previewScale,
                width: tile.width * previewScale,
                height: tile.height * previewScale,
              }}
              resizeMode="cover"
              onError={() => setLoadFailed(true)}
            />
          ))}
          <ActivityRouteOverlay
            mapPreview={location.mapPreview}
            width={previewWidth}
            height={previewHeight}
            left={previewLeft}
            top={previewTop}
          />
        </View>
      )}
    </View>
  );
}

function ActivityRouteOverlay({
  mapPreview,
  width,
  height,
  left,
  top,
}: {
  mapPreview: ActivityMapPreview;
  width: number;
  height: number;
  left: number;
  top: number;
}) {
  const { routePath } = mapPreview;
  if (routePath == null || routePath.length < 2) return null;

  const points = routePath
    .map((point) => `${formatRouteCoordinate(point.x)},${formatRouteCoordinate(point.y)}`)
    .join(" ");
  return (
    <Svg
      testID="activity-route-overlay"
      pointerEvents="none"
      style={{ ...styles.routeOverlay, left, top, width, height }}
      viewBox={`0 0 ${mapPreview.width} ${mapPreview.height}`}
      preserveAspectRatio="none"
    >
      <Polyline
        points={points}
        fill="none"
        stroke="#fff"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={60}
      />
      <Polyline
        testID="activity-route-path"
        points={points}
        fill="none"
        stroke={colors.positive}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={30}
      />
    </Svg>
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
  recordButton: {
    backgroundColor: colors.accent,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    alignItems: "center",
  },
  recordButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
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
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  controlsTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "700",
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
  overviewGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  overviewItem: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    flexBasis: "47%",
    flexGrow: 1,
    padding: spacing.md,
  },
  overviewValue: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  overviewLabel: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
    marginTop: 2,
    textTransform: "uppercase",
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
  provenanceRow: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  sourcePill: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.sm,
    color: colors.text,
    fontSize: 11,
    fontWeight: "600",
    overflow: "hidden",
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
  },
  processedAt: {
    color: colors.textSecondary,
    fontSize: 11,
  },
  overlapSummary: {
    color: colors.textSecondary,
    fontSize: 11,
    lineHeight: 16,
    marginTop: spacing.xs,
  },
  tileContainer: {
    borderRadius: radius.md,
    height: TILE_SIZE,
    backgroundColor: colors.surfaceSecondary,
    overflow: "hidden",
    position: "relative",
    width: TILE_SIZE,
  },
  routeViewport: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  previewTile: {
    position: "absolute",
  },
  routeOverlay: {
    position: "absolute",
  },
  tileFallback: {
    width: "100%",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
  },
  tileFallbackText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
  },
});
