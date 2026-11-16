import {
  type ActivityMetric,
  activityDataStateLabel,
  formatActivityMetric,
  groupActivityMetrics,
} from "@dofek/format/activity-data-state";
import { formatDurationMinutes, formatDurationSeconds, formatNumber } from "@dofek/format/format";
import type { UnitConverter } from "@dofek/format/units";
import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import { processingPollInterval } from "@dofek/providers/processing-status";
import { ACTIVITY_IMAGES_QUERY_OPTIONS } from "@dofek/training/activity-images";
import { isIndoorCyclingModality } from "@dofek/training/endurance-types";
import type { MuscleGroupInput } from "@dofek/training/muscle-groups";
import { cadenceUnit, isActivityDetailType, isCyclingActivity } from "@dofek/training/training";
import { useLocalSearchParams, useRouter } from "expo-router";
import { type ComponentProps, useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { ActivityClimbingPanel } from "../../components/ActivityClimbingPanel";
import { ActivityPerceivedExertion } from "../../components/ActivityPerceivedExertion";
import { ActivityMetricsCharts, chartStyles } from "../../components/activity/ActivityDetailCharts";
import { ActivityDetailHeader } from "../../components/activity/ActivityDetailHeader";
import { RecomputeActivityButton } from "../../components/activity/RecomputeActivityButton";
import { statsStyles, styles } from "../../components/activity/styles";
import { useActivityClimbing } from "../../components/activity/useActivityClimbing";
import { useActivityMapHover } from "../../components/activity/useActivityMapHover";
import { useActivityMetrics } from "../../components/activity/useActivityMetrics";
import { HrZonesChart, PowerZonesChart } from "../../components/activity/ZoneDistributionCharts";
import { CyclingThresholdDetails } from "../../components/CyclingThresholdDetails";
import { HangboardingDetail } from "../../components/HangboardingDetail";
import { MapProcessingState } from "../../components/MapProcessingState";
import { MuscleGroupBodyDiagram } from "../../components/MuscleGroupBodyDiagram";
import { ProviderRecordDetailModal } from "../../components/providers/provider-record-detail-modal";
import { getQueryErrorMessage, QueryStatePanel } from "../../components/QueryStatePanel";
import { RouteMap } from "../../components/RouteMap";
import { UnattachedClimbingLogEntries } from "../../components/UnattachedClimbingLogEntries";
import { type ActivityExportFormat, downloadActivityExport } from "../../lib/activity-export";
import { useAuth } from "../../lib/auth-context";
import { captureException } from "../../lib/telemetry";
import { trpc } from "../../lib/trpc";
import { useUnitConverter } from "../../lib/units";
import { colors } from "../../theme";

const EMPTY_ROUTE_POINTS: ComponentProps<typeof RouteMap>["points"] = [];

// ── Stats Grid ──

type StatItem =
  | ActivityMetric
  | { label: string; value: string; qualifier?: string; attribution?: string };

function StatsGrid({ stats }: { stats: StatItem[] }) {
  return (
    <View style={statsStyles.grid}>
      {groupActivityMetrics(stats).map(({ primary: stat, secondary }) => {
        const metric = "status" in stat ? stat : null;
        const unavailableMetric = metric && metric.status !== "available" ? metric : null;
        const isUnavailable = unavailableMetric !== null;
        const accessibleLabel = unavailableMetric
          ? [
              `${unavailableMetric.label} ${activityDataStateLabel(unavailableMetric.status)}: ${unavailableMetric.reason}`,
              secondary
                ? "value" in secondary
                  ? `${secondary.label}: ${secondary.value}`
                  : `${secondary.label} ${activityDataStateLabel(secondary.status)}: ${secondary.reason}`
                : null,
            ]
              .filter(Boolean)
              .join(". ")
          : undefined;
        const displayedValue = unavailableMetric?.reason ?? ("value" in stat ? stat.value : null);
        return (
          <View
            key={stat.label}
            style={statsStyles.card}
            accessible={isUnavailable || accessibleLabel !== undefined}
            accessibilityLabel={accessibleLabel}
          >
            <Text style={statsStyles.label}>
              {unavailableMetric
                ? `${unavailableMetric.label} ${activityDataStateLabel(unavailableMetric.status)}`
                : stat.label}
            </Text>
            <Text style={statsStyles.value}>{displayedValue}</Text>
            {secondary && (
              <Text style={statsStyles.secondary}>
                {"value" in secondary
                  ? `Max ${secondary.value}`
                  : `${secondary.label} ${activityDataStateLabel(secondary.status)}: ${secondary.reason}`}
              </Text>
            )}
            {"qualifier" in stat && stat.qualifier && (
              <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 4 }}>
                {stat.qualifier}
              </Text>
            )}
            {"attribution" in stat && stat.attribution && (
              <Text
                accessibilityLiveRegion="polite"
                style={{ color: colors.textSecondary, fontSize: 12, marginTop: 4 }}
              >
                {stat.attribution}
              </Text>
            )}
          </View>
        );
      })}
    </View>
  );
}

