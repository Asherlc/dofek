import { formatDurationRange, formatNumber } from "@dofek/format/format";
import type { UnitConverter } from "@dofek/format/units";
import { providerLabel } from "@dofek/providers/providers";
import { activityMetricColors, statusColors } from "@dofek/scoring/colors";
import type { MuscleGroupInput } from "@dofek/training/muscle-groups";
import { formatActivityTypeLabel } from "@dofek/training/training";
import { HEART_RATE_ZONE_COLORS } from "@dofek/zones/zones";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Svg, {
  Defs,
  G,
  Line,
  LinearGradient,
  Path,
  Polyline,
  Rect,
  Stop,
  Text as SvgText,
} from "react-native-svg";
import { ChartTitleWithTooltip } from "../../components/ChartTitleWithTooltip";
import { MuscleGroupBodyDiagram } from "../../components/MuscleGroupBodyDiagram";
import { trpc } from "../../lib/trpc";
import { useUnitConverter } from "../../lib/units";
import { colors } from "../../theme";

const CHART_WIDTH = 340;
const CHART_HEIGHT = 180;
const CHART_PADDING = { top: 20, right: 16, bottom: 28, left: 44 };

const CHART_COLORS = {
  heartRate: activityMetricColors.heartRate,
  power: activityMetricColors.power,
  altitude: "#6b7280",
};

// ── Helpers ──

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatTimeOfDay(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
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
}

function LineChart({ data, color, label, unit }: LineChartProps) {
  const values = data
    .map((d, i) => (d.value != null ? { index: i, value: d.value } : null))
    .filter((d): d is { index: number; value: number } => d !== null);

  if (values.length < 2) return null;

  const plotWidth = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right;
  const plotHeight = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;

  const minVal = Math.min(...values.map((v) => v.value));
  const maxVal = Math.max(...values.map((v) => v.value));
  const range = maxVal - minVal || 1;
  const totalPoints = data.length;

  const toX = (index: number) =>
    CHART_PADDING.left + (index / Math.max(totalPoints - 1, 1)) * plotWidth;
  const toY = (value: number) =>
    CHART_PADDING.top + plotHeight - ((value - minVal) / range) * plotHeight;

  const points = values
    .map((v) => `${toX(v.index).toFixed(1)},${toY(v.value).toFixed(1)}`)
    .join(" ");

  // Y-axis tick labels (5 ticks)
  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const value = minVal + (range * i) / 4;
    return { value, y: toY(value) };
  });

  return (
    <View style={chartStyles.container}>
      <ChartTitleWithTooltip
        title={label}
        description={`This chart shows how your ${label.toLowerCase()} changed over the activity timeline.`}
        textStyle={chartStyles.title}
      />
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
          points={points}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    </View>
  );
}

interface AreaChartProps {
  data: Array<{ value: number | null }>;
  color: string;
  label: string;
  unit: string;
}

function AreaChart({ data, color, label, unit }: AreaChartProps) {
  const values = data
    .map((d, i) => (d.value != null ? { index: i, value: d.value } : null))
    .filter((d): d is { index: number; value: number } => d !== null);

  if (values.length < 2) return null;

  const plotWidth = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right;
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

  return (
    <View style={chartStyles.container}>
      <ChartTitleWithTooltip
        title={label}
        description={`This chart shows how your ${label.toLowerCase()} changed over the activity timeline.`}
        textStyle={chartStyles.title}
      />
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
      </Svg>
    </View>
  );
}

interface HrZone {
  zone: number;
  label: string;
  minPct: number;
  maxPct: number;
  seconds: number;
}

