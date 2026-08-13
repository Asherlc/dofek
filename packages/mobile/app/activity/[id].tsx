import {
  type ActivityMetric,
  activityDataStateLabel,
  formatActivityMetric,
} from "@dofek/format/activity-data-state";
import {
  formatClimbingAttemptResult,
  formatDateLong,
  formatDurationRange,
  formatDurationSeconds,
  formatNumber,
} from "@dofek/format/format";
import { formatRecordLocalTime } from "@dofek/format/record-local-time";
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
import { ActivityPerceivedExertion } from "../../components/ActivityPerceivedExertion";
import { ChartTitleWithTooltip } from "../../components/ChartTitleWithTooltip";
import { HangboardingDetail } from "../../components/HangboardingDetail";
import { MuscleGroupBodyDiagram } from "../../components/MuscleGroupBodyDiagram";
import { RouteMap } from "../../components/RouteMap";
import { type ActivityExportFormat, downloadActivityExport } from "../../lib/activity-export";
import { useAuth } from "../../lib/auth-context";
import { captureException } from "../../lib/telemetry";
import { trpc } from "../../lib/trpc";
import { useUnitConverter } from "../../lib/units";
import { colors } from "../../theme";
import { AreaChart, CHART_COLORS, chartStyles, LineChart } from "./ActivityDetailCharts";
import { ActivitySourceDecisionCard } from "./ActivitySourceDecisionCard";
import { ProviderAbsentBanner } from "./ProviderAbsentBanner";
import { styles } from "./styles";
import { HrZonesChart, PowerZonesChart } from "./ZoneDistributionCharts";

function isStrengthActivityType(activityType: string): boolean {
  return activityType === "strength";
}

function isClimbingActivityType(activityType: string): boolean {
  return activityType === "climbing";
}

function isHangboardingActivityType(activityType: string): boolean {
  return activityType === "hangboard";
}

function activityIcon(type: string): string {
  return getActivityIconInfo(type).emoji;
}

interface ActivitySourceLink {
  providerId: string;
  externalId: string;
  subsource: string | null;
  label: string;
  url: string | null;
  providerAbsentAt?: string | null;
  memberActivityId?: string | null;
}

interface ActivitySourceSummary {
  sourceProviders: string[];
  sourceLinks: ActivitySourceLink[];
  subsource?: string | null;
}

function ActivitySourceLinks({ activity }: { activity: ActivitySourceSummary }) {
  if (activity.sourceLinks.length > 0) {
    return (
      <>
        {activity.sourceLinks.map((link, index) => (
          <ActivitySourceLinkLabel
            key={`${link.providerId}:${link.externalId}:${link.memberActivityId ?? ""}`}
            link={link}
            prefix={index > 0 ? ", " : ""}
          />
        ))}
      </>
    );
  }

  return (
    <>
      {activity.sourceProviders.map((providerId, index) => (
        <Text key={providerId} style={styles.source}>
          {index > 0 && ", "}
          {providerSourceLabel(providerId, activity.subsource)}
        </Text>
      ))}
    </>
  );
}