// ── Strength Exercise Breakdown ──

interface StrengthExercise {
  activityId: string;
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
      <Text style={chartStyles.title}>Exercises</Text>
      {muscleGroupData.length > 0 && <MuscleGroupBodyDiagram data={muscleGroupData} />}
      {exercises.map((exercise) => {
        const hasWeight = exercise.sets.some((set) => set.weightKg != null);
        const hasDuration = exercise.sets.some((set) => set.durationSeconds != null);

        return (
          <View
            key={`${exercise.activityId}:${exercise.exerciseIndex}`}
            style={exerciseStyles.exerciseCard}
          >
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

const climbingStyles = StyleSheet.create({
  container: { backgroundColor: colors.surface, borderRadius: 16, padding: 16, gap: 12 },
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
      if (id) {
        await trpcUtils.activity.hangboardDetails.invalidate({ id });
      }
      await Promise.all([
        trpcUtils.activity.list.invalidate(),
        trpcUtils.calendar.weekListV2.invalidate(),
        trpcUtils.calendar.activityOverview.invalidate(),
        trpcUtils.calendar.calendarData.invalidate(),
      ]);
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
  const images = trpc.activity.images.useQuery(
    { id: id ?? "" },
    { ...ACTIVITY_IMAGES_QUERY_OPTIONS, enabled: !!id },
  );
  const hardware = trpc.activity.hardware.useQuery({ id: id ?? "" }, { enabled: !!id });
  const isCycling = detail.data != null && isCyclingActivity(detail.data.activityType);
  const isClimbingActivity =
    detail.data != null && isActivityDetailType(detail.data.activityType, "climbing");
  const metrics = useActivityMetrics(id, { isCycling, isClimbing: isClimbingActivity });
  const {
    metricSources,
    sourceControls,
    stream,
    hrZones,
    points,
    hasPower,
    powerWork,
    powerZones,
    heartRateContext,
  } = metrics;
  const route = trpc.activity.route.useQuery(
    { id: id ?? "", maxPoints: 200 },
    {
      enabled: !!id,
      refetchInterval: (query) =>
        query.state.data?.status === "processing" ? processingPollInterval("active") : false,
    },
  );
  const isStrengthActivity =
    detail.data != null && isActivityDetailType(detail.data.activityType, "strength");
  const strengthExercises = trpc.activity.strengthExercises.useQuery(
    { id: id ?? "" },
    { enabled: !!id && isStrengthActivity },
  );
  const climbing = useActivityClimbing(id, isClimbingActivity);
  const climbingEntries = climbing.entries;
  const entrySuggestions = climbing.suggestions;
  const climbingEntriesLoading = climbing.loading;
  const selectedClimbingEntryId = climbing.selectedEntryId;
  const setSelectedClimbingEntryId = climbing.setSelectedEntryId;
  const [highlightedClimbId, setHighlightedClimbId] = useState<string | null>(null);
  const selectedClimbingEntry = climbing.selectedEntry;
  const climbingLocations = climbing.locations;
  const climbMarkers = climbing.markers;
  const entryAttachState = climbing.attachmentStates;
  const handleAttachEntry = climbing.attachEntry;
  const isHangboardingActivity =
    detail.data != null && isActivityDetailType(detail.data.activityType, "hangboard");
  const hangboardDetails = trpc.activity.hangboardDetails.useQuery(
    { id: id ?? "" },
    { enabled: !!id && isHangboardingActivity },
  );

  const {
    hoveredPosition,
    handleHoverIndex,
    handleHoverTime: handleHeartRateHoverTime,
  } = useActivityMapHover(points);
  const [scrollEnabled, setScrollEnabled] = useState(true);
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
        <Text style={styles.errorText}>
          {userFacingErrorMessage(
            detail.error,
            "This activity could not be found. Return to Activities and try again.",
          )}
        </Text>
      </View>
    );
  }

  const activity = detail.data;
  const zones = hrZones.data ?? [];

  const routePoints = route.data?.status === "ready" ? route.data.points : EMPTY_ROUTE_POINTS;
  const hasGps = routePoints.length > 0;
  const hasMap = hasGps || climbMarkers.length > 0;
  const routeMapPending = route.isLoading || route.data?.status === "processing";
  const hasHr =
    points.some((p) => p.heartRate != null) ||
    (isClimbingActivity && (heartRateContext.data?.points.length ?? 0) > 0);
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
        Alert.alert("Export Failed", userFacingErrorMessage(error, "Unable to export activity."));
      } finally {
        setExportingFormat(null);
      }
    })();
  };

