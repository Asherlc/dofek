import {
  climbingAttemptIncreaseTitle,
  climbingVolumeIncreaseTitle,
  formatClimbingAttemptIncrease,
  formatClimbingVolumeIncrease,
} from "@dofek/format/climbing-volume";
import {
  formatDateShort,
  formatDurationMinutes,
  formatNumber,
  formatTrainingLoad,
} from "@dofek/format/format";
import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import { shouldShowBlockingLoading } from "@dofek/scoring/loading-policy";
import { aggregateWeeklyVolume } from "@dofek/scoring/scoring";
import type { ClimbingFilters as ClimbingFilterValues } from "@dofek/training/climbing-filters";
import { climbingStrengthsSchema } from "@dofek/training/climbing-strengths";
import { TRAINING_TERMINOLOGY } from "@dofek/training/terminology";
import {
  collapseWeeklyVolumeActivityTypes,
  formatActivityTypeLabel,
} from "@dofek/training/training";
import { cyclingPowerProfileSchema } from "dofek-server/cycling-power-profile";
import { useIsFocused } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { ChartTitleWithTooltip } from "../components/ChartTitleWithTooltip";
import { ClimbingFilters } from "../components/ClimbingFilters";
import { ClimbingLocationMapCard } from "../components/ClimbingLocationMapCard";
import { ClimbingStrengths } from "../components/ClimbingStrengths";
import { ClimbingTrainingCard } from "../components/ClimbingTrainingCard";
import { CyclingDurability } from "../components/CyclingDurability";
import { CyclingPowerProfile } from "../components/CyclingPowerProfile";
import { CyclingDecouplingChart } from "../components/charts/CyclingDecouplingChart";
import { VerticalAscentChart } from "../components/charts/VerticalAscentChart";
import { DaySelector } from "../components/DaySelector";
import { EstimatedStrengthCard } from "../components/EstimatedStrengthCard";
import { ProcessingStatusWidget } from "../components/ProcessingStatusWidget";
import { ProgressiveOverloadCards } from "../components/ProgressiveOverloadCards";
import { QueryStatePanel } from "../components/QueryStatePanel";
import { RouteComparisonCard } from "../components/RouteComparisonCard";
import { RunningTrainingCard } from "../components/RunningTrainingCard";
import { SportVolumeChart } from "../components/SportVolumeChart";
import { StrengthLoggedSetComparison } from "../components/StrengthLoggedSetComparison";
import { TrainingChartEmptyState } from "../components/TrainingChartEmptyState";
import { TrainingDistributionCards } from "../components/TrainingDistributionCards";
import { TrainingVolumeChart } from "../components/TrainingVolumeChart";
import { isTransientNetworkError } from "../lib/query-client";
import { safeParseData, safeParseRows } from "../lib/safe-parse";
import { captureException } from "../lib/telemetry";
import type { TrainingSection } from "../lib/training-sections";
import { trpc } from "../lib/trpc";
import { useUnitConverter } from "../lib/units";
import { useProcessingStatus } from "../lib/useProcessingStatus";
import { useRefresh } from "../lib/useRefresh";
import { useTimeRangePreference } from "../lib/useTimeRangePreference";
import { useTodayQueryDate } from "../lib/useTodayQueryDate";
import { colors } from "../theme";
import { WeeklyVolumeRowSchema } from "../types/api";

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
  const isFocused = useIsFocused();
  return <TrainingAnalysis isFocused={isFocused} />;
}