function ActivitySourceLinkLabel({ link, prefix }: { link: ActivitySourceLink; prefix: string }) {
  if (link.providerAbsentAt) {
    return (
      <Text style={styles.sourceRemoved}>
        {prefix}
        {link.label} (removed)
      </Text>
    );
  }

  if (link.url) {
    const sourceUrl = link.url;
    return (
      <View style={styles.sourceLinkRow}>
        {prefix && <Text style={styles.source}>{prefix}</Text>}
        <Pressable
          onPress={() => {
            void Linking.openURL(sourceUrl);
          }}
          hitSlop={4}
          style={styles.sourceLinkPressable}
          accessibilityRole="link"
          accessibilityLabel={`Open ${link.label}`}
        >
          <Text style={styles.sourceLink}>{link.label} ↗</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <Text style={styles.source}>
      {prefix}
      {link.label}
    </Text>
  );
}

// ── Stats Grid ──

type StatItem = ActivityMetric | { label: string; value: string };

function StatsGrid({ stats }: { stats: StatItem[] }) {
  return (
    <View style={statsStyles.grid}>
      {stats.map((stat) => {
        const metric = "status" in stat ? stat : null;
        const unavailableMetric = metric && metric.status !== "available" ? metric : null;
        const isUnavailable = unavailableMetric !== null;
        const accessibleLabel = unavailableMetric
          ? `${unavailableMetric.label} ${activityDataStateLabel(unavailableMetric.status)}: ${unavailableMetric.reason}`
          : undefined;
        const displayedValue = unavailableMetric?.reason ?? ("value" in stat ? stat.value : null);
        return (
          <View
            key={stat.label}
            style={statsStyles.card}
            accessible={isUnavailable}
            accessibilityLabel={accessibleLabel}
          >
            <Text style={statsStyles.label}>
              {unavailableMetric
                ? `${unavailableMetric.label} ${activityDataStateLabel(unavailableMetric.status)}`
                : stat.label}
            </Text>
            <Text style={statsStyles.value}>{displayedValue}</Text>
          </View>
        );
      })}
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

interface ClimbingEntry {
  id: string;
  climbType: "boulder" | "route";
  grade: string;
  sent: boolean;
  attemptCount: number;
  attempts: Array<{
    attemptIndex: number;
    failureReason: "fell" | "pumped" | "skin" | "technique" | "fear" | null;
    notes: string | null;
    outcome: "sent" | "failed";
  }>;
  ascentType: "Flash" | "Onsight" | "Redpoint" | "Repeat" | null;
  holdType: "crimp" | "sloper" | "pinch" | "pocket" | "jug" | null;
  routeName: string | null;
  locationName: string | null;
  sourceName: string;
  wallAngleDegrees: number | null;
}

function ClimbingEntryBreakdown({ entries }: { entries: ClimbingEntry[] }) {
  return (
    <View style={climbingStyles.container}>
      <ChartTitleWithTooltip
        title="Climbs"
        description="The climbs recorded during this session, including grades and send status."
        textStyle={chartStyles.title}
      />
      {entries.map((entry) => (
        <View key={entry.id} style={climbingStyles.entryRow}>
          <View style={climbingStyles.gradeBadge}>
            <Text style={climbingStyles.gradeText}>{entry.grade}</Text>
          </View>
          <View style={climbingStyles.entryDetails}>
            <Text style={climbingStyles.routeName}>
              {entry.routeName ?? (entry.climbType === "boulder" ? "Boulder" : "Route")}
            </Text>
            {entry.locationName && (
              <Text style={climbingStyles.locationName}>{entry.locationName}</Text>
            )}
            {(entry.wallAngleDegrees !== null || entry.holdType !== null) && (
              <Text style={climbingStyles.locationName}>
                {[
                  entry.wallAngleDegrees === null ? null : `${entry.wallAngleDegrees}°`,
                  entry.holdType === null
                    ? null
                    : `${entry.holdType[0]?.toUpperCase()}${entry.holdType.slice(1)}`,
                ]
                  .filter((value) => value !== null)
                  .join(" · ")}
              </Text>
            )}
            {entry.attempts.map((attempt) => (
              <Text key={attempt.attemptIndex} style={climbingStyles.attemptDetail}>
                {attempt.attemptIndex}:{" "}
                {attempt.outcome === "sent"
                  ? "Sent"
                  : `${attempt.failureReason?.[0]?.toUpperCase()}${attempt.failureReason?.slice(1)}`}
              </Text>
            ))}
          </View>
          <View style={climbingStyles.resultDetails}>
            {entry.ascentType && <Text style={climbingStyles.sent}>{entry.ascentType}</Text>}
            <Text style={entry.sent ? climbingStyles.sent : climbingStyles.attempted}>
              {formatClimbingAttemptResult(entry.sent, entry.attemptCount)}
            </Text>
            <Text style={climbingStyles.sourceName}>{entry.sourceName}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

const climbingStyles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    gap: 12,
  },
  entryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 4,
  },
  gradeBadge: {
    minWidth: 48,
    borderRadius: 8,
    backgroundColor: colors.surfaceSecondary,
    paddingHorizontal: 8,
    paddingVertical: 6,
    alignItems: "center",
  },
  gradeText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: "700",
  },
  entryDetails: {
    flex: 1,
  },
  routeName: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
  locationName: {
    color: colors.textTertiary,
    fontSize: 11,
  },
  resultDetails: {
    alignItems: "flex-end",
  },
  sent: {
    color: colors.positive,
    fontSize: 13,
    fontWeight: "600",
  },
  attempted: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "600",
  },
  attemptDetail: {
    color: colors.textSecondary,
    fontSize: 11,
  },
  sourceName: {
    color: colors.textTertiary,
    fontSize: 10,
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
  const [isRecomputing, setIsRecomputing] = useState(false);
  const deleteMutation = trpc.activity.delete.useMutation({
    onSuccess: async () => {
      if (id) {
        await trpcUtils.activity.hangboardDetails.invalidate({ id });
      }
      await trpcUtils.activity.list.invalidate();
      router.back();
    },
  });
  const recomputeMutation = trpc.activity.recompute.useMutation({
    onSuccess: async () => {
      if (!id) {
        return;
      }
      setIsRecomputing(true);
      try {
        await Promise.all([
          trpcUtils.activity.byId.invalidate({ id }),
          trpcUtils.activity.stream.invalidate({ id, maxPoints: 200 }),
          trpcUtils.activity.hrZones.invalidate({ id }),
          trpcUtils.activity.powerZones.invalidate({ id }),
          trpcUtils.activity.strengthExercises.invalidate({ id }),
          trpcUtils.activity.hangboardDetails.invalidate({ id }),
          trpcUtils.activity.list.invalidate(),
          trpcUtils.calendar.weekList.invalidate(),
          trpcUtils.calendar.activityOverview.invalidate(),
        ]);
      } finally {
        setIsRecomputing(false);
      }
    },
    onError: (error) => {
      setIsRecomputing(false);
      captureException(error);
      Alert.alert(
        "Recompute Failed",
        error instanceof Error ? error.message : "Unable to recompute activity.",
      );
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
  const stream = trpc.activity.stream.useQuery(
    { id: id ?? "", maxPoints: 200 },
    { enabled: !!id, placeholderData: (previousData) => previousData },
  );
  const hrZones = trpc.activity.hrZones.useQuery(
    { id: id ?? "" },
    { enabled: !!id, placeholderData: (previousData) => previousData },
  );
  const points = stream.data ?? [];
  const hasPower = points.some((p) => p.power != null);
  const isCycling = detail.data != null && isCyclingActivity(detail.data.activityType);
  const powerZones = trpc.activity.powerZones.useQuery(
    { id: id ?? "" },
    {
      enabled: !!id && isCycling && hasPower,
      placeholderData: (previousData) => previousData,
    },
  );
  const isStrengthActivity =
    detail.data != null && isStrengthActivityType(detail.data.activityType);
  const strengthExercises = trpc.activity.strengthExercises.useQuery(
    { id: id ?? "" },
    { enabled: !!id && isStrengthActivity },
  );
  const isClimbingActivity =
    detail.data != null && isClimbingActivityType(detail.data.activityType);
  const climbingEntries = trpc.climbing.activityEntries.useQuery(
    { id: id ?? "" },
    { enabled: !!id && isClimbingActivity },
  );
  const isHangboardingActivity =
    detail.data != null && isHangboardingActivityType(detail.data.activityType);
  const hangboardDetails = trpc.activity.hangboardDetails.useQuery(
    { id: id ?? "" },
    { enabled: !!id && isHangboardingActivity },
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
        <Text style={styles.errorText}>{detail.error?.message ?? "Activity not found"}</Text>
      </View>
    );
  }

  const activity = detail.data;
  const zones = hrZones.data ?? [];

  const hasGps = points.some((p) => p.lat != null && p.lng != null);
  const hasHr = points.some((p) => p.heartRate != null);
  const hasAltitude = points.some((p) => p.altitude != null);

  const exportOptions: Array<{
    accessibilityLabel: string;
    label: string;
    format: ActivityExportFormat;
    disabled?: boolean;
  }> = [
    {
      accessibilityLabel: "GPS track (GPX)",
      label: "GPX",
      format: "gpx",
      disabled: !hasGps,
    },
    {
      accessibilityLabel: "Training Center data (TCX)",
      label: "TCX",
      format: "tcx",
      disabled: !hasGps,
    },
    {
      accessibilityLabel: "comma-separated values (CSV)",
      label: "CSV",
      format: "csv",
    },
    {
      accessibilityLabel: "fitness activity file (FIT)",
      label: "FIT",
      format: "fit",
    },
  ];

  const handleExport = () => {
    if (!id || !sessionToken) return;
    setExportModalVisible(true);
  };

  const handleRecompute = () => {
    if (!id) return;
    recomputeMutation.mutate({ id });
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
  stats.push(
    formatActivityMetric(
      "Distance",
      activity.totalDistance,
      activity.totalDistanceState,
      (distanceMeters) =>
        `${formatNumber(units.convertDistance(distanceMeters / 1000))} ${units.distanceLabel}`,
    ),
    formatActivityMetric(
      "Elevation Gain",
      activity.elevationGain,
      activity.elevationGainState,
      (elevationMeters) =>
        `${Math.round(units.convertElevation(elevationMeters))} ${units.elevationLabel}`,
    ),
    formatActivityMetric(
      "Avg Heart Rate",
      activity.avgHr,
      activity.avgHrState,
      (value) => `${Math.round(value)} bpm`,
    ),
    formatActivityMetric(
      "Max Heart Rate",
      activity.maxHr,
      activity.maxHrState,
      (value) => `${Math.round(value)} bpm`,
    ),
    formatActivityMetric(
      "Avg Power",
      activity.avgPower,
      activity.avgPowerState,
      (value) => `${Math.round(value)} W`,
    ),
    formatActivityMetric(
      "Max Power",
      activity.maxPower,
      activity.maxPowerState,
      (value) => `${Math.round(value)} W`,
    ),
    formatActivityMetric(
      "Avg Speed",
      activity.avgSpeed,
      activity.avgSpeedState,
      (value) => `${formatNumber(units.convertSpeed(value * 3.6))} ${units.speedLabel}`,
    ),
    formatActivityMetric(
      "Avg Cadence",
      activity.avgCadence,
      activity.avgCadenceState,
      (value) => `${Math.round(value)} ${cadenceUnit(activity.activityType)}`,
    ),
  );

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
          {formatRecordLocalTime(activity.startedAt, activity.localTimeContext, "start") === "--"
            ? "Local time unavailable"
            : formatRecordLocalTime(activity.startedAt, activity.localTimeContext, "start")}
        </Text>
        {(activity.sourceLinks.length > 0 || activity.sourceProviders.length > 0) && (
          <View style={styles.sourceRow}>
            <Text style={styles.source}>Source: </Text>
            <ActivitySourceLinks activity={activity} />
          </View>
        )}
        {activity.providerAbsentAt && <ProviderAbsentBanner activity={activity} />}
        {activity.sourceDecision ? (
          <ActivitySourceDecisionCard decision={activity.sourceDecision} />
        ) : null}
      </View>

      {/* Stats Grid */}
      {stats.length > 0 && <StatsGrid stats={stats} />}
      <ActivityPerceivedExertion value={activity.perceivedExertion} />

      {isHangboardingActivity && (
        <View style={hangboardingStyles.container}>
          <Text style={hangboardingStyles.title}>Hangboarding</Text>
          <HangboardingDetail
            data={hangboardDetails.data}
            loading={hangboardDetails.isLoading}
            error={hangboardDetails.error ?? null}
          />
        </View>
      )}

      {isHangboardingActivity && (
        <View style={hangboardingStyles.container}>
          <Text style={hangboardingStyles.title}>Hangboarding</Text>
          <HangboardingDetail
            data={hangboardDetails.data}
            loading={hangboardDetails.isLoading}
            error={hangboardDetails.error ?? null}
          />
        </View>
      )}

      {/* Route Map */}
      {hasGps && <RouteMap points={points} hoveredPosition={hoveredPosition} />}

      {/* Strength Exercises */}
      {(strengthExercises.data?.length ?? 0) > 0 && (
        <ExerciseBreakdown exercises={strengthExercises.data ?? []} units={units} />
      )}

      {isClimbingActivity && climbingEntries.error && (
        <View style={climbingStyles.container}>
          <Text style={styles.errorText}>{climbingEntries.error.message}</Text>
        </View>
      )}
      {(climbingEntries.data?.length ?? 0) > 0 && (
        <ClimbingEntryBreakdown entries={climbingEntries.data ?? []} />
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
        onPress={handleRecompute}
        disabled={recomputeMutation.isPending || isRecomputing}
        accessibilityRole="button"
        accessibilityLabel="Recompute activity"
        accessibilityState={{
          busy: recomputeMutation.isPending || isRecomputing,
          disabled: recomputeMutation.isPending || isRecomputing,
        }}
        style={({ pressed }) => [
          styles.recomputeButton,
          pressed && styles.recomputeButtonPressed,
          (recomputeMutation.isPending || isRecomputing) && styles.recomputeButtonDisabled,
        ]}
      >
        <Text style={styles.recomputeButtonText}>
          {recomputeMutation.isPending || isRecomputing ? "Recomputing..." : "Recompute"}
        </Text>
      </Pressable>

      <Pressable
        onPress={handleExport}
        disabled={exportingFormat != null || !sessionToken}
        accessibilityRole="button"
        accessibilityLabel="Export Activity"
        accessibilityState={{
          busy: exportingFormat != null,
          disabled: exportingFormat != null || !sessionToken,
        }}
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
        <Pressable
          style={styles.exportModalBackdrop}
          onPress={() => setExportModalVisible(false)}
          accessible={false}
        >
          <Pressable style={styles.exportModalCard} onPress={() => undefined} accessible={false}>
            <Text style={styles.exportModalTitle}>Export Activity</Text>
            <Text style={styles.exportModalSubtitle}>Choose a file format</Text>
            {exportOptions.map(({ accessibilityLabel, label, format, disabled }) => (
              <Pressable
                key={format}
                disabled={disabled || exportingFormat != null}
                onPress={() => handleExportFormatSelect(format)}
                accessibilityRole="button"
                accessibilityLabel={`Export as ${accessibilityLabel}`}
                accessibilityState={{
                  busy: exportingFormat === format,
                  disabled: disabled || exportingFormat != null,
                }}
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
              accessibilityRole="button"
              accessibilityLabel="Cancel export"
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
        accessibilityRole="button"
        accessibilityLabel="Delete Activity"
        accessibilityState={{
          busy: deleteMutation.isPending,
          disabled: deleteMutation.isPending,
        }}
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

const hangboardingStyles = StyleSheet.create({
  container: { gap: 12 },
  title: { color: colors.text, fontSize: 18, fontWeight: "700" },
});
