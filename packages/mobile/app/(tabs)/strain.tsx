import {
  formatDateShort,
  formatDurationMinutes,
  formatIntensity,
  formatNumber,
  formatTrainingLoad,
} from "@dofek/format/format";
import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import { shouldShowBlockingLoading } from "@dofek/scoring/loading-policy";
import { aggregateWeeklyVolume, StrainScore } from "@dofek/scoring/scoring";
import type { ClimbingFilters as ClimbingFilterValues } from "@dofek/training/climbing-filters";
import { TRAINING_TERMINOLOGY } from "@dofek/training/terminology";
import {
  collapseWeeklyVolumeActivityTypes,
  formatActivityTypeLabel,
} from "@dofek/training/training";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { ActivityCard } from "../../components/ActivityCard";
import { ChartTitleWithTooltip } from "../../components/ChartTitleWithTooltip";
import { ClimbingFilters } from "../../components/ClimbingFilters";
import { ClimbingTrainingCard } from "../../components/ClimbingTrainingCard";
import { SparkLine } from "../../components/charts/SparkLine";
import { StrainGauge } from "../../components/charts/StrainGauge";
import { VerticalAscentChart } from "../../components/charts/VerticalAscentChart";
import { DaySelector } from "../../components/DaySelector";
import { ProcessingStatusWidget } from "../../components/ProcessingStatusWidget";
import { ProgressiveOverloadCards } from "../../components/ProgressiveOverloadCards";
import { QueryStatePanel } from "../../components/QueryStatePanel";
import { TrainingChartEmptyState } from "../../components/TrainingChartEmptyState";
import { TrainingDistributionCards } from "../../components/TrainingDistributionCards";
import { isTransientNetworkError } from "../../lib/query-client";
import { safeParseRows } from "../../lib/safe-parse";
import { captureException } from "../../lib/telemetry";
import { trpc } from "../../lib/trpc";
import { useUnitConverter } from "../../lib/units";
import { useProcessingStatus } from "../../lib/useProcessingStatus";
import { useRefresh } from "../../lib/useRefresh";
import { useTimeRangePreference } from "../../lib/useTimeRangePreference";
import { useTodayQueryDate } from "../../lib/useTodayQueryDate";
import { colors } from "../../theme";
import { ActivityRowSchema, WeeklyVolumeRowSchema } from "../../types/api";

const reportedTrainingErrors = new WeakSet<object>();

function useReportQueryError(query: { isError: boolean; error: object | null }) {
  useEffect(() => {
    if (
      !query.isError ||
      !query.error ||
      isTransientNetworkError(query.error) ||
      reportedTrainingErrors.has(query.error)
    )
      return;
    reportedTrainingErrors.add(query.error);
    captureException(query.error);
  }, [query.isError, query.error]);
}

