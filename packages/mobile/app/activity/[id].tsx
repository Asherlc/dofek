import {
  formatDateLong,
  formatDurationRange,
  formatDurationSeconds,
  formatNumber,
  formatTimeOnly,
} from "@dofek/format/format";
import type { UnitConverter } from "@dofek/format/units";
import { providerSourceLabel } from "@dofek/providers/providers";
import { getActivityIconInfo } from "@dofek/training/activity-icons";
import type { MuscleGroupInput } from "@dofek/training/muscle-groups";
import { cadenceUnit, formatActivityTypeLabel, isCyclingActivity } from "@dofek/training/training";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { ChartTitleWithTooltip } from "../../components/ChartTitleWithTooltip";
import { MuscleGroupBodyDiagram } from "../../components/MuscleGroupBodyDiagram";
import { RouteMap } from "../../components/RouteMap";
import { type ActivityExportFormat, downloadActivityExport } from "../../lib/activity-export";
import { useAuth } from "../../lib/auth-context";
import { captureException } from "../../lib/telemetry";
import { trpc } from "../../lib/trpc";
import { useUnitConverter } from "../../lib/units";
import { colors } from "../../theme";
import { AreaChart, CHART_COLORS, chartStyles, LineChart } from "./ActivityDetailCharts";
import { ProviderAbsentBanner } from "./ProviderAbsentBanner";
import { styles } from "./styles";
import { HrZonesChart, PowerZonesChart } from "./ZoneDistributionCharts";

const STRENGTH_ACTIVITY_TYPES = new Set(["strength", "strength_training", "functional_strength"]);

function isStrengthActivityType(activityType: string): boolean {
  return STRENGTH_ACTIVITY_TYPES.has(activityType);
}

function activityIcon(type: string): string {
  return getActivityIconInfo(type).emoji;
}

// ── Stats Grid ──

interface StatItem {
  label: string;
  value: string;
}

function StatsGrid({ stats }: { stats: StatItem[] }) {
  return (
    <View style={statsStyles.grid}>
      {stats.map((stat) => (
        <View key={stat.label} style={statsStyles.card}>
          <Text style={statsStyles.label}>{stat.label}</Text>
          <Text style={statsStyles.value}>{stat.value}</Text>
        </View>
      ))}
    </View>
  );
}

const statsStyles = StyleSheet.create({
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 14,
    width: "48%",
    flexGrow: 1,
  },
  label: {
    fontSize: 11,
    color: colors.textTertiary,
    marginBottom: 4,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  value: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
});

// ── Strength Exercise Breakdown ──

interface StrengthExercise {
  exerciseIndex: number;
  exerciseName: string;
  equipment: string | null;
  muscleGroups: string[] | null;
  sets: Array<{
    setIndex: number;
    weightKg: number | null;
    reps: number | null;
    durationSeconds: number | null;
    rpe: number | null;
  }>;
}

function exercisesToMuscleGroupInput(exercises: StrengthExercise[]): MuscleGroupInput[] {
  const groupSets = new Map<string, number>();
  for (const exercise of exercises) {
    if (!exercise.muscleGroups) continue;
    for (const group of exercise.muscleGroups) {
      groupSets.set(group, (groupSets.get(group) ?? 0) + exercise.sets.length);
    }
  }
  return [...groupSets.entries()].map(([muscleGroup, sets]) => ({
    muscleGroup,
    weeklyData: [{ week: "current", sets }],
  }));
}

