import {
  formatDateForDisplay,
  formatDurationMinutes,
  formatTime,
  isToday,
  isYesterday,
  parseValidDate,
} from "@dofek/format/format";
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

const TILE_HEIGHT = 140;

export default function ActivitiesScreen() {
  const router = useRouter();
  const units = useUnitConverter();
  const endDate = useMemo(() => new Date().toLocaleDateString("en-CA"), []);
  const query = trpc.calendar.weekList.useQuery({ weeks: 4, endDate });
  const { refreshing, onRefresh } = useRefresh();

  const dayGroups = query.data ?? [];

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

      {query.isLoading ? (
        <QueryStatePanel variant="loading" minHeight={200} />
      ) : query.isError ? (
        <QueryStatePanel variant="error" message={query.error.message} />
      ) : dayGroups.length === 0 ? (
        <QueryStatePanel variant="empty" message="No activities in the last 4 weeks." />
      ) : (
        dayGroups.map((day) => (
          <View key={day.date} style={styles.daySection}>
            <Text style={styles.dayHeader}>{formatDayHeader(day.date)}</Text>
            {day.activities.map((activity) => (
              <TouchableOpacity
                key={activity.id}
                activeOpacity={0.7}
                onPress={() => router.push(`/activity/${activity.id}`)}
                style={styles.card}
              >
                <View style={styles.cardHeader}>
                  <View style={styles.cardHeaderText}>
                    <Text style={styles.activityName} numberOfLines={1}>
                      {activity.name ?? formatActivityTypeLabel(activity.activityType)}
                    </Text>
                    <Text style={styles.activityMeta}>
                      {formatTime(activity.startedAt)} •{" "}
                      {formatDurationMinutes(activity.durationMin)} •{" "}
                      {formatActivityTypeLabel(activity.activityType)}
                    </Text>
                  </View>
                </View>

                {activity.location ? (
                  <ActivityMapTile location={activity.location} units={units} />
                ) : (
                  <View style={styles.statsRow}>
                    {activity.stats.map((stat) => (
                      <StatBadge key={stat.label} label={stat.label} value={stat.value} />
                    ))}
                  </View>
                )}
              </TouchableOpacity>
            ))}
          </View>
        ))
      )}
    </ScrollView>
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
            {units.formatDistance(location.distanceMeters / 1000)}
          </Text>
        ) : null}
        {location.elevationGainM != null ? (
          <Text style={styles.tileBadge}>↑ {units.formatElevation(location.elevationGainM)}</Text>
        ) : null}
      </View>
    </View>
  );
}

function StatBadge({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statBadge}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
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
  daySection: {
    gap: spacing.sm,
  },
  dayHeader: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    overflow: "hidden",
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.md,
    gap: spacing.sm,
  },
  cardHeaderText: {
    flex: 1,
    minWidth: 0,
  },
  activityName: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "600",
  },
  activityMeta: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  tileContainer: {
    height: TILE_HEIGHT,
    backgroundColor: colors.surfaceSecondary,
    position: "relative",
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
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
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