export function TrainingAnalysis({
  section,
  isFocused,
}: {
  section?: TrainingSection;
  isFocused: boolean;
}) {
  const show = (target: TrainingSection) => section == null || section === target;
  const showLoad = show("overview") || show("recovery");
  const showTrainingData = showLoad || show("cycling") || show("strength") || show("climbing");
  const [climbingFilters, setClimbingFilters] = useState<ClimbingFilterValues>({});
  const [strengthsAllTime, setStrengthsAllTime] = useState(false);
  const [includeAreaMetadata, setIncludeAreaMetadata] = useState(true);
  const utils = trpc.useUtils();
  const { days, isHydrated, setDays } = useTimeRangePreference("training");
  const units = useUnitConverter();
  const endDate = useTodayQueryDate();
  const hasCommittedHydratedRange = useRef(false);
  const preservePreviousRangeData = isHydrated && hasCommittedHydratedRange.current;
  useEffect(() => {
    hasCommittedHydratedRange.current = isHydrated;
  }, [isHydrated]);

  const decouplingQuery = trpc.cycling.decoupling.useQuery(
    { days },
    {
      enabled: isHydrated && show("cycling"),
      placeholderData: preservePreviousRangeData ? (previousData) => previousData : undefined,
    },
  );
  useReportQueryError(decouplingQuery);

  const trainingQuery = trpc.mobileDashboard.trainingV2.useQuery(
    { days, endDate, ...(Object.keys(climbingFilters).length ? { climbingFilters } : {}) },
    {
      enabled: isHydrated && showTrainingData,
      placeholderData: preservePreviousRangeData ? (previousData) => previousData : undefined,
    },
  );
  const runningQuery = trpc.running.dynamicsV2.useQuery(
    { days, responseVersion: 2 },
    {
      enabled: isHydrated && show("running"),
      placeholderData: preservePreviousRangeData ? (previousData) => previousData : undefined,
    },
  );
  useReportQueryError(runningQuery);
  const cyclingPowerProfile = trpc.cycling.powerProfile.useQuery(
    { days },
    {
      enabled: isHydrated && section === "cycling",
      placeholderData: preservePreviousRangeData ? (previousData) => previousData : undefined,
    },
  );
  useReportQueryError(cyclingPowerProfile);
  const parsedCyclingPowerProfile = useMemo(
    () =>
      cyclingPowerProfile.data === undefined
        ? { data: undefined, error: null }
        : safeParseData(
            cyclingPowerProfileSchema,
            cyclingPowerProfile.data,
            "Cycling power profile",
          ),
    [cyclingPowerProfile.data],
  );
  const climbingStrengthsQuery = trpc.climbing.strengths.useQuery(
    {
      days: strengthsAllTime ? null : days,
      endDate,
      responseVersion: 2,
      ...climbingFilters,
      includeAreaMetadata,
    },
    {
      enabled: isHydrated && show("climbing"),
      refetchInterval: (query) => (query.state.data?.enrichmentPending ? 1500 : false),
      placeholderData: preservePreviousRangeData ? (previousData) => previousData : undefined,
    },
  );
  const climbingStrengths = useMemo(
    () =>
      climbingStrengthsQuery.data === undefined
        ? { data: undefined, error: null }
        : safeParseData(climbingStrengthsSchema, climbingStrengthsQuery.data, "Climbing strengths"),
    [climbingStrengthsQuery.data],
  );
  const climbingLocationMapQuery = trpc.climbing.locationMap.useQuery(
    { days, ...climbingFilters },
    {
      enabled: isHydrated && show("climbing"),
      placeholderData: preservePreviousRangeData ? (previousData) => previousData : undefined,
    },
  );
  const climbingDemonstratedGradeQuery = trpc.climbing.demonstratedGrade.useQuery(
    { endDate, filters: climbingFilters },
    {
      enabled: isHydrated && show("climbing"),
      placeholderData: preservePreviousRangeData ? (previousData) => previousData : undefined,
    },
  );
  const climbingIncreaseQueryOptions = {
    enabled: isHydrated && isFocused && show("climbing"),
    staleTime: 0,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
  };
  const climbingVolumeIncrease = trpc.climbing.volumeIncrease.useQuery(
    undefined,
    climbingIncreaseQueryOptions,
  );
  const climbingAttemptIncrease = trpc.climbing.attemptIncrease.useQuery(
    undefined,
    climbingIncreaseQueryOptions,
  );
  const climbingVolumeQuery = trpc.climbing.volumeOverTime.useQuery(
    { days, ...climbingFilters },
    {
      enabled: isHydrated && show("climbing"),
      placeholderData: preservePreviousRangeData ? (previousData) => previousData : undefined,
    },
  );
  const loggedSetsQuery = trpc.strength.loggedSetComparison.useQuery(
    { days },
    {
      enabled: isHydrated && show("strength"),
      placeholderData: preservePreviousRangeData ? (previousData) => previousData : undefined,
    },
  );
  useReportQueryError(loggedSetsQuery);
  const strengthVolumeQuery = trpc.strength.volumeOverTime.useQuery(
    { days },
    {
      enabled: isHydrated && show("strength"),
      placeholderData: preservePreviousRangeData ? (previousData) => previousData : undefined,
    },
  );
  useReportQueryError(climbingVolumeIncrease);
  useReportQueryError(climbingAttemptIncrease);
  useReportQueryError(climbingVolumeQuery);
  const strengthHistoryQuery = trpc.strength.exerciseHistory.useQuery(
    { days },
    {
      enabled: isHydrated && show("strength"),
      placeholderData: preservePreviousRangeData ? (previousData) => previousData : undefined,
    },
  );
  useReportQueryError(strengthVolumeQuery);
  useReportQueryError(strengthHistoryQuery);
  const hrZonesQuery = trpc.training.hrZones.useQuery(
    { days },
    {
      enabled: isHydrated && show("endurance"),
      placeholderData: preservePreviousRangeData ? (previousData) => previousData : undefined,
    },
  );
  const polarizationQuery = trpc.efficiency.polarizationTrend.useQuery(
    { days },
    {
      enabled: isHydrated && show("endurance"),
      placeholderData: preservePreviousRangeData ? (previousData) => previousData : undefined,
    },
  );
  const processingStatus = useProcessingStatus({ datasets: ["activity", "recovery", "training"] });

  useReportQueryError(trainingQuery);
  useReportQueryError(climbingLocationMapQuery);
  useReportQueryError(climbingDemonstratedGradeQuery);
  useReportQueryError(climbingStrengthsQuery);
  useReportQueryError(hrZonesQuery);
  useReportQueryError(polarizationQuery);

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

  const acuteLoad = todayWorkload?.acuteLoad ?? 0;
  const chronicLoad = todayWorkload?.chronicLoad ?? 0;
  const workloadRatio = todayWorkload?.workloadRatio;
  const verticalAscentAvailability = trainingData?.chartAvailability?.verticalAscent;

  const isLoading = shouldShowBlockingLoading({
    data: trainingData,
    isFetching: trainingQuery.isFetching,
    isLoading: trainingQuery.isLoading,
  });
  const { refreshing, onRefresh } = useRefresh({
    invalidate: () =>
      Promise.all([
        utils.mobileDashboard.trainingV2.invalidate(),
        utils.cycling.decoupling.invalidate(),
        utils.running.dynamicsV2.invalidate(),
        utils.climbing.locationMap.invalidate(),
        utils.climbing.demonstratedGrade.invalidate(),
        utils.climbing.strengths.invalidate(),
        utils.climbing.volumeIncrease.invalidate(),
        utils.climbing.attemptIncrease.invalidate(),
        utils.climbing.volumeOverTime.invalidate(),
        utils.strength.volumeOverTime.invalidate(),
        utils.strength.exerciseHistory.invalidate(),
        utils.strength.loggedSetComparison.invalidate(),
        utils.training.hrZones.invalidate(),
        utils.training.sportVolume.invalidate(),
        ...(section === "cycling" ? [utils.cycling.powerProfile.invalidate()] : []),
        utils.hiking.activityComparison.invalidate(),
        utils.efficiency.polarizationTrend.invalidate(),
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
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.textSecondary}
        />
      }
    >
      <DaySelector days={days} onChange={setDays} />

      <ProcessingStatusWidget
        data={processingStatus.data}
        error={processingStatus.error}
        loading={processingStatus.isLoading}
      />

      {showTrainingData &&
        (isLoading ? (
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
            {showLoad ? (
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
            ) : null}

            {show("cycling") ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Vertical Ascent Rate</Text>
                {verticalAscentAvailability?.status === "available" ? (
                  <VerticalAscentChart data={verticalAscent} units={units} />
                ) : verticalAscentAvailability ? (
                  <TrainingChartEmptyState availability={verticalAscentAvailability} />
                ) : (
                  <Text style={styles.emptyChartText}>
                    No activities with altitude data available
                  </Text>
                )}
              </View>
            ) : null}

            {show("strength") ? (
              <ProgressiveOverloadCards
                exercises={trainingData?.progressiveOverload ?? []}
                loading={trainingQuery.isLoading && trainingData == null}
                units={units}
              />
            ) : null}
          </>
        ))}

      {section === "cycling" ? (
        <CyclingDurability days={days} enabled={isHydrated} units={units} />
      ) : null}

      {show("overview") ||
      show("endurance") ||
      show("cycling") ||
      show("running") ||
      show("hiking") ? (
        <SportVolumeChart
          days={days}
          enabled={isHydrated}
          initialSport={
            section === "cycling" || section === "running" || section === "hiking"
              ? section
              : undefined
          }
        />
      ) : null}
      {section === "cycling" ? (
        <CyclingPowerProfile
          units={units}
          profile={parsedCyclingPowerProfile.data}
          error={cyclingPowerProfile.error ?? parsedCyclingPowerProfile.error}
          loading={cyclingPowerProfile.isLoading}
        />
      ) : null}
      {show("cycling") ? (
        <CyclingDecouplingChart
          data={decouplingQuery.data}
          loading={decouplingQuery.isLoading}
          error={decouplingQuery.error}
        />
      ) : null}
      {show("hiking") ? <RouteComparisonCard days={days} enabled={isHydrated} /> : null}
      {show("climbing") ? (
        <>
          <ClimbingFilters value={climbingFilters} onChange={setClimbingFilters} />
          {climbingVolumeIncrease.error ? (
            <QueryStatePanel variant="error" message={climbingVolumeIncrease.error.message} />
          ) : climbingVolumeIncrease.data?.status === "increase" ? (
            <ClimbingIncreaseCallout
              title={climbingVolumeIncreaseTitle}
              message={formatClimbingVolumeIncrease(climbingVolumeIncrease.data)}
            />
          ) : null}
          {climbingAttemptIncrease.error ? (
            <QueryStatePanel variant="error" message={climbingAttemptIncrease.error.message} />
          ) : climbingAttemptIncrease.data?.status === "increase" ? (
            <ClimbingIncreaseCallout
              title={climbingAttemptIncreaseTitle}
              message={formatClimbingAttemptIncrease(climbingAttemptIncrease.data)}
            />
          ) : null}
          {climbingVolumeQuery.error ? (
            <QueryStatePanel variant="error" message={climbingVolumeQuery.error.message} />
          ) : null}
          {climbingVolumeQuery.isLoading && !climbingVolumeQuery.data ? (
            <QueryStatePanel variant="loading" />
          ) : null}
          {climbingVolumeQuery.data ? (
            <TrainingVolumeChart sport="climbing" data={climbingVolumeQuery.data} />
          ) : null}
        </>
      ) : null}
      {show("strength") ? (
        <>
          <StrengthLoggedSetComparison
            data={loggedSetsQuery.data}
            loading={loggedSetsQuery.isLoading}
            error={loggedSetsQuery.error}
            units={units}
          />
          {strengthVolumeQuery.error ? (
            <QueryStatePanel variant="error" message={strengthVolumeQuery.error.message} />
          ) : null}
          {strengthVolumeQuery.isLoading && !strengthVolumeQuery.data ? (
            <QueryStatePanel variant="loading" />
          ) : null}
          {strengthVolumeQuery.data ? (
            <TrainingVolumeChart sport="strength" data={strengthVolumeQuery.data} />
          ) : null}
          <EstimatedStrengthCard
            rows={strengthHistoryQuery.data ?? []}
            loading={strengthHistoryQuery.isLoading}
            error={strengthHistoryQuery.error?.message ?? null}
          />
        </>
      ) : null}
      {show("climbing") ? (
        <>
          <ClimbingStrengths
            data={climbingStrengths.data}
            refreshing={
              climbingStrengths.data != null && climbingStrengthsQuery.isFetching && isFocused
            }
            includeAreaMetadata={includeAreaMetadata}
            onIncludeAreaMetadataChange={setIncludeAreaMetadata}
            rangeControl={
              <View
                accessibilityRole="radiogroup"
                accessibilityLabel="Climbing strengths period"
                style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
              >
                {[
                  { label: `${days} days`, allTime: false },
                  { label: "All time", allTime: true },
                ].map((option) => (
                  <TouchableOpacity
                    key={option.label}
                    accessibilityRole="radio"
                    accessibilityLabel={option.label}
                    accessibilityState={{ checked: strengthsAllTime === option.allTime }}
                    onPress={() => setStrengthsAllTime(option.allTime)}
                    style={{
                      minHeight: 44,
                      justifyContent: "center",
                      paddingHorizontal: 12,
                      borderRadius: 8,
                      borderWidth: 1,
                      borderColor:
                        strengthsAllTime === option.allTime
                          ? colors.accent
                          : colors.surfaceSecondary,
                    }}
                  >
                    <Text
                      style={{
                        color:
                          strengthsAllTime === option.allTime
                            ? colors.accent
                            : colors.textSecondary,
                      }}
                    >
                      {option.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            }
            loading={climbingStrengthsQuery.isLoading}
            error={
              climbingStrengthsQuery.error ??
              (climbingStrengths.error
                ? {
                    message:
                      "Climbing strengths data could not be read. Pull to refresh to reload it.",
                  }
                : null)
            }
          />
          <ClimbingLocationMapCard
            data={climbingLocationMapQuery.data}
            loading={climbingLocationMapQuery.isLoading}
            error={climbingLocationMapQuery.error}
          />
        </>
      ) : null}
      {show("running") ? (
        <RunningTrainingCard
          data={isHydrated ? runningQuery.data : undefined}
          loading={!isHydrated || runningQuery.isLoading}
          error={runningQuery.error}
          onRetry={() => {
            void runningQuery.refetch();
          }}
        />
      ) : null}
      {show("climbing") && !isLoading ? (
        <ClimbingTrainingCard
          data={shouldShowClimbingSection ? trainingData?.climbing : undefined}
          loading={trainingQuery.isLoading && trainingData == null}
          demonstratedGrade={climbingDemonstratedGradeQuery.data}
          demonstratedGradeLoading={climbingDemonstratedGradeQuery.isLoading}
          demonstratedGradeError={climbingDemonstratedGradeQuery.error}
          demonstratedGradeOnly={!shouldShowClimbingSection}
        />
      ) : null}

      {show("overview") && !isLoading && !shouldShowTrainingQueryError && (
        <>
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
              <Text style={styles.cardTitle}>Weekly Volume</Text>
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
        </>
      )}

      {show("endurance") ? (
        <>
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

          <TrainingDistributionCards
            intensityDistribution={hrZonesQuery.data?.intensityDistribution ?? null}
            polarization={polarizationQuery.data ?? null}
          />
        </>
      ) : null}
    </ScrollView>
  );
}

function ClimbingIncreaseCallout({ title, message }: { title: string; message: string }) {
  return (
    <View style={styles.volumeIncrease}>
      <Text accessibilityRole="header" style={styles.volumeIncreaseTitle}>
        {title}
      </Text>
      <Text style={styles.volumeIncreaseMessage}>{message}</Text>
    </View>
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
  volumeIncrease: {
    backgroundColor: colors.surface,
    borderColor: colors.accent,
    borderLeftWidth: 3,
    borderRadius: 12,
    padding: 12,
    gap: 4,
  },
  volumeIncreaseTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
  volumeIncreaseMessage: {
    color: colors.textSecondary,
    fontSize: 14,
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
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  errorText: {
    color: "#f87171",
    fontSize: 13,
    textAlign: "center",
    paddingVertical: 24,
  },
});