function ExerciseBreakdown({
  exercises,
  units,
}: {
  exercises: StrengthExercise[];
  units: UnitConverter;
}) {
  const muscleGroupData = exercisesToMuscleGroupInput(exercises);

  return (
    <View style={exerciseStyles.container}>
      <ChartTitleWithTooltip
        title="Exercises"
        description="Exercises performed during this strength workout, with details for each set."
        textStyle={chartStyles.title}
      />
      {muscleGroupData.length > 0 && <MuscleGroupBodyDiagram data={muscleGroupData} />}
      {exercises.map((exercise) => {
        const hasWeight = exercise.sets.some((set) => set.weightKg != null);
        const hasDuration = exercise.sets.some((set) => set.durationSeconds != null);

        return (
          <View key={exercise.exerciseIndex} style={exerciseStyles.exerciseCard}>
            <View style={exerciseStyles.exerciseHeader}>
              <Text style={exerciseStyles.exerciseName}>{exercise.exerciseName}</Text>
              {exercise.equipment && (
                <View style={exerciseStyles.badge}>
                  <Text style={exerciseStyles.badgeText}>
                    {exercise.equipment.toLowerCase().replace(/_/g, " ")}
                  </Text>
                </View>
              )}
            </View>
            {exercise.muscleGroups && exercise.muscleGroups.length > 0 && (
              <View style={exerciseStyles.muscleGroupRow}>
                {exercise.muscleGroups.map((group) => (
                  <View key={group} style={exerciseStyles.muscleGroupBadge}>
                    <Text style={exerciseStyles.muscleGroupText}>{group.toLowerCase()}</Text>
                  </View>
                ))}
              </View>
            )}
            {exercise.sets.map((set) => (
              <View key={set.setIndex} style={exerciseStyles.setRow}>
                <Text style={exerciseStyles.setNumber}>{set.setIndex + 1}</Text>
                {hasWeight && (
                  <Text style={exerciseStyles.setValue}>
                    {set.weightKg != null
                      ? `${formatNumber(units.convertWeight(set.weightKg))} ${units.weightLabel}`
                      : "—"}
                  </Text>
                )}
                {set.reps != null && <Text style={exerciseStyles.setValue}>{set.reps} reps</Text>}
                {hasDuration && set.durationSeconds != null && (
                  <Text style={exerciseStyles.setValue}>
                    {formatDurationSeconds(set.durationSeconds)}
                  </Text>
                )}
                {set.rpe != null && (
                  <Text style={exerciseStyles.setRpe}>Perceived Exertion {set.rpe}</Text>
                )}
              </View>
            ))}
          </View>
        );
      })}
    </View>
  );
}

const exerciseStyles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    gap: 12,
  },
  exerciseCard: {
    gap: 6,
  },
  exerciseHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  exerciseName: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
  },
  badge: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  badgeText: {
    fontSize: 10,
    color: colors.textTertiary,
    textTransform: "capitalize",
  },
  muscleGroupRow: {
    flexDirection: "row",
    gap: 4,
    marginBottom: 2,
  },
  muscleGroupBadge: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  muscleGroupText: {
    fontSize: 10,
    color: colors.textTertiary,
  },
  setRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 3,
    paddingLeft: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surfaceSecondary,
  },
  setNumber: {
    fontSize: 12,
    color: colors.textTertiary,
    width: 18,
    fontVariant: ["tabular-nums"],
  },
  setValue: {
    fontSize: 13,
    color: colors.text,
    fontWeight: "500",
    fontVariant: ["tabular-nums"],
  },
  setRpe: {
    fontSize: 11,
    color: colors.textSecondary,
    fontVariant: ["tabular-nums"],
  },
});

// ── Main Screen ──

