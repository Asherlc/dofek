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
import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import {
  Alert,
  Image,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Svg, { Polyline } from "react-native-svg";
import { ActivityTypeIcon } from "../../components/ActivityTypeIcon";
import { DataReadinessBanner } from "../../components/DataReadinessBanner";
import { QueryStatePanel } from "../../components/QueryStatePanel";
import { trpc } from "../../lib/trpc";
import { useUnitConverter } from "../../lib/units";
import { useRefresh } from "../../lib/useRefresh";
import { colors, radius, spacing } from "../../theme";

const TILE_SIZE = 96;
const DEFAULT_WEEKS = 4;
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

export default function ActivitiesScreen() {
  const router = useRouter();
  const units = useUnitConverter();
  const endDate = useMemo(() => formatDateYmd(), []);
  const [weeks, setWeeks] = useState(DEFAULT_WEEKS);
  const [activityType, setActivityType] = useState(ALL_ACTIVITY_TYPES);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedActivityIds, setSelectedActivityIds] = useState<Set<string>>(new Set());
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
  const dataHealth = trpc.sync.dataHealth.useQuery();
  const bulkDelete = trpc.activity.bulkDelete.useMutation({
    onSuccess: async () => {
      await trpcUtils.calendar.weekList.invalidate();
      await trpcUtils.calendar.activityOverview.invalidate();
      await trpcUtils.activity.list.invalidate();
      setSelectedActivityIds(new Set());
      setSelectMode(false);
    },
  });
  const { refreshing, onRefresh } = useRefresh();

  const dayGroups = query.data;
  const hasActivities = dayGroups?.some((day) => day.activities.length > 0) ?? false;
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
    cancelSelection();
  };
  const updateWeeks = (nextWeeks: number) => {
    setWeeks(nextWeeks);
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
      >
        <Text style={styles.recordButtonText}>Record Activity</Text>
      </TouchableOpacity>

      <DataReadinessBanner data={dataHealth.data} loading={dataHealth.isLoading} />

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

      {overviewQuery.isLoading ? (
        <QueryStatePanel variant="loading" minHeight={100} />
      ) : overviewQuery.isError ? (
        <QueryStatePanel variant="error" message={overviewQuery.error.message} />
      ) : (
        <ActivityOverview overview={overviewQuery.data} units={units} />
      )}

      {query.isLoading ? (
        <QueryStatePanel variant="loading" minHeight={200} />
      ) : query.isError ? (
        <QueryStatePanel variant="error" message={query.error.message} />
      ) : !dayGroups || dayGroups.length === 0 ? (
        <QueryStatePanel variant="empty" message={`No activities in the last ${weeks} weeks.`} />
      ) : (
        dayGroups.map((day) => (
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
                      {formatTime(activity.startedAt)} ·{" "}
                      {formatDurationMinutes(activity.durationMin)}
                    </Text>
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
        ))
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
  return (
    <View style={styles.controlsPanel}>
      <View style={styles.controlsHeader}>
        <Text style={styles.controlsTitle}>Activity log</Text>
        {canSelect && !selectMode ? (
          <TouchableOpacity style={styles.selectButton} onPress={onSelect} activeOpacity={0.7}>
            <Text style={styles.selectButtonText}>Select</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {selectMode ? (
        <View style={styles.bulkActionRow}>
          <Text style={styles.selectedCount}>{selectedCount} selected</Text>
          <TouchableOpacity
            style={[
              styles.deleteSelectionButton,
              selectedCount === 0 ? styles.disabledAction : null,
            ]}
            onPress={onDeleteSelected}
            disabled={selectedCount === 0 || deletePending}
            activeOpacity={0.7}
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
    <View style={styles.overviewGrid}>
      {items.map((item) => (
        <View key={item.label} style={styles.overviewItem}>
          <Text style={styles.overviewValue}>{item.value}</Text>
          <Text style={styles.overviewLabel}>{item.label}</Text>
        </View>
      ))}
    </View>
  );
}

interface ActivityMapTileProps {
  location: {
    mapPreview: ActivityMapPreview;
    distanceMeters: number | null;
    elevationGainM: number | null;
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
  const stats =
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
    <View style={styles.statsRow}>
      {stats.slice(0, 2).map((stat) => (
        <View key={stat.label} style={styles.statBadge}>
          <Text style={styles.statValue}>{stat.value}</Text>
          <Text style={styles.statLabel}>{stat.label}</Text>
        </View>
      ))}
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
  statsRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  statBadge: {
    flex: 1,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    alignItems: "center",
  },
  statValue: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  statLabel: {
    color: colors.textSecondary,
    fontSize: 11,
    marginTop: 2,
  },
});