function HrZonesChart({ zones }: { zones: HrZone[] }) {
  const totalSeconds = zones.reduce((sum, z) => sum + z.seconds, 0);
  if (totalSeconds === 0) return null;

  const barHeight = 24;
  const gap = 8;
  const labelWidth = 80;
  const pctWidth = 44;
  const barAreaWidth = CHART_WIDTH - labelWidth - pctWidth - 16;
  const chartTotalHeight = zones.length * (barHeight + gap) - gap;

  return (
    <View style={chartStyles.container}>
      <ChartTitleWithTooltip
        title="Heart Rate Zones"
        description="This chart shows how much time you spent in each heart rate zone during the activity."
        textStyle={chartStyles.title}
      />
      <Svg width={CHART_WIDTH} height={chartTotalHeight + 8}>
        {zones.map((zone, i) => {
          const percentage = totalSeconds > 0 ? zone.seconds / totalSeconds : 0;
          const barWidth = Math.max(percentage * barAreaWidth, 2);
          const rowY = i * (barHeight + gap);
          const zoneColor = HEART_RATE_ZONE_COLORS[i] ?? "#71717a";

          return (
            <G key={zone.zone}>
              {/* Zone label */}
              <SvgText x={0} y={rowY + barHeight / 2 + 4} fill={colors.textSecondary} fontSize={11}>
                {`Z${zone.zone} ${zone.label}`}
              </SvgText>
              {/* Bar background */}
              <Rect
                x={labelWidth}
                y={rowY}
                width={barAreaWidth}
                height={barHeight}
                rx={4}
                fill={colors.surfaceSecondary}
              />
              {/* Bar fill */}
              <Rect
                x={labelWidth}
                y={rowY}
                width={barWidth}
                height={barHeight}
                rx={4}
                fill={zoneColor}
              />
              {/* Percentage label */}
              <SvgText
                x={labelWidth + barAreaWidth + 8}
                y={rowY + barHeight / 2 + 4}
                fill={colors.text}
                fontSize={12}
                fontWeight="600"
              >
                {`${Math.round(percentage * 100)}%`}
              </SvgText>
            </G>
          );
        })}
      </Svg>
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
                  <Text style={exerciseStyles.setValue}>{set.durationSeconds}s</Text>
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
  const trpcUtils = trpc.useUtils();
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
  const strengthExercises = trpc.activity.strengthExercises.useQuery(
    { id: id ?? "" },
    { enabled: !!id },
  );

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
  const points = stream.data ?? [];
  const zones = hrZones.data ?? [];

  const hasHr = points.some((p) => p.heartRate != null);
  const hasPower = points.some((p) => p.power != null);
  const hasAltitude = points.some((p) => p.altitude != null);

  // Build stats array
  const stats: StatItem[] = [];

  if (activity.startedAt && activity.endedAt) {
    stats.push({
      label: "Duration",
      value: formatDurationRange(activity.startedAt, activity.endedAt),
    });
  }
  if (activity.totalDistance != null) {
    stats.push({
      label: "Distance",
      value: `${formatNumber(units.convertDistance(activity.totalDistance / 1000))} ${units.distanceLabel}`,
    });
  }
  if (activity.elevationGain != null) {
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
  if (activity.avgSpeed != null) {
    stats.push({
      label: "Avg Speed",
      value: `${formatNumber(units.convertSpeed(activity.avgSpeed * 3.6))} ${units.speedLabel}`,
    });
  }
  if (activity.avgCadence != null) {
    stats.push({
      label: "Avg Cadence",
      value: `${Math.round(activity.avgCadence)} rpm`,
    });
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
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
          {formatDateTime(activity.startedAt)}
          {" at "}
          {formatTimeOfDay(activity.startedAt)}
        </Text>
        {(activity.sourceLinks.length > 0 || activity.sourceProviders.length > 0) && (
          <View style={styles.sourceRow}>
            <Text style={styles.source}>Source: </Text>
            {activity.sourceProviders.map((providerId: string, index: number) => {
              const link = activity.sourceLinks.find(
                (sourceLink) => sourceLink.providerId === providerId,
              );
              if (link) {
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
                  {providerLabel(providerId)}
                </Text>
              );
            })}
          </View>
        )}
      </View>

      {/* Stats Grid */}
      {stats.length > 0 && <StatsGrid stats={stats} />}

      {/* Strength Exercises */}
      {(strengthExercises.data?.length ?? 0) > 0 && (
        <ExerciseBreakdown exercises={strengthExercises.data ?? []} units={units} />
      )}

      {/* Heart Rate Chart */}
      {hasHr && (
        <LineChart
          data={points.map((p) => ({ value: p.heartRate }))}
          color={CHART_COLORS.heartRate}
          label="Heart Rate"
          unit="bpm"
        />
      )}

      {/* Power Chart */}
      {hasPower && (
        <LineChart
          data={points.map((p) => ({ value: p.power }))}
          color={CHART_COLORS.power}
          label="Power"
          unit="W"
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
        />
      )}

      {/* HR Zones */}
      {zones.length > 0 && <HrZonesChart zones={zones} />}

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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: 16,
    paddingBottom: 100,
    gap: 16,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  loadingText: {
    fontSize: 16,
    color: colors.textTertiary,
  },
  errorContainer: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
  },
  errorText: {
    fontSize: 16,
    color: colors.textSecondary,
  },
  header: {
    gap: 8,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  icon: {
    fontSize: 32,
  },
  headerText: {
    flex: 1,
    gap: 6,
  },
  name: {
    fontSize: 22,
    fontWeight: "700",
    color: colors.text,
  },
  typeBadge: {
    alignSelf: "flex-start",
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  typeBadgeText: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "capitalize",
  },
  dateTime: {
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: 4,
  },
  sourceRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    marginTop: 2,
  },
  source: {
    fontSize: 12,
    color: colors.textTertiary,
  },
  sourceLinkRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  sourceLinkPressable: {
    paddingVertical: 2,
    paddingHorizontal: 4,
    borderRadius: 4,
  },
  sourceLink: {
    fontSize: 12,
    color: colors.accent,
    textDecorationLine: "underline",
  },
  deleteButton: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 14,
    alignItems: "center",
    marginTop: 8,
  },
  deleteButtonPressed: {
    opacity: 0.7,
  },
  deleteButtonDisabled: {
    opacity: 0.5,
  },
  deleteButtonText: {
    fontSize: 14,
    fontWeight: "600",
    color: statusColors.danger,
  },
});