  // Build stats array
  const stats: StatItem[] = [];

  stats.push({
    label: "Duration",
    value:
      activity.durationMin === null ? "Unavailable" : formatDurationMinutes(activity.durationMin),
  });
  if (!(isCycling && isIndoorCyclingModality(activity.modality))) {
    stats.push(
      formatActivityMetric(
        "Distance",
        activity.totalDistance,
        activity.totalDistanceState,
        (distanceMeters) =>
          `${formatNumber(units.convertDistance(distanceMeters / 1000))} ${units.distanceLabel}`,
      ),
    );
  }
  stats.push(
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
  );
  if (isCycling && powerWork.data?.workKilojoules != null) {
    stats.push({
      label: "Energy Output",
      value: `${formatNumber(powerWork.data.workKilojoules, 0)} kJ`,
      qualifier: powerWork.data.coverage.coveragePct < 99 ? "Partial power data" : undefined,
      attribution: metrics.attributionHints.powerWork,
    });
  }
  stats.push(
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
      <ActivityDetailHeader
        key={id}
        activity={activity}
        photos={{
          images: images.data?.images ?? [],
          loading: images.isLoading,
          error: images.error,
          retrying: images.isFetching,
          onRetry: () => void images.refetch(),
        }}
        hardware={hardware.data}
        hardwareLoading={hardware.isLoading}
        hardwareError={hardware.error}
        onRetryHardware={() => void hardware.refetch()}
      />

      {/* Stats Grid */}
      {stats.length > 0 && <StatsGrid stats={stats} />}
      {isCycling && powerWork.error && (
        <QueryStatePanel variant="error" message={powerWork.error.message} />
      )}
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

      {/* Route Map */}
      {route.error ? (
        <QueryStatePanel
          variant="error"
          message={getQueryErrorMessage(route.error)}
          onRetry={() => void route.refetch()}
          retrying={route.isFetching}
        />
      ) : routeMapPending && hasMap ? (
        <View style={styles.chartsLoading} accessibilityLiveRegion="polite">
          <ActivityIndicator color={colors.accent} size="small" />
          <Text style={styles.chartsLoadingText}>
            {route.isLoading ? "Loading route map…" : "Processing route map…"}
          </Text>
        </View>
      ) : routeMapPending ? (
        <View style={styles.mapProcessing}>
          <MapProcessingState />
        </View>
      ) : null}
      {hasMap &&
        !(
          isClimbingActivity &&
          ((climbingEntries.data?.length ?? 0) > 0 || (entrySuggestions.data?.length ?? 0) > 0)
        ) && (
          <RouteMap
            points={routePoints}
            climbMarkers={climbMarkers}
            onSelectEntry={setSelectedClimbingEntryId}
            hoveredPosition={hoveredPosition}
          />
        )}

      {/* Strength Exercises */}
      {(strengthExercises.data?.length ?? 0) > 0 && (
        <ExerciseBreakdown exercises={strengthExercises.data ?? []} units={units} />
      )}

      {isClimbingActivity && (
        <View style={climbingStyles.container}>
          <Text style={chartStyles.title}>Climbs</Text>
          {climbingEntries.error && (
            <Text style={styles.errorText}>{userFacingErrorMessage(climbingEntries.error)}</Text>
          )}
          {climbingEntriesLoading && <QueryStatePanel variant="loading" minHeight={72} />}
          {((climbingEntries.data?.length ?? 0) > 0 ||
            (entrySuggestions.data?.length ?? 0) > 0) && (
            <ActivityClimbingPanel
              selectedEntryId={highlightedClimbId}
              onSelectEntry={setHighlightedClimbId}
              points={routePoints}
              hoveredPosition={hoveredPosition}
              onOpenEntry={setSelectedClimbingEntryId}
              suggestions={entrySuggestions.data}
              attachmentStates={entryAttachState}
              onAttach={handleAttachEntry}
              entries={climbingEntries.data ?? []}
              locations={climbingLocations}
            />
          )}
          {(entrySuggestions.error ||
            (!climbingEntriesLoading &&
              entrySuggestions.isLoading &&
              entrySuggestions.data === undefined) ||
            (climbingEntries.data?.length === 0 && entrySuggestions.data?.length === 0)) && (
            <UnattachedClimbingLogEntries
              showEntries={false}
              suggestions={entrySuggestions.data}
              locations={climbingLocations}
              selectedEntryId={selectedClimbingEntryId}
              error={entrySuggestions.error ?? null}
              isLoading={entrySuggestions.isLoading}
              state={entryAttachState}
              onAttach={handleAttachEntry}
            />
          )}
        </View>
      )}

      {selectedClimbingEntry && (
        <ProviderRecordDetailModal
          dataType="climbingLogEntries"
          state={{ data: selectedClimbingEntry, error: null, isLoading: false }}
          onClose={() => setSelectedClimbingEntryId(null)}
        />
      )}

      {metricSources.error && (
        <QueryStatePanel variant="error" message={metricSources.error.message} />
      )}
      {stream.error && <QueryStatePanel variant="error" message={stream.error.message} />}
      {isClimbingActivity && heartRateContext.error && (
        <QueryStatePanel variant="error" message={heartRateContext.error.message} />
      )}
      {sourceControls.length > 0 &&
        (stream.isFetching ||
          heartRateContext.isFetching ||
          hrZones.isFetching ||
          powerZones.isFetching ||
          powerWork.isFetching) && (
          <Text accessibilityLiveRegion="polite" style={{ color: colors.textSecondary }}>
            Updating metrics…
          </Text>
        )}
      {stream.isLoading ? (
        <View style={styles.chartsLoading}>
          <ActivityIndicator color={colors.accent} size="small" />
          <Text style={styles.chartsLoadingText}>Loading charts...</Text>
        </View>
      ) : null}
      <ActivityMetricsCharts
        points={points}
        sourceControls={sourceControls}
        sourceAttribution={{
          ...metrics.attributionHints.stream,
          heartRate:
            isClimbingActivity && heartRateContext.data !== undefined
              ? metrics.attributionHints.heartRateContext
              : metrics.attributionHints.stream.heartRate,
        }}
        serverUrl={serverUrl}
        activityWindow={activity}
        cadenceLabel={cadenceUnit(activity.activityType)}
        isClimbingActivity={isClimbingActivity}
        heartRateContext={heartRateContext.data}
        climbingAnnotations={climbingEntries.data?.flatMap((entry) => entry.chartAnnotations ?? [])}
        highlightedClimbId={highlightedClimbId}
        onSelectClimb={setHighlightedClimbId}
        hasHr={hasHr}
        hasPower={hasPower}
        hasAltitude={hasAltitude}
        units={units}
        hasGps={hasGps}
        onHoverIndex={handleHoverIndex}
        onHoverTime={handleHeartRateHoverTime}
        onScrubStart={handleScrubStart}
        onScrubEnd={handleScrubEnd}
      />

      {(hasHr || zones.length > 0) && (
        <View>
          {zones.length > 0 && metrics.attributionHints.hrZones && (
            <Text
              accessibilityLiveRegion="polite"
              style={{ color: colors.textSecondary, fontSize: 12 }}
            >
              {metrics.attributionHints.hrZones}
            </Text>
          )}
          <HrZonesChart
            zones={zones}
            loading={hrZones.isLoading}
            errorMessage={
              hrZones.error
                ? userFacingErrorMessage(
                    hrZones.error,
                    "Heart rate zones could not be loaded. Please try again.",
                  )
                : undefined
            }
          />
        </View>
      )}

      {/* Power Zones and dated manual FTP settings link */}
      {powerZones.error && <QueryStatePanel variant="error" message={powerZones.error.message} />}
      {isCycling && hasPower && powerZones.data != null && (
        <View style={{ gap: 8 }}>
          {powerZones.data.ftp != null &&
            powerZones.data.zones.length > 0 &&
            metrics.attributionHints.powerZones && (
              <Text
                accessibilityLiveRegion="polite"
                style={{ color: colors.textSecondary, fontSize: 12 }}
              >
                {metrics.attributionHints.powerZones}
              </Text>
            )}
          <CyclingThresholdDetails evidence={powerZones.data.thresholdEvidence} />
          {!powerZones.error && !powerZones.isFetching && powerZones.data.ftp == null ? (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel="Set cycling FTP for this activity date"
              onPress={() =>
                router.push(
                  `/settings?tab=models-units&section=cycling-ftp&date=${powerZones.data?.activityDate ?? ""}`,
                )
              }
              style={{ minHeight: 44, justifyContent: "center" }}
            >
              <Text style={{ color: colors.accent }}>Set FTP for this date</Text>
            </Pressable>
          ) : null}
          {powerZones.data.ftp != null && <PowerZonesChart zones={powerZones.data.zones} />}
        </View>
      )}

      {id ? <RecomputeActivityButton key={`recompute-${id}`} activityId={id} /> : null}

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