export default function StrainScreen() {
  const [climbingFilters, setClimbingFilters] = useState<ClimbingFilterValues>({});
  const router = useRouter();
  const utils = trpc.useUtils();
  const { days, description, isHydrated, setDays } = useTimeRangePreference("training");
  const units = useUnitConverter();
  const endDate = useTodayQueryDate();
  const hasCommittedHydratedRange = useRef(false);
  const preservePreviousRangeData = isHydrated && hasCommittedHydratedRange.current;
  useEffect(() => {
    hasCommittedHydratedRange.current = isHydrated;
  }, [isHydrated]);

  const trainingQuery = trpc.mobileDashboard.training.useQuery(
    { days, endDate, ...(Object.keys(climbingFilters).length ? { climbingFilters } : {}) },
    {
      enabled: isHydrated,
      placeholderData: preservePreviousRangeData ? (previousData) => previousData : undefined,
    },
  );
  const hrZonesQuery = trpc.training.hrZones.useQuery(
    { days },
    {
      enabled: isHydrated,
      placeholderData: preservePreviousRangeData ? (previousData) => previousData : undefined,
    },
  );
  const polarizationQuery = trpc.efficiency.polarizationTrend.useQuery(
    { days },
    {
      enabled: isHydrated,
      placeholderData: preservePreviousRangeData ? (previousData) => previousData : undefined,
    },
  );
  const monotonyQuery = trpc.cyclingAdvanced.trainingMonotony.useQuery(
    { days },
    {
      enabled: isHydrated,
      placeholderData: preservePreviousRangeData ? (previousData) => previousData : undefined,
    },
  );
  const processingStatus = useProcessingStatus({ datasets: ["activity", "recovery", "training"] });

  useReportQueryError(trainingQuery);
  useReportQueryError(hrZonesQuery);
  useReportQueryError(polarizationQuery);
  useReportQueryError(monotonyQuery);

  const trainingData = isHydrated ? trainingQuery.data : undefined;

  const workloadResult = trainingData?.workloadRatio;
  const workloadData = workloadResult?.timeSeries ?? [];
  const recentLoadLabel =
    workloadResult == null ? "Recent load" : `Recent ${workloadResult.context.recentDays}-day load`;
  const baselineLoadLabel =
    workloadResult == null
      ? "Baseline load"
      : `${workloadResult.context.baselineDays}-day baseline load`;
  const todayWorkload = workloadData[workloadData.length - 1];
  const strainTarget = trainingData?.strainTarget;

  const activitiesParsed = safeParseRows(
    ActivityRowSchema,
    trainingData == null ? [] : trainingData.activities,
    "strain:activities",
  );
  const activities = activitiesParsed.data;

  const weeklyVolumeParsed = safeParseRows(
    WeeklyVolumeRowSchema,
    trainingData == null ? [] : trainingData.weeklyVolume,
    "strain:weeklyVolume",
  );
  const weeklyVolume = weeklyVolumeParsed.data;
  const verticalAscent = trainingData?.verticalAscent ?? [];
  const hasCachedTrainingData = trainingData != null;
  const hasCachedClimbingData = trainingData?.climbing != null;
  const shouldShowTrainingQueryError = trainingQuery.isError && !hasCachedTrainingData;
  const shouldShowClimbingSection = !trainingQuery.isError || hasCachedClimbingData;
  const collapsedWeeklyVolume = collapseWeeklyVolumeActivityTypes(weeklyVolume, 6);
  const activityTypeTotalsMap = new Map<string, number>();
  for (const row of collapsedWeeklyVolume) {
    activityTypeTotalsMap.set(
      row.canonical_type,
      (activityTypeTotalsMap.get(row.canonical_type) ?? 0) + row.hours,
    );
  }
  const activityTypeTotals = [...activityTypeTotalsMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([activityType, hours]) => ({ activityType, hours }));

  const dailyStrain =
    strainTarget?.currentStrain ??
    (workloadResult?.displayedDate != null && workloadResult.displayedDate === endDate
      ? workloadResult.displayedStrain
      : 0);
  const acuteLoad = todayWorkload?.acuteLoad ?? 0;
  const chronicLoad = todayWorkload?.chronicLoad ?? 0;
  const workloadRatio = todayWorkload?.workloadRatio;
  const displayedDate = workloadResult?.displayedDate;
  const strainDateLabel =
    displayedDate == null
      ? "No training load to display"
      : displayedDate === todayWorkload?.date
        ? "Today"
        : `Last training day: ${formatDateShort(displayedDate)}`;

  const strainTrend = workloadData.map((d) => d.strain);
  const strainTrendAvailability = trainingData?.chartAvailability?.strainTrend;
  const verticalAscentAvailability = trainingData?.chartAvailability?.verticalAscent;

  const isLoading = shouldShowBlockingLoading({
    data: trainingData,
    isFetching: trainingQuery.isFetching,
    isLoading: trainingQuery.isLoading,
  });
  const { refreshing, onRefresh } = useRefresh({
    invalidate: () =>
      Promise.all([
        utils.mobileDashboard.training.invalidate(),
        utils.training.hrZones.invalidate(),
        utils.efficiency.polarizationTrend.invalidate(),
        utils.cyclingAdvanced.trainingMonotony.invalidate(),
        utils.processing.status.invalidate(),
      ]).then(() => undefined),
  });

  if (!isHydrated) {
    return <QueryStatePanel variant="loading" minHeight={200} />;
  }

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
      <DaySelector days={days} description={description} onChange={setDays} />

      <ProcessingStatusWidget
        data={processingStatus.data}
        error={processingStatus.error}
        loading={processingStatus.isLoading}
      />

      {isLoading ? (
        <QueryStatePanel variant="loading" minHeight={200} />
      ) : shouldShowTrainingQueryError ? (
        <QueryStatePanel
          variant="error"
          title="Could not load training data"
          message={
            trainingQuery.error
              ? userFacingErrorMessage(
                  trainingQuery.error,
                  "Training data could not be loaded. Please try again.",
                )
              : undefined
          }
        />
      ) : (
        <>
          {/* Current strain gauge */}
          <View style={styles.gaugeSection}>
            <StrainGauge strain={dailyStrain} size={160} />
            <Text style={styles.gaugeCaption}>{strainDateLabel}</Text>
          </View>

          {/* Strain Target */}
          {strainTarget && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Suggested strain</Text>
              <View style={styles.targetHeader}>
                <View style={styles.targetValueRow}>
                  <Text style={styles.targetValue}>{strainTarget.targetStrain}</Text>
                  <Text
                    style={[
                      styles.zoneBadge,
                      {
                        backgroundColor:
                          strainTarget.zone === "Push"
                            ? colors.positiveSubtle
                            : strainTarget.zone === "Recovery"
                              ? colors.dangerSubtle
                              : colors.warningSubtle,
                        color:
                          strainTarget.zone === "Push"
                            ? colors.positive
                            : strainTarget.zone === "Recovery"
                              ? colors.danger
                              : colors.warning,
                      },
                    ]}
                  >
                    {strainTarget.zone}
                  </Text>
                </View>
                <Text style={styles.targetProgress}>
                  {formatIntensity(strainTarget.progressPercent)} reached
                </Text>
              </View>
              <View style={styles.targetBarTrack}>
                <View
                  style={[
                    styles.targetBarFill,
                    {
                      width: `${Math.min(strainTarget.progressPercent, 100)}%`,
                      backgroundColor: new StrainScore(strainTarget.currentStrain).color,
                    },
                  ]}
                />
              </View>
              <Text style={styles.targetExplanation}>{strainTarget.explanation}</Text>
            </View>
          )}

          {/* Workload breakdown */}
          <View style={styles.card}>
            <ChartTitleWithTooltip
              title="Training Load"
              description={
                workloadResult == null
                  ? "Daily training load and recent-versus-baseline comparison."
                  : `Technical name: ${TRAINING_TERMINOLOGY.workloadRatio.technicalName}. ${TRAINING_TERMINOLOGY.workloadRatio.details}`
              }
              textStyle={styles.cardTitle}
            />
            <View style={styles.loadGrid}>
              <View style={styles.loadItem}>
                <Text style={styles.loadValue}>{formatTrainingLoad(acuteLoad)}</Text>
                <Text style={styles.loadLabel}>{recentLoadLabel}</Text>
              </View>
              <View style={styles.loadItem}>
                <Text style={styles.loadValue}>{formatTrainingLoad(chronicLoad)}</Text>
                <Text style={styles.loadLabel}>{baselineLoadLabel}</Text>
              </View>
              <View style={styles.loadItem}>
                <Text style={styles.loadValue}>
                  {workloadRatio != null ? formatNumber(workloadRatio, 2) : "--"}
                </Text>
                <Text style={styles.loadLabel}>
                  {workloadResult == null ? "Ratio" : workloadResult.context.label}
                </Text>
              </View>
            </View>
            {workloadResult == null ? null : (
              <Text style={styles.ratioHint}>{workloadResult.context.description}</Text>
            )}
          </View>

          {/* Strain trend */}
          <View style={styles.card}>
            <ChartTitleWithTooltip
              title={`Daily Strain (${days} Days)`}
              description="Daily strain scores for the selected period. The dashed line marks the average."
              textStyle={styles.cardTitle}
            />
            {strainTrendAvailability?.status === "available" ? (
              <SparkLine
                data={strainTrend}
                height={60}
                color={colors.accent}
                showBaseline
                showYAxis
              />
            ) : strainTrendAvailability ? (
              <TrainingChartEmptyState availability={strainTrendAvailability} />
            ) : (
              <Text style={styles.emptyChartText}>No training data yet for this period</Text>
            )}
          </View>

          {/* Vertical Ascent Rate */}
          <View style={styles.card}>
            <ChartTitleWithTooltip
              title="Vertical Ascent Rate"
              description="Climbing speed — meters gained per hour while ascending. Bubble size indicates elevation gain."
              textStyle={styles.cardTitle}
            />
            {verticalAscentAvailability?.status === "available" ? (
              <VerticalAscentChart data={verticalAscent} units={units} />
            ) : verticalAscentAvailability ? (
              <TrainingChartEmptyState availability={verticalAscentAvailability} />
            ) : (
              <Text style={styles.emptyChartText}>No activities with altitude data available</Text>
            )}
          </View>

          <ProgressiveOverloadCards
            exercises={trainingData?.progressiveOverload ?? []}
            loading={trainingQuery.isLoading && trainingData == null}
            units={units}
          />

          <ClimbingFilters value={climbingFilters} onChange={setClimbingFilters} />
          {shouldShowClimbingSection ? (
            <ClimbingTrainingCard
              data={trainingData?.climbing}
              loading={trainingQuery.isLoading && trainingData == null}
            />
          ) : null}

          {/* Weekly volume summary */}
          {weeklyVolumeParsed.error && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Weekly Volume</Text>
              <Text style={styles.errorText}>
                {userFacingErrorMessage(
                  weeklyVolumeParsed.error,
                  "Weekly volume could not be loaded. Please try again.",
                )}
              </Text>
            </View>
          )}
          {!weeklyVolumeParsed.error && weeklyVolume.length > 0 && (
            <View style={styles.card}>
              <ChartTitleWithTooltip
                title="Weekly Volume"
                description="Recorded training duration per week. The longest week fills the bar."
                textStyle={styles.cardTitle}
              />
              <View style={styles.volumeStack}>
                {aggregateWeeklyVolume(weeklyVolume).map((week) => (
                  <View key={week.week} style={styles.volumeRow}>
                    <Text style={styles.volumeDate}>{formatDateShort(week.week)}</Text>
                    <View style={styles.volumeBarTrack}>
                      <View style={[styles.volumeBarFill, { width: `${week.fraction * 100}%` }]} />
                    </View>
                    <Text style={styles.volumeHours} numberOfLines={1} ellipsizeMode="tail">
                      {formatDurationMinutes(week.hours * 60)}
                    </Text>
                  </View>
                ))}
              </View>
              {activityTypeTotals.length > 0 && (
                <View style={styles.activityTypeSummary}>
                  {activityTypeTotals.map((entry) => (
                    <Text key={entry.activityType} style={styles.activityTypeSummaryItem}>
                      {formatActivityTypeLabel(entry.activityType)}:{" "}
                      {formatDurationMinutes(entry.hours * 60)}
                    </Text>
                  ))}
                </View>
              )}
            </View>
          )}

          {/* Recent activities */}
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Recent Activities</Text>
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => router.push("/activities")}
                style={styles.sectionLinkButton}
                accessibilityRole="button"
                accessibilityLabel="View all activities"
              >
                <Text style={styles.sectionLinkButtonText}>View all</Text>
              </TouchableOpacity>
            </View>
            {isLoading ? (
              <ActivityIndicator color={colors.accent} style={styles.activitiesLoader} />
            ) : activitiesParsed.error ? (
              <Text style={styles.errorText}>
                {userFacingErrorMessage(
                  activitiesParsed.error,
                  "Recent activities could not be loaded. Please try again.",
                )}
              </Text>
            ) : activities.length > 0 ? (
              <View style={styles.activitiesStack}>
                {activities.slice(0, 5).map((activity) => (
                  <TouchableOpacity
                    key={String(activity.id)}
                    activeOpacity={0.7}
                    onPress={() => router.push(`/activity/${activity.id}`)}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${activity.name ?? "activity"}`}
                  >
                    <ActivityCard
                      name={activity.name ?? ""}
                      activityType={activity.canonical_type ?? ""}
                      startedAt={activity.started_at}
                      endedAt={activity.ended_at ?? null}
                      avgHr={activity.avg_hr ?? null}
                      maxHr={activity.max_hr ?? null}
                      avgPower={activity.avg_power ?? null}
                      distanceKm={
                        activity.distance_meters == null ? null : activity.distance_meters / 1000
                      }
                      distanceState={activity.distance_state}
                      units={units}
                    />
                  </TouchableOpacity>
                ))}
              </View>
            ) : (
              <Text style={styles.activitiesEmpty}>No recent activities</Text>
            )}
          </View>
        </>
      )}

      {hrZonesQuery.isError ? (
        <QueryStatePanel
          variant="error"
          title="Could not load intensity distribution"
          message={hrZonesQuery.error.message}
        />
      ) : hrZonesQuery.isLoading && hrZonesQuery.data == null ? (
        <QueryStatePanel variant="loading" minHeight={120} />
      ) : null}

      {polarizationQuery.isError ? (
        <QueryStatePanel
          variant="error"
          title={`Could not load ${TRAINING_TERMINOLOGY.polarization.plainLabel.toLowerCase()}`}
          message={polarizationQuery.error.message}
        />
      ) : polarizationQuery.isLoading && polarizationQuery.data == null ? (
        <QueryStatePanel variant="loading" minHeight={120} />
      ) : null}

      {monotonyQuery.isError ? (
        <QueryStatePanel
          variant="error"
          title={`Could not load ${TRAINING_TERMINOLOGY.monotony.plainLabel.toLowerCase()}`}
          message={monotonyQuery.error.message}
        />
      ) : monotonyQuery.isLoading && monotonyQuery.data == null ? (
        <QueryStatePanel variant="loading" minHeight={120} />
      ) : null}

      <TrainingDistributionCards
        intensityDistribution={hrZonesQuery.data?.intensityDistribution ?? null}
        polarization={polarizationQuery.data ?? null}
        monotony={monotonyQuery.data ?? null}
      />
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
  gaugeSection: {
    alignItems: "center",
    paddingVertical: 16,
    gap: 8,
  },
  gaugeCaption: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    gap: 12,
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  loadGrid: {
    flexDirection: "row",
    justifyContent: "space-around",
  },
  loadItem: {
    flex: 1,
    alignItems: "center",
    gap: 4,
  },
  loadValue: {
    fontSize: 22,
    fontWeight: "700",
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  loadLabel: {
    fontSize: 11,
    color: colors.textTertiary,
    textAlign: "center",
  },
  ratioHint: {
    fontSize: 12,
    color: colors.textSecondary,
    textAlign: "center",
  },
  targetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  targetValueRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  targetValue: {
    fontSize: 28,
    fontWeight: "700",
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  zoneBadge: {
    fontSize: 11,
    fontWeight: "700",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    overflow: "hidden",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  targetProgress: {
    fontSize: 13,
    color: colors.textSecondary,
    fontVariant: ["tabular-nums"],
  },
  targetBarTrack: {
    height: 8,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 4,
    overflow: "hidden",
  },
  targetBarFill: {
    height: "100%",
    borderRadius: 4,
  },
  targetExplanation: {
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 18,
  },
  sparkContainer: {
    alignItems: "center",
  },
  emptyChartText: {
    fontSize: 13,
    color: colors.textTertiary,
    textAlign: "center",
    paddingVertical: 16,
  },
  volumeStack: {
    gap: 8,
  },
  volumeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  volumeDate: {
    fontSize: 12,
    color: colors.textSecondary,
    width: 50,
  },
  volumeBarTrack: {
    flex: 1,
    height: 8,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 4,
    overflow: "hidden",
  },
  volumeBarFill: {
    height: "100%",
    backgroundColor: colors.accent,
    borderRadius: 4,
  },
  volumeHours: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.text,
    minWidth: 72,
    textAlign: "right",
    fontVariant: ["tabular-nums"],
  },
  activityTypeSummary: {
    borderTopWidth: 1,
    borderTopColor: colors.surfaceSecondary,
    marginTop: 4,
    paddingTop: 8,
    gap: 4,
  },
  activityTypeSummaryItem: {
    fontSize: 12,
    color: colors.textSecondary,
    fontVariant: ["tabular-nums"],
  },
  section: {
    gap: 12,
  },
  sectionHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  sectionLinkButton: {
    borderColor: colors.surfaceSecondary,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  sectionLinkButtonText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
  },
  activitiesStack: {
    gap: 8,
  },
  activitiesLoader: {
    paddingVertical: 24,
  },
  activitiesEmpty: {
    color: colors.textTertiary,
    fontSize: 13,
    textAlign: "center",
    paddingVertical: 24,
  },
  errorText: {
    color: "#f87171",
    fontSize: 13,
    textAlign: "center",
    paddingVertical: 24,
  },
});
