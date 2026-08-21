import {
  formatDateLong,
  formatDurationRange,
  formatDurationSeconds,
  formatNumber,
  formatTimeOnly,
} from "@dofek/format/format";
import type { UnitConverter } from "@dofek/format/units";
import { providerSourceLabel } from "@dofek/providers/providers";
import { activityMetricColors } from "@dofek/scoring/colors";
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
import Svg, {
  Circle,
  Defs,
  Line,
  LinearGradient,
  Path,
  Polyline,
  Stop,
  Text as SvgText,
} from "react-native-svg";
import { ChartTitleWithTooltip } from "../../components/ChartTitleWithTooltip";
import { MuscleGroupBodyDiagram } from "../../components/MuscleGroupBodyDiagram";
import { RouteMap } from "../../components/RouteMap";
import { type ActivityExportFormat, downloadActivityExport } from "../../lib/activity-export";
import { useAuth } from "../../lib/auth-context";
import { captureException } from "../../lib/telemetry";
import { trpc } from "../../lib/trpc";
import { useUnitConverter } from "../../lib/units";
import { colors } from "../../theme";
import { ACTIVITY_CHART_WIDTH } from "./chartDimensions";
import { styles } from "./styles";
import { useChartScrub } from "./useChartScrub";
import { HrZonesChart, PowerZonesChart } from "./ZoneDistributionCharts";

const CHART_WIDTH = ACTIVITY_CHART_WIDTH;
const CHART_HEIGHT = 180;
const CHART_PADDING = { top: 20, right: 16, bottom: 28, left: 44 };

const CHART_COLORS = {
  heartRate: activityMetricColors.heartRate,
  power: activityMetricColors.power,
  altitude: "#6b7280",
};

const STRENGTH_ACTIVITY_TYPES = new Set(["strength", "strength_training", "functional_strength"]);

function isStrengthActivityType(activityType: string): boolean {
  return STRENGTH_ACTIVITY_TYPES.has(activityType);
}

function activityIcon(type: string): string {
  const lower = type.toLowerCase();
  if (lower.includes("run")) return "\u{1F3C3}";
  if (lower.includes("cycl") || lower.includes("bike")) return "\u{1F6B4}";
  if (lower.includes("swim")) return "\u{1F3CA}";
  if (lower.includes("walk") || lower.includes("hike")) return "\u{1F6B6}";
  if (lower.includes("strength") || lower.includes("weight")) return "\u{1F3CB}";
  if (lower.includes("yoga")) return "\u{1F9D8}";
  return "\u{26A1}";
}

// ── Inline Chart Components ──

interface LineChartProps {
  data: Array<{ value: number | null }>;
  color: string;
  label: string;
  unit: string;
  onHoverIndex?: (index: number | null) => void;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
}