export default function ActivityDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const units = useUnitConverter();
  const { serverUrl, sessionToken } = useAuth();
  const trpcUtils = trpc.useUtils();
  const [exportingFormat, setExportingFormat] = useState<ActivityExportFormat | null>(null);
  const [exportModalVisible, setExportModalVisible] = useState(false);
  const deleteMutation = trpc.activity.delete.useMutation({
    onSuccess: async () => {
      await trpcUtils.activity.list.invalidate();
      router.back();
    },
  });

  const handleDelete = () => {
    Alert.alert(
      "Delete Activity",
      "Are you sure you want to delete this activity? This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            if (id) deleteMutation.mutate({ id });
          },
        },
      ],
    );
  };

  const detail = trpc.activity.byId.useQuery({ id: id ?? "" }, { enabled: !!id });
  const stream = trpc.activity.stream.useQuery({ id: id ?? "", maxPoints: 200 }, { enabled: !!id });
  const hrZones = trpc.activity.hrZones.useQuery({ id: id ?? "" }, { enabled: !!id });
  const points = stream.data ?? [];
  const hasPower = points.some((p) => p.power != null);
  const isCycling = detail.data != null && isCyclingActivity(detail.data.activityType);
  const powerZones = trpc.activity.powerZones.useQuery(
    { id: id ?? "" },
    { enabled: !!id && isCycling && hasPower },
  );
  const isStrengthActivity =
    detail.data != null && isStrengthActivityType(detail.data.activityType);
  const strengthExercises = trpc.activity.strengthExercises.useQuery(
    { id: id ?? "" },
    { enabled: !!id && isStrengthActivity },
  );

  const [hoveredPosition, setHoveredPosition] = useState<{ lat: number; lng: number } | null>(null);
  const [scrollEnabled, setScrollEnabled] = useState(true);

  const handleHoverIndex = useCallback(
    (index: number | null) => {
      if (index != null) {
        const point = points[index];
        if (point?.lat != null && point?.lng != null) {
          setHoveredPosition({ lat: point.lat, lng: point.lng });
          return;
        }
      }
      setHoveredPosition(null);
    },
    [points],
  );

  const handleScrubStart = useCallback(() => setScrollEnabled(false), []);
  const handleScrubEnd = useCallback(() => setScrollEnabled(true), []);

  if (detail.isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color={colors.accent} size="large" />
        <Text style={styles.loadingText}>Loading activity...</Text>
      </View>
    );
  }

  if (detail.error || !detail.data) {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorText}>Activity not found</Text>
      </View>
    );
  }

  const activity = detail.data;
  const zones = hrZones.data ?? [];

  const hasGps = points.some((p) => p.lat != null && p.lng != null);
  const hasHr = points.some((p) => p.heartRate != null);
  const hasAltitude = points.some((p) => p.altitude != null);

  const exportOptions: Array<{ label: string; format: ActivityExportFormat; disabled?: boolean }> =
    [
      { label: "GPX", format: "gpx", disabled: !hasGps },
      { label: "TCX", format: "tcx", disabled: !hasGps },
      { label: "CSV", format: "csv" },
      { label: "FIT", format: "fit" },
    ];

  const handleExport = () => {
    if (!id || !sessionToken) return;
    setExportModalVisible(true);
  };

  const handleExportFormatSelect = (format: ActivityExportFormat) => {
    if (!id || !sessionToken) return;

    setExportModalVisible(false);
    void (async () => {
      setExportingFormat(format);
      try {
        await downloadActivityExport({
          activityId: id,
          format,
          serverUrl,
          sessionToken,
        });
      } catch (error) {
        captureException(error);
        Alert.alert(
          "Export Failed",
          error instanceof Error ? error.message : "Unable to export activity.",
        );
      } finally {
        setExportingFormat(null);
      }
    })();
  };

  // Build stats array
  const stats: StatItem[] = [];

  if (activity.startedAt && activity.endedAt) {
    stats.push({
      label: "Duration",
      value: formatDurationRange(activity.startedAt, activity.endedAt),
    });
  }
  if (hasGps && activity.totalDistance != null) {
    stats.push({
      label: "Distance",
      value: `${formatNumber(units.convertDistance(activity.totalDistance / 1000))} ${units.distanceLabel}`,
    });
  }
  if (hasGps && activity.elevationGain != null) {
    stats.push({
      label: "Elevation Gain",
      value: `${Math.round(units.convertElevation(activity.elevationGain))} ${units.elevationLabel}`,
    });
  }
  if (activity.avgHr != null) {
    stats.push({
      label: "Avg Heart Rate",
      value: `${Math.round(activity.avgHr)} bpm`,
    });
  }
  if (activity.maxHr != null) {
    stats.push({
      label: "Max Heart Rate",
      value: `${Math.round(activity.maxHr)} bpm`,
    });
  }
  if (activity.avgPower != null) {
    stats.push({
      label: "Avg Power",
      value: `${Math.round(activity.avgPower)} W`,
    });
  }
  if (activity.maxPower != null) {
    stats.push({
      label: "Max Power",
      value: `${Math.round(activity.maxPower)} W`,
    });
  }
  if (hasGps && activity.avgSpeed != null) {
    stats.push({
      label: "Avg Speed",
      value: `${formatNumber(units.convertSpeed(activity.avgSpeed * 3.6))} ${units.speedLabel}`,
    });
  }
  if (activity.avgCadence != null) {
    stats.push({
      label: "Avg Cadence",
      value: `${Math.round(activity.avgCadence)} ${cadenceUnit(activity.activityType)}`,
    });
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      scrollEnabled={scrollEnabled}
    >
      {/* Activity Header */}
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Text style={styles.icon}>{activityIcon(activity.activityType)}</Text>
          <View style={styles.headerText}>
            <Text style={styles.name}>
              {activity.name ?? formatActivityTypeLabel(activity.activityType)}
            </Text>
            <View style={styles.typeBadge}>
              <Text style={styles.typeBadgeText}>
                {formatActivityTypeLabel(activity.activityType)}
              </Text>
            </View>
          </View>
        </View>
        <Text style={styles.dateTime}>
          {formatDateLong(activity.startedAt)}
          {" at "}
          {formatTimeOnly(activity.startedAt)}
        </Text>
        {(activity.sourceLinks.length > 0 || activity.sourceProviders.length > 0) && (
          <View style={styles.sourceRow}>
            <Text style={styles.source}>Source: </Text>
            {activity.sourceProviders.map((providerId: string, index: number) => {
              const link = activity.sourceLinks.find(
                (sourceLink) => sourceLink.providerId === providerId,
              );
              if (link?.providerAbsentAt) {
                return (
                  <Text key={providerId} style={styles.sourceRemoved}>
                    {index > 0 && ", "}
                    {link.label} (removed)
                  </Text>
                );
              }
              if (link?.url) {
                return (
                  <View key={providerId} style={styles.sourceLinkRow}>
                    {index > 0 && <Text style={styles.source}>, </Text>}
                    <Pressable
                      onPress={() => Linking.openURL(link.url)}
                      hitSlop={4}
                      style={styles.sourceLinkPressable}
                    >
                      <Text style={styles.sourceLink}>{link.label} ↗</Text>
                    </Pressable>
                  </View>
                );
              }
              return (
                <Text key={providerId} style={styles.source}>
                  {index > 0 && ", "}
                  {providerSourceLabel(providerId, activity.subsource)}
                </Text>
              );
            })}
          </View>
        )}
        {activity.providerAbsentAt && <ProviderAbsentBanner activity={activity} />}
      </View>

      {/* Stats Grid */}
      {stats.length > 0 && <StatsGrid stats={stats} />}

      {/* Route Map */}
      {hasGps && <RouteMap points={points} hoveredPosition={hoveredPosition} />}

      {/* Strength Exercises */}
      {(strengthExercises.data?.length ?? 0) > 0 && (
        <ExerciseBreakdown exercises={strengthExercises.data ?? []} units={units} />
      )}

      {/* Time-series charts (load progressively) */}
      {stream.isLoading ? (
        <View style={styles.chartsLoading}>
          <ActivityIndicator color={colors.accent} size="small" />
          <Text style={styles.chartsLoadingText}>Loading charts...</Text>
        </View>
      ) : (
        <>
          {/* Heart Rate Chart */}
          {hasHr && (
            <LineChart
              data={points.map((p) => ({ value: p.heartRate }))}
              color={CHART_COLORS.heartRate}
              label="Heart Rate"
              unit="bpm"
              onHoverIndex={hasGps ? handleHoverIndex : undefined}
              onScrubStart={hasGps ? handleScrubStart : undefined}
              onScrubEnd={hasGps ? handleScrubEnd : undefined}
            />
          )}

          {/* Power Chart */}
          {hasPower && (
            <LineChart
              data={points.map((p) => ({ value: p.power }))}
              color={CHART_COLORS.power}
              label="Power"
              unit="W"
              onHoverIndex={hasGps ? handleHoverIndex : undefined}
              onScrubStart={hasGps ? handleScrubStart : undefined}
              onScrubEnd={hasGps ? handleScrubEnd : undefined}
            />
          )}

          {/* Elevation Profile */}
          {hasAltitude && (
            <AreaChart
              data={points.map((p) => ({
                value: p.altitude != null ? units.convertElevation(p.altitude) : null,
              }))}
              color={CHART_COLORS.altitude}
              label="Elevation Profile"
              unit={units.elevationLabel}
              onHoverIndex={hasGps ? handleHoverIndex : undefined}
              onScrubStart={hasGps ? handleScrubStart : undefined}
              onScrubEnd={hasGps ? handleScrubEnd : undefined}
            />
          )}

          {/* HR Zones */}
          {(hasHr || zones.length > 0) && (
            <HrZonesChart
              zones={zones}
              loading={hrZones.isLoading}
              errorMessage={hrZones.error?.message}
            />
          )}

          {/* Power Zones (cycling only, requires eFTP) */}
          {isCycling && hasPower && powerZones.data != null && (
            <PowerZonesChart zones={powerZones.data.zones} />
          )}
        </>
      )}

      {/* Export Activity */}
      <Pressable
        onPress={handleExport}
        disabled={exportingFormat != null || !sessionToken}
        style={({ pressed }) => [
          styles.exportButton,
          pressed && styles.exportButtonPressed,
          (exportingFormat != null || !sessionToken) && styles.exportButtonDisabled,
        ]}
      >
        <Text style={styles.exportButtonText}>
          {exportingFormat != null
            ? `Exporting ${exportingFormat.toUpperCase()}...`
            : "Export Activity"}
        </Text>
      </Pressable>

      <Modal
        visible={exportModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setExportModalVisible(false)}
      >
        <Pressable style={styles.exportModalBackdrop} onPress={() => setExportModalVisible(false)}>
          <Pressable style={styles.exportModalCard} onPress={() => undefined}>
            <Text style={styles.exportModalTitle}>Export Activity</Text>
            <Text style={styles.exportModalSubtitle}>Choose a file format</Text>
            {exportOptions.map(({ label, format, disabled }) => (
              <Pressable
                key={format}
                disabled={disabled || exportingFormat != null}
                onPress={() => handleExportFormatSelect(format)}
                style={({ pressed }) => [
                  styles.exportModalOption,
                  pressed && !disabled && styles.exportModalOptionPressed,
                  disabled && styles.exportModalOptionDisabled,
                ]}
              >
                <Text style={styles.exportModalOptionText}>
                  {disabled ? `${label} (no GPS)` : label}
                </Text>
              </Pressable>
            ))}
            <Pressable
              onPress={() => setExportModalVisible(false)}
              style={({ pressed }) => [
                styles.exportModalCancel,
                pressed && styles.exportModalOptionPressed,
              ]}
            >
              <Text style={styles.exportModalCancelText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Delete Activity */}
      <Pressable
        onPress={handleDelete}
        disabled={deleteMutation.isPending}
        style={({ pressed }) => [
          styles.deleteButton,
          pressed && styles.deleteButtonPressed,
          deleteMutation.isPending && styles.deleteButtonDisabled,
        ]}
      >
        <Text style={styles.deleteButtonText}>
          {deleteMutation.isPending ? "Deleting..." : "Delete Activity"}
        </Text>
      </Pressable>
    </ScrollView>
  );
}
