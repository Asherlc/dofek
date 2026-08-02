import {
  formatDateShort,
  formatDurationMinutes,
  formatIntensity,
  formatNumber,
  formatTrainingLoad,
} from "@dofek/format/format";
import { shouldShowBlockingLoading } from "@dofek/scoring/loading-policy";
import { aggregateWeeklyVolume, StrainScore } from "@dofek/scoring/scoring";
import {
  collapseWeeklyVolumeActivityTypes,
  formatActivityTypeLabel,
} from "@dofek/training/training";
import { useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { z } from "zod";
import { ActivityCard } from "../../components/ActivityCard";
import { ChartTitleWithTooltip } from "../../components/ChartTitleWithTooltip";
import { SparkLine } from "../../components/charts/SparkLine";
import { StrainGauge } from "../../components/charts/StrainGauge";
import { VerticalAscentChart } from "../../components/charts/VerticalAscentChart";
import { DaySelector } from "../../components/DaySelector";
import { ProcessingStatusWidget } from "../../components/ProcessingStatusWidget";
import { ProgressiveOverloadCards } from "../../components/ProgressiveOverloadCards";
import { QueryStatePanel } from "../../components/QueryStatePanel";
import { TrainingChartEmptyState } from "../../components/TrainingChartEmptyState";
import { TrainingDistributionCards } from "../../components/TrainingDistributionCards";
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

type ClimbingClimbType = "boulder" | "route";

const climbingClimbTypeSchema = z.enum(["boulder", "route"]);

const mobileClimbingGradeProgressionRowSchema = z.object({
  date: z.string(),
  climbType: climbingClimbTypeSchema,
  grade: z.string(),
  gradeSortValue: z.number(),
});

const mobileClimbingVolumeByGradeRowSchema = z.object({
  climbType: climbingClimbTypeSchema,
  grade: z.string(),
  gradeSortValue: z.number(),
  attempts: z.number(),
  sends: z.number(),
});

const mobileClimbingSessionSummaryRowSchema = z.object({
  activityId: z.string(),
  date: z.string(),
  name: z.string(),
  locationName: z.string().nullable(),
  attempts: z.number(),
  sends: z.number(),
  hardestBoulderGrade: z.string().nullable(),
  hardestRouteGrade: z.string().nullable(),
});

const mobileClimbingDataSchema = z.object({
  gradeProgression: z.array(mobileClimbingGradeProgressionRowSchema),
  volumeByGrade: z.array(mobileClimbingVolumeByGradeRowSchema),
  sessionSummary: z.array(mobileClimbingSessionSummaryRowSchema),
});

const mobileClimbingPayloadSchema = z.object({
  gradeProgression: z.unknown().optional(),
  volumeByGrade: z.unknown().optional(),
  sessionSummary: z.unknown().optional(),
});

type MobileClimbingGradeProgressionRow = z.infer<typeof mobileClimbingGradeProgressionRowSchema>;
type MobileClimbingVolumeByGradeRow = z.infer<typeof mobileClimbingVolumeByGradeRowSchema>;
type MobileClimbingSessionSummaryRow = z.infer<typeof mobileClimbingSessionSummaryRowSchema>;
type MobileClimbingData = z.infer<typeof mobileClimbingDataSchema>;

interface MobileClimbingParseResult {
  data: MobileClimbingData;
  error: Error | null;
}

const emptyClimbingData: MobileClimbingData = {
  gradeProgression: [],
  volumeByGrade: [],
  sessionSummary: [],
};

const reportedTrainingErrors = new WeakSet<object>();

function useReportQueryError(query: { isError: boolean; error: object | null }) {
  useEffect(() => {
    if (!query.isError || !query.error || reportedTrainingErrors.has(query.error)) return;
    reportedTrainingErrors.add(query.error);
    captureException(query.error);
  }, [query.isError, query.error]);
}

function parseMobileClimbingData(value: unknown): MobileClimbingParseResult {
  if (value == null) {
    return { data: emptyClimbingData, error: null };
  }

  const payloadResult = mobileClimbingPayloadSchema.safeParse(value);
  if (!payloadResult.success) {
    const parseError = new Error(
      `strain:climbing: Zod parse failed: ${payloadResult.error.message}`,
    );
    captureException(parseError, {
      context: "strain:climbing",
      zodError: payloadResult.error.format(),
    });
    return { data: emptyClimbingData, error: parseError };
  }

  const gradeProgression = safeParseRows(
    mobileClimbingGradeProgressionRowSchema,
    payloadResult.data.gradeProgression ?? [],
    "strain:climbing.gradeProgression",
  );
  const volumeByGrade = safeParseRows(
    mobileClimbingVolumeByGradeRowSchema,
    payloadResult.data.volumeByGrade ?? [],
    "strain:climbing.volumeByGrade",
  );
  const sessionSummary = safeParseRows(
    mobileClimbingSessionSummaryRowSchema,
    payloadResult.data.sessionSummary ?? [],
    "strain:climbing.sessionSummary",
  );

  return {
    data: {
      gradeProgression: gradeProgression.data,
      volumeByGrade: volumeByGrade.data,
      sessionSummary: sessionSummary.data,
    },
    error: gradeProgression.error ?? volumeByGrade.error ?? sessionSummary.error,
  };
}

class ClimbingSectionModel {
  readonly #data: MobileClimbingData;

  constructor(data: MobileClimbingData) {
    this.#data = data;
  }

  bestGrade(climbType: ClimbingClimbType): string | null {
    const bestRow = this.#data.gradeProgression
      .filter((row) => row.climbType === climbType)
      .reduce<MobileClimbingGradeProgressionRow | null>(
        (best, row) => (best === null || row.gradeSortValue > best.gradeSortValue ? row : best),
        null,
      );
    return bestRow?.grade ?? null;
  }

  get volumeRows(): MobileClimbingVolumeByGradeRow[] {
    return [...this.#data.volumeByGrade].sort(
      (left, right) => left.gradeSortValue - right.gradeSortValue,
    );
  }

  get sessions(): MobileClimbingSessionSummaryRow[] {
    return this.#data.sessionSummary;
  }
}

export default function StrainScreen() {
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
    { days, endDate },
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
  const climbingParsed = parseMobileClimbingData(trainingData?.climbing);
  const climbingModel = new ClimbingSectionModel(climbingParsed.data);
  const hasCachedTrainingData = trainingData != null;
  const hasCachedClimbingData = trainingData?.climbing != null;
  const shouldShowTrainingQueryError = trainingQuery.isError && !hasCachedTrainingData;
  const shouldShowClimbingError = climbingParsed.error !== null;
  const shouldShowClimbingSection = !trainingQuery.isError || hasCachedClimbingData;
  const collapsedWeeklyVolume = collapseWeeklyVolumeActivityTypes(weeklyVolume, 6);
  const activityTypeTotalsMap = new Map<string, number>();
  for (const row of collapsedWeeklyVolume) {
    activityTypeTotalsMap.set(
      row.activity_type,
      (activityTypeTotalsMap.get(row.activity_type) ?? 0) + row.hours,
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
      ? "No training load yet"
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
          message={trainingQuery.error?.message}
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
              <Text style={styles.cardTitle}>Daily Strain Target</Text>
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
            <Text style={styles.cardTitle}>Training Load</Text>
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
              description="This chart shows your day-to-day strain trend across the selected date range."
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

          <View style={styles.card}>
            <View style={styles.sectionHeader}>
              <Text style={styles.cardTitle}>Climbing</Text>
              <TouchableOpacity
                accessibilityLabel="Log finger loading or climbing attempts"
                accessibilityRole="button"
                activeOpacity={0.7}
                onPress={() => router.push("/climbing-log")}
                style={styles.sectionLinkButton}
              >
                <Text style={styles.sectionLinkButtonText}>Log session</Text>
              </TouchableOpacity>
            </View>
            {shouldShowClimbingError ? (
              <Text style={styles.errorText}>
                {climbingParsed.error?.message ?? "Failed to load climbing data."}
              </Text>
            ) : null}
            {shouldShowClimbingSection ? <ClimbingSection model={climbingModel} /> : null}
          </View>

          {/* Weekly volume summary */}
          {weeklyVolumeParsed.error && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Weekly Volume</Text>
              <Text style={styles.errorText}>
                {weeklyVolumeParsed.error.message ?? "Failed to load weekly volume."}
              </Text>
            </View>
          )}
          {!weeklyVolumeParsed.error && weeklyVolume.length > 0 && (
            <View style={styles.card}>
              <ChartTitleWithTooltip
                title="Weekly Volume"
                description="This chart shows your total training hours by week."
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
                {activitiesParsed.error.message ?? "Failed to load activities."}
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
                      activityType={activity.activity_type ?? ""}
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
          title="Could not load cycling polarization"
          message={polarizationQuery.error.message}
        />
      ) : polarizationQuery.isLoading && polarizationQuery.data == null ? (
        <QueryStatePanel variant="loading" minHeight={120} />
      ) : null}

      {monotonyQuery.isError ? (
        <QueryStatePanel
          variant="error"
          title="Could not load training monotony"
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

function ClimbingSection({ model }: { model: ClimbingSectionModel }) {
  return (
    <View style={styles.climbingStack}>
      <View style={styles.climbingGradeGrid}>
        <View style={styles.climbingGradeItem}>
          <Text style={styles.loadLabel}>Best Boulder Grade</Text>
          <Text style={styles.loadValue}>{model.bestGrade("boulder") ?? "None"}</Text>
        </View>
        <View style={styles.climbingGradeItem}>
          <Text style={styles.loadLabel}>Best Route Grade</Text>
          <Text style={styles.loadValue}>{model.bestGrade("route") ?? "None"}</Text>
        </View>
      </View>

      {model.bestGrade("boulder") == null && model.bestGrade("route") == null && (
        <Text style={styles.activitiesEmpty}>No climbing grade progression</Text>
      )}

      <View style={styles.climbingSubsection}>
        <Text style={styles.climbingSubsectionTitle}>Volume by Grade</Text>
        {model.volumeRows.length === 0 ? (
          <Text style={styles.activitiesEmpty}>No climbing volume by grade</Text>
        ) : (
          model.volumeRows.map((row) => (
            <View key={`${row.climbType}-${row.grade}`} style={styles.climbingVolumeRow}>
              <Text style={styles.climbingGradeText}>{row.grade}</Text>
              <Text style={styles.climbingMetaText}>{row.attempts} attempts</Text>
              <Text style={styles.climbingMetaText}>{row.sends} sends</Text>
            </View>
          ))
        )}
      </View>

      <View style={styles.climbingSubsection}>
        <Text style={styles.climbingSubsectionTitle}>Recent Climbing Sessions</Text>
        {model.sessions.length === 0 ? (
          <Text style={styles.activitiesEmpty}>No climbing sessions</Text>
        ) : (
          model.sessions.slice(0, 3).map((session) => (
            <View key={session.activityId} style={styles.climbingSessionRow}>
              <Text style={styles.climbingSessionName}>{session.name}</Text>
              {session.locationName && (
                <Text style={styles.climbingMetaText}>{session.locationName}</Text>
              )}
              <Text style={styles.climbingMetaText}>
                {session.attempts} attempts · {session.sends} sends
              </Text>
              <Text style={styles.climbingMetaText}>
                Boulder {session.hardestBoulderGrade ?? "None"} · Route{" "}
                {session.hardestRouteGrade ?? "None"}
              </Text>
            </View>
          ))
        )}
      </View>
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
  climbingStack: {
    gap: 14,
  },
  climbingGradeGrid: {
    flexDirection: "row",
    gap: 12,
  },
  climbingGradeItem: {
    alignItems: "center",
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 12,
    flex: 1,
    gap: 4,
    padding: 12,
  },
  climbingSubsection: {
    borderTopColor: colors.surfaceSecondary,
    borderTopWidth: 1,
    gap: 8,
    paddingTop: 12,
  },
  climbingSubsectionTitle: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
  },
  climbingVolumeRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
  },
  climbingGradeText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "700",
    minWidth: 48,
  },
  climbingMetaText: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  climbingSessionRow: {
    gap: 3,
  },
  climbingSessionName: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
  errorText: {
    color: "#f87171",
    fontSize: 13,
    textAlign: "center",
    paddingVertical: 24,
  },
});