function LineChart({
  data,
  color,
  label,
  unit,
  onHoverIndex,
  onScrubStart,
  onScrubEnd,
}: LineChartProps) {
  const plotWidth = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right;
  const { touchIndex, panResponder } = useChartScrub({
    plotWidth,
    totalPoints: data.length,
    onHoverIndex,
    onScrubStart,
    onScrubEnd,
  });

  const values = data
    .map((d, i) => (d.value != null ? { index: i, value: d.value } : null))
    .filter((d): d is { index: number; value: number } => d !== null);

  if (values.length < 2) return null;

  const plotHeight = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;
  const minVal = Math.min(...values.map((v) => v.value));
  const maxVal = Math.max(...values.map((v) => v.value));
  const range = maxVal - minVal || 1;
  const totalPoints = data.length;

  const toX = (index: number) =>
    CHART_PADDING.left + (index / Math.max(totalPoints - 1, 1)) * plotWidth;
  const toY = (value: number) =>
    CHART_PADDING.top + plotHeight - ((value - minVal) / range) * plotHeight;

  const chartPoints = values
    .map((v) => `${toX(v.index).toFixed(1)},${toY(v.value).toFixed(1)}`)
    .join(" ");

  // Y-axis tick labels (5 ticks)
  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const value = minVal + (range * i) / 4;
    return { value, y: toY(value) };
  });

  // Find value at the touched index for the crosshair dot
  const touchedValue = touchIndex != null ? values.find((v) => v.index === touchIndex) : null;

  return (
    <View style={chartStyles.container}>
      <ChartTitleWithTooltip
        title={label}
        description={`This chart shows how your ${label.toLowerCase()} changed over the activity timeline.`}
        textStyle={chartStyles.title}
      />
      <View {...panResponder.panHandlers}>
        <Svg width={CHART_WIDTH} height={CHART_HEIGHT}>
          {/* Grid lines */}
          {yTicks.map((tick) => (
            <Line
              key={tick.value}
              x1={CHART_PADDING.left}
              y1={tick.y}
              x2={CHART_WIDTH - CHART_PADDING.right}
              y2={tick.y}
              stroke={colors.surfaceSecondary}
              strokeWidth={0.5}
            />
          ))}
          {/* Y-axis labels */}
          {yTicks.map((tick) => (
            <SvgText
              key={`label-${tick.value}`}
              x={CHART_PADDING.left - 6}
              y={tick.y + 4}
              fill={colors.textTertiary}
              fontSize={10}
              textAnchor="end"
            >
              {Math.round(tick.value)}
            </SvgText>
          ))}
          {/* Unit label */}
          <SvgText
            x={CHART_PADDING.left - 6}
            y={CHART_PADDING.top - 8}
            fill={colors.textTertiary}
            fontSize={9}
            textAnchor="end"
          >
            {unit}
          </SvgText>
          {/* Data line */}
          <Polyline
            points={chartPoints}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* Touch crosshair */}
          {touchIndex != null && (
            <Line
              x1={toX(touchIndex)}
              y1={CHART_PADDING.top}
              x2={toX(touchIndex)}
              y2={CHART_PADDING.top + plotHeight}
              stroke={colors.textTertiary}
              strokeWidth={1}
              strokeDasharray="4,4"
            />
          )}
          {touchedValue != null && (
            <Circle
              cx={toX(touchedValue.index)}
              cy={toY(touchedValue.value)}
              r={4}
              fill={color}
              stroke="#ffffff"
              strokeWidth={2}
            />
          )}
        </Svg>
      </View>
    </View>
  );
}

interface AreaChartProps {
  data: Array<{ value: number | null }>;
  color: string;
  label: string;
  unit: string;
  onHoverIndex?: (index: number | null) => void;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
}

