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
  Image,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
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

export default function ActivitiesScreen() {
  const router = useRouter();
  const units = useUnitConverter();
  const endDate = useMemo(() => formatDateYmd(), []);
  const [weeks, setWeeks] = useState(DEFAULT_WEEKS);
  const [activityType, setActivityType] = useState(ALL_ACTIVITY_TYPES);
  const selectedActivityType = activityType === ALL_ACTIVITY_TYPES ? undefined : activityType;
  const queryInput = {
    weeks,
    endDate,
    ...(selectedActivityType ? { activityType: selectedActivityType } : {}),
  };
  const query = trpc.calendar.weekList.useQuery(queryInput);
  const overviewQuery = trpc.calendar.activityOverview.useQuery(queryInput);
  const { refreshing, onRefresh } = useRefresh();

  const dayGroups = query.data;

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

      <ActivityControls
        activityTypes={overviewQuery.data?.activityTypes ?? []}
        activityType={activityType}
        weeks={weeks}
        onActivityTypeChange={setActivityType}
        onWeeksChange={setWeeks}
      />

      {overviewQuery.isError ? (
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
                onPress={() => router.push(`/activity/${activity.id}`)}
                style={styles.card}
              >
                <View style={styles.cardContent}>
                  <View style={styles.cardMain}>
                    <View style={styles.titleRow}>
                      <Text style={styles.activityName} numberOfLines={1}>
                        {activity.name ?? formatActivityTypeLabel(activity.activityType)}
                      </Text>
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
                    <ActivityMapTile location={activity.location} units={units} />
                  ) : null}
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
  onActivityTypeChange: (activityType: string) => void;
  onWeeksChange: (weeks: number) => void;
}

function ActivityControls({
  activityTypes,
  activityType,
  weeks,
  onActivityTypeChange,
  onWeeksChange,
}: ActivityControlsProps) {
  return (
    <View style={styles.controlsPanel}>
      <View>
        <Text style={styles.controlsTitle}>Activity log</Text>
      </View>
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
    tileUrl: string;
    distanceMeters: number | null;
    elevationGainM: number | null;
  };
  units: ReturnType<typeof useUnitConverter>;
}

function ActivityMapTile({ location, units }: ActivityMapTileProps) {
  const [loadFailed, setLoadFailed] = useState(false);

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
        <Image
          source={{ uri: location.tileUrl }}
          style={styles.tile}
          resizeMode="cover"
          accessibilityLabel="Activity location map"
          onError={() => setLoadFailed(true)}
        />
      )}
      <View style={styles.tileOverlay}>
        {location.distanceMeters != null ? (
          <Text style={styles.tileBadge}>
            {formatMeasurementText(units.formatDistance(location.distanceMeters / 1000))}
          </Text>
        ) : null}
        {location.elevationGainM != null ? (
          <Text style={styles.tileBadge}>
            ↑ {formatMeasurementText(units.formatElevation(location.elevationGainM))}
          </Text>
        ) : null}
      </View>
    </View>
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
  controlsTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "700",
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
  tile: {
    width: "100%",
    height: "100%",
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
  tileOverlay: {
    position: "absolute",
    bottom: spacing.xs,
    left: spacing.xs,
    flexDirection: "row",
    gap: spacing.xs,
  },
  tileBadge: {
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    color: "#fff",
    fontSize: 11,
    fontWeight: "600",
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
    borderRadius: radius.sm,
    overflow: "hidden",
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