function AreaChart({
  data,
  color,
  label,
  unit,
  onHoverIndex,
  onScrubStart,
  onScrubEnd,
}: AreaChartProps) {
  const plotWidth = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right;
  const { touchIndex, panResponder } = useChartScrub({
    plotWidth,
    totalPoints: data.length,
    onHoverIndex,
    onScrubStart,
    onScrubEnd,
  });

  const values = data
    .map((d, i) => (d.value != null ? { index: i, value: d.value } : null))
    .filter((d): d is { index: number; value: number } => d !== null);

  if (values.length < 2) return null;

  const plotHeight = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;
  const minVal = Math.min(...values.map((v) => v.value));
  const maxVal = Math.max(...values.map((v) => v.value));
  const range = maxVal - minVal || 1;
  const totalPoints = data.length;

  const toX = (index: number) =>
    CHART_PADDING.left + (index / Math.max(totalPoints - 1, 1)) * plotWidth;
  const toY = (value: number) =>
    CHART_PADDING.top + plotHeight - ((value - minVal) / range) * plotHeight;

  const baselineY = CHART_PADDING.top + plotHeight;

  // Build path for the area fill
  const linePoints = values.map((v) => ({
    x: toX(v.index),
    y: toY(v.value),
  }));
  const firstPoint = linePoints[0];
  const lastPoint = linePoints[linePoints.length - 1];

  if (!firstPoint || !lastPoint) return null;

  const linePath = linePoints
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");

  const areaPath = `${linePath} L${lastPoint.x.toFixed(1)},${baselineY} L${firstPoint.x.toFixed(1)},${baselineY} Z`;

  // Y-axis ticks
  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const value = minVal + (range * i) / 4;
    return { value, y: toY(value) };
  });

  // Find value at the touched index for the crosshair dot
  const touchedValue = touchIndex != null ? values.find((v) => v.index === touchIndex) : null;

  return (
    <View style={chartStyles.container}>
      <ChartTitleWithTooltip
        title={label}
        description={`This chart shows how your ${label.toLowerCase()} changed over the activity timeline.`}
        textStyle={chartStyles.title}
      />
      <View {...panResponder.panHandlers}>
        <Svg width={CHART_WIDTH} height={CHART_HEIGHT}>
          <Defs>
            <LinearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={color} stopOpacity={0.3} />
              <Stop offset="1" stopColor={color} stopOpacity={0.05} />
            </LinearGradient>
          </Defs>
          {/* Grid lines */}
          {yTicks.map((tick) => (
            <Line
              key={tick.value}
              x1={CHART_PADDING.left}
              y1={tick.y}
              x2={CHART_WIDTH - CHART_PADDING.right}
              y2={tick.y}
              stroke={colors.surfaceSecondary}
              strokeWidth={0.5}
            />
          ))}
          {/* Y-axis labels */}
          {yTicks.map((tick) => (
            <SvgText
              key={`label-${tick.value}`}
              x={CHART_PADDING.left - 6}
              y={tick.y + 4}
              fill={colors.textTertiary}
              fontSize={10}
              textAnchor="end"
            >
              {Math.round(tick.value)}
            </SvgText>
          ))}
          {/* Unit label */}
          <SvgText
            x={CHART_PADDING.left - 6}
            y={CHART_PADDING.top - 8}
            fill={colors.textTertiary}
            fontSize={9}
            textAnchor="end"
          >
            {unit}
          </SvgText>
          {/* Area fill */}
          <Path d={areaPath} fill="url(#areaGrad)" />
          {/* Data line */}
          <Path
            d={linePath}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* Touch crosshair */}
          {touchIndex != null && (
            <Line
              x1={toX(touchIndex)}
              y1={CHART_PADDING.top}
              x2={toX(touchIndex)}
              y2={CHART_PADDING.top + plotHeight}
              stroke={colors.textTertiary}
              strokeWidth={1}
              strokeDasharray="4,4"
            />
          )}
          {touchedValue != null && (
            <Circle
              cx={toX(touchedValue.index)}
              cy={toY(touchedValue.value)}
              r={4}
              fill={color}
              stroke="#ffffff"
              strokeWidth={2}
            />
          )}
        </Svg>
      </View>
    </View>
  );
}

const chartStyles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    gap: 12,
  },
  title: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
});

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
  if (activity.perceivedExertion != null) {
    stats.push({
      label: "Session effort",
      value: `${activity.perceivedExertion} / 10`,
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
        {activity.providerAbsentAt && (
          <View style={styles.providerAbsentBanner}>
            <Text style={styles.providerAbsentTitle}>Removed from provider sync</Text>
            <View style={styles.providerAbsentDetails}>
              <View style={styles.providerAbsentDetail}>
                <Text style={styles.providerAbsentLabel}>Status</Text>
                <Text style={styles.providerAbsentValue}>Removed</Text>
              </View>
              <View style={styles.providerAbsentDetail}>
                <Text style={styles.providerAbsentLabel}>Provider</Text>
                <Text style={styles.providerAbsentValue}>
                  {providerSourceLabel(activity.providerId, activity.subsource)}
                </Text>
              </View>
              <View style={styles.providerAbsentDetail}>
                <Text style={styles.providerAbsentLabel}>Removed at</Text>
                <Text style={styles.providerAbsentValue}>
                  {formatDateLong(activity.providerAbsentAt)}
                </Text>
              </View>
            </View>
          </View>
        )}
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
