import { useEffect, useState } from "react";
import type { NextWorkoutRecommendation } from "dofek-server/types";
import { useRouter } from "expo-router";
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Svg, { Polyline } from "react-native-svg";
import { ActivityCard } from "../../components/ActivityCard";
import { DaySelector } from "../../components/DaySelector";
import { MetricCard } from "../../components/MetricCard";
import { OnboardingWelcome } from "../../components/OnboardingWelcome";
import { RecoveryRing } from "../../components/charts/RecoveryRing";
import { SleepBar } from "../../components/charts/SleepBar";
import { StrainGauge } from "../../components/charts/StrainGauge";
import { formatDurationMinutes, formatSleepDebtInline } from "../../lib/format";
import { scoreColor, scoreLabel, trendDirection as computeTrend } from "../../lib/scoring";
import { trpc } from "../../lib/trpc";
import { convertTemperature, convertWeight, temperatureLabel, useUnitSystem, weightLabel } from "../../lib/units";
import { useOnboarding } from "../../lib/useOnboarding";
import { ActivityRowSchema } from "../../types/api";
import { colors, statusColors } from "../../theme";

function todayString(): string {
  const now = new Date();
  return now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

const RECENT_ACTIVITY_PAGE_SIZE = 3;

/** Strain zone label for weekly report */
function strainZoneLabel(zone: string): string {
  if (zone === "optimal") return "Optimal";
  if (zone === "overreaching") return "Overreaching";
  if (zone === "restoring") return "Restoring";
  return zone;
}

/** Color for strain zone */
function strainZoneColor(zone: string): string {
  if (zone === "optimal") return statusColors.positive;
  if (zone === "overreaching") return statusColors.danger;
  if (zone === "restoring") return statusColors.info;
  return colors.textSecondary;
}

/** Color for healthspan status */
function healthspanStatusColor(status: string): string {
  if (status === "excellent") return statusColors.positive;
  if (status === "good") return statusColors.positive;
  if (status === "fair") return statusColors.warning;
  if (status === "poor") return statusColors.danger;
  return colors.textSecondary;
}

/** Trend arrow for healthspan */
function trendArrow(trend: string | null): string {
  if (trend === "improving") return "\u2191";
  if (trend === "declining") return "\u2193";
  if (trend === "stable") return "\u2192";
  return "";
}

function recommendationTypeColor(
  type: NextWorkoutRecommendation["recommendationType"],
): string {
  if (type === "rest") return colors.orange;
  if (type === "strength") return colors.positive;
  return colors.blue;
}

function readinessLevelColor(
  level: NextWorkoutRecommendation["readiness"]["level"],
): string {
  if (level === "high") return colors.positive;
  if (level === "moderate") return colors.warning;
  if (level === "low") return colors.danger;
  return colors.textSecondary;
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

export default function OverviewScreen() {
  const router = useRouter();
  const onboarding = useOnboarding();
  const unitSystem = useUnitSystem();
  const [days, setDays] = useState(7);
  const [recentActivityPage, setRecentActivityPage] = useState(0);
  const showDetailedSections = false;

  // Fetch readiness/recovery score
  const readinessQuery = trpc.recovery.readinessScore.useQuery({ days });
  const readinessData = readinessQuery.data ?? [];
  const todayReadiness = readinessData[readinessData.length - 1];

  // Fetch sleep analytics for last night
  const sleepQuery = trpc.recovery.sleepAnalytics.useQuery({ days });
  const sleepResult = sleepQuery.data;
  const nightly = sleepResult?.nightly ?? [];
  const lastNight = nightly[nightly.length - 1];
  const sleepDebt = sleepResult?.sleepDebt ?? 0;

  // Fetch workload ratio for strain
  const workloadQuery = trpc.recovery.workloadRatio.useQuery({ days });
  const workloadData = workloadQuery.data ?? [];
  const todayWorkload = workloadData[workloadData.length - 1];

  // Fetch HRV trend
  const hrvQuery = trpc.recovery.hrvVariability.useQuery({ days: Math.max(days, 14) });
  const hrvData = hrvQuery.data ?? [];
  const latestHrv = hrvData[hrvData.length - 1];

  // Fetch stress
  const stressQuery = trpc.stress.scores.useQuery({ days });
  const stressData = stressQuery.data;

  // Fetch recent activities
  const activitiesQuery = trpc.activity.list.useQuery({
    days,
    limit: RECENT_ACTIVITY_PAGE_SIZE,
    offset: recentActivityPage * RECENT_ACTIVITY_PAGE_SIZE,
  });

  useEffect(() => {
    setRecentActivityPage(0);
  }, [days]);

  const recentActivities = ActivityRowSchema.array()
    .catch([])
    .parse(activitiesQuery.data?.items ?? []);
  const recentActivitiesTotalCount = activitiesQuery.data?.totalCount ?? 0;
  const recentActivitiesTotalPages = Math.ceil(
    recentActivitiesTotalCount / RECENT_ACTIVITY_PAGE_SIZE,
  );

  // Health metrics (latest)
  const dailyMetricsQuery = trpc.dailyMetrics.trends.useQuery({ days });
  const metrics = dailyMetricsQuery.data;

  // Weekly report
  const weeklyReportQuery = trpc.weeklyReport.report.useQuery({ weeks: Math.max(Math.ceil(days / 7), 1) });
  const weeklyReport = weeklyReportQuery.data;

  // Next workout recommendation
  const nextWorkoutQuery = trpc.training.nextWorkout.useQuery();
  const nextWorkout = nextWorkoutQuery.data;

  // Sleep need
  const sleepNeedQuery = trpc.sleepNeed.calculate.useQuery();
  const sleepNeed = sleepNeedQuery.data;

  // Healthspan
  const healthspanQuery = trpc.healthspan.score.useQuery({ weeks: Math.max(Math.ceil(days / 7), 4) });
  const healthspan = healthspanQuery.data;

  // Nutrition
  const nutritionQuery = trpc.nutrition.daily.useQuery({ days });
  const nutritionData = nutritionQuery.data ?? [];

  // Body analytics
  const weightQuery = trpc.bodyAnalytics.smoothedWeight.useQuery({ days: Math.max(days, 90) });
  const weightData = weightQuery.data ?? [];

  // Anomaly detection
  const anomalyQuery = trpc.anomalyDetection.check.useQuery();
  const anomalies = anomalyQuery.data;

  // Steps (from daily metrics)
  const stepsQuery = trpc.dailyMetrics.list.useQuery({ days });
  const stepsData = stepsQuery.data ?? [];

  const recoveryScore = todayReadiness?.readinessScore ?? null;
  const dailyStrain = todayWorkload?.dailyLoad ?? 0;

  const isLoading =
    readinessQuery.isLoading ||
    sleepQuery.isLoading ||
    workloadQuery.isLoading;

  // Derive data for new sections
  const currentWeek = weeklyReport?.current;

  const latestNutrition = nutritionData.length > 0
    ? nutritionData[nutritionData.length - 1]
    : null;

  const latestWeight = weightData.length > 0
    ? weightData[weightData.length - 1]
    : null;

  const latestSteps = stepsData.length > 0
    ? stepsData[stepsData.length - 1]
    : null;

  const stepsAvg7d = stepsData.length > 0
    ? Math.round(
        stepsData.reduce((sum: number, d: Record<string, unknown>) => sum + (Number(d.steps) || 0), 0) / stepsData.length,
      )
    : null;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
    >
      {/* Onboarding — shown to new users with no connected providers */}
      {onboarding.showOnboarding && (
        <OnboardingWelcome
          onDismiss={onboarding.dismiss}
          providers={onboarding.providers}
        />
      )}

      {/* Anomaly Alert Banner — at the very top before date */}
      {anomalies != null && anomalies.anomalies.length > 0 && (
        <View style={styles.anomalyBanner}>
          <Text style={styles.anomalyIcon}>{"\u26A0\uFE0F"}</Text>
          <Text style={styles.anomalyText}>
            {anomalies.anomalies[0]?.metric}: {anomalies.anomalies[0]?.value}{" "}
            (baseline {anomalies.anomalies[0]?.baselineMean} ±{" "}
            {anomalies.anomalies[0]?.baselineStddev})
          </Text>
        </View>
      )}

      <Text style={styles.date}>{todayString()}</Text>

      <DaySelector days={days} onChange={setDays} />

      <View style={styles.detailsHintCard}>
        <Text style={styles.detailsHintText}>
          Detailed analytics are available in Sleep, Strain, Food, Trends, Training, and Insights.
        </Text>
      </View>

      {/* Log food — navigates to full search/scan/quick-add screen */}
      <TouchableOpacity
        style={styles.quickAddButton}
        onPress={() => router.push("/food/add")}
        activeOpacity={0.7}
      >
        <Text style={styles.quickAddPlus}>+</Text>
        <Text style={styles.quickAddLabel}>Log Food</Text>
      </TouchableOpacity>

      {isLoading ? (
        <View style={styles.loadingContainer}>
          <Text style={styles.loadingText}>Loading your data...</Text>
        </View>
      ) : (
        <>
          {/* Recovery + Strain rings */}
          <View style={styles.ringsRow}>
            <View style={styles.ringSection}>
              <Text style={styles.sectionLabel}>Recovery</Text>
              {recoveryScore != null ? (
                <RecoveryRing score={recoveryScore} size={180} />
              ) : (
                <View style={[styles.emptyRing, { width: 180, height: 180 }]}>
                  <Text style={styles.emptyRingText}>--</Text>
                  <Text style={styles.emptyRingSubtext}>No data yet</Text>
                </View>
              )}
            </View>
            <View style={styles.ringSection}>
              <Text style={styles.sectionLabel}>Strain</Text>
              <StrainGauge strain={dailyStrain} size={120} />
            </View>
          </View>

          {/* Recovery components breakdown */}
          {showDetailedSections && todayReadiness?.components && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Recovery Breakdown</Text>
              <View style={styles.componentGrid}>
                <ComponentRow
                  label="Heart Rate Variability"
                  score={todayReadiness.components.hrvScore}
                />
                <ComponentRow
                  label="Resting Heart Rate"
                  score={todayReadiness.components.restingHrScore}
                />
                <ComponentRow
                  label="Sleep Quality"
                  score={todayReadiness.components.sleepScore}
                />
                <ComponentRow
                  label="Training Balance"
                  score={todayReadiness.components.loadBalanceScore}
                />
              </View>
            </View>
          )}

          {/* Sleep summary */}
          {showDetailedSections && lastNight && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Last Night</Text>
              <SleepBar
                durationMinutes={lastNight.durationMinutes}
                deepPct={lastNight.deepPct}
                remPct={lastNight.remPct}
                lightPct={lastNight.lightPct}
                awakePct={lastNight.awakePct}
              />
              {sleepDebt > 0 && (
                <Text style={styles.sleepDebt}>
                  {formatSleepDebtInline(sleepDebt)}
                </Text>
              )}
            </View>
          )}

          {/* Key metrics row */}
          <View style={styles.metricsGrid}>
            <MetricCard
              title="Heart Rate Variability"
              value={latestHrv?.hrv != null ? String(Math.round(latestHrv.hrv)) : "--"}
              unit="ms"
              trend={hrvData.filter((d) => d.hrv != null).map((d) => d.hrv as number)}
              color={colors.positive}
              trendDirection={
                hrvData.length >= 2
                  ? computeTrend(
                      hrvData[hrvData.length - 1]?.hrv ?? 0,
                      hrvData[hrvData.length - 2]?.hrv ?? 0,
                    )
                  : undefined
              }
            />
            <MetricCard
              title="Stress"
              value={
                stressData?.latestScore != null
                  ? stressData.latestScore.toFixed(1)
                  : "--"
              }
              unit="/ 3"
              color={
                (stressData?.latestScore ?? 0) >= 2
                  ? colors.danger
                  : (stressData?.latestScore ?? 0) >= 1
                    ? colors.warning
                    : colors.positive
              }
              subtitle={stressData?.trend ? `Trend: ${stressData.trend}` : undefined}
            />
          </View>

          {/* Recent activities */}
          {recentActivities.length > 0 && (
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Recent Activities</Text>
                <TouchableOpacity onPress={() => router.push("/activities")}>
                  <Text style={styles.viewAllLink}>View All</Text>
                </TouchableOpacity>
              </View>
              <View style={styles.activitiesStack}>
                {recentActivities.map((activity) => (
                  <TouchableOpacity
                    key={String(activity.id)}
                    activeOpacity={0.7}
                    onPress={() => router.push(`/activity/${activity.id}`)}
                  >
                    <ActivityCard
                      name={activity.name ?? ""}
                      activityType={activity.activity_type ?? ""}
                      startedAt={activity.started_at}
                      endedAt={activity.ended_at ?? null}
                      avgHr={activity.avg_hr ?? null}
                      maxHr={activity.max_hr ?? null}
                      avgPower={activity.avg_power ?? null}
                    />
                  </TouchableOpacity>
                ))}
              </View>
              {recentActivitiesTotalPages > 1 && (
                <View style={styles.paginationRow}>
                  <TouchableOpacity
                    onPress={() => setRecentActivityPage((p) => Math.max(0, p - 1))}
                    disabled={recentActivityPage <= 0}
                    style={[
                      styles.pageButton,
                      recentActivityPage <= 0 && styles.pageButtonDisabled,
                    ]}
                  >
                    <Text
                      style={[
                        styles.pageButtonText,
                        recentActivityPage <= 0 && styles.pageButtonTextDisabled,
                      ]}
                    >
                      Previous
                    </Text>
                  </TouchableOpacity>
                  <Text style={styles.pageInfo}>
                    {recentActivityPage + 1} / {recentActivitiesTotalPages}
                  </Text>
                  <TouchableOpacity
                    onPress={() =>
                      setRecentActivityPage((p) =>
                        Math.min(recentActivitiesTotalPages - 1, p + 1),
                      )
                    }
                    disabled={recentActivityPage >= recentActivitiesTotalPages - 1}
                    style={[
                      styles.pageButton,
                      recentActivityPage >= recentActivitiesTotalPages - 1 &&
                        styles.pageButtonDisabled,
                    ]}
                  >
                    <Text
                      style={[
                        styles.pageButtonText,
                        recentActivityPage >= recentActivitiesTotalPages - 1 &&
                          styles.pageButtonTextDisabled,
                      ]}
                    >
                      Next
                    </Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}

          {/* Health Status Bar — horizontal scrolling mini metrics */}
          {showDetailedSections && metrics != null && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Health Status</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.healthStatusRow}
              >
                <MiniMetricCard
                  label="Resting HR"
                  value={metrics.latest_resting_hr != null ? String(Math.round(metrics.latest_resting_hr)) : "--"}
                  unit="bpm"
                />
                <MiniMetricCard
                  label="Heart Rate Variability"
                  value={metrics.latest_hrv != null ? String(Math.round(metrics.latest_hrv)) : "--"}
                  unit="ms"
                />
                <MiniMetricCard
                  label="Blood Oxygen"
                  value={metrics.latest_spo2 != null ? String(Math.round(metrics.latest_spo2)) : "--"}
                  unit="%"
                />
                <MiniMetricCard
                  label="Steps"
                  value={metrics.latest_steps != null ? String(Math.round(metrics.latest_steps)) : "--"}
                />
                <MiniMetricCard
                  label="Active Energy"
                  value={metrics.latest_active_energy != null ? String(Math.round(metrics.latest_active_energy)) : "--"}
                  unit="kcal"
                />
                <MiniMetricCard
                  label="Skin Temp"
                  value={metrics.latest_skin_temp != null ? convertTemperature(metrics.latest_skin_temp, unitSystem).toFixed(1) : "--"}
                  unit={temperatureLabel(unitSystem)}
                />
              </ScrollView>
            </View>
          )}

          {/* Weekly Report */}
          {showDetailedSections && currentWeek != null && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Weekly Report</Text>
              <View style={styles.weeklyReportContent}>
                <View style={styles.weeklyReportRow}>
                  <Text style={styles.weeklyLabel}>Strain Balance</Text>
                  <Text
                    style={[
                      styles.weeklyValue,
                      { color: strainZoneColor(currentWeek.strainZone) },
                    ]}
                  >
                    {strainZoneLabel(currentWeek.strainZone)}
                  </Text>
                </View>
                <View style={styles.weeklyReportRow}>
                  <Text style={styles.weeklyLabel}>Sleep vs Baseline</Text>
                  <Text
                    style={[
                      styles.weeklyValue,
                      {
                        color:
                          currentWeek.sleepPerformancePct >= 100
                            ? statusColors.positive
                            : currentWeek.sleepPerformancePct >= 90
                              ? statusColors.warning
                              : statusColors.danger,
                      },
                    ]}
                  >
                    {currentWeek.sleepPerformancePct}%
                  </Text>
                </View>
                {currentWeek.avgRestingHr != null && (
                  <View style={styles.weeklyReportRow}>
                    <Text style={styles.weeklyLabel}>Avg Resting HR</Text>
                    <Text style={styles.weeklyValue}>
                      {Math.round(currentWeek.avgRestingHr)} bpm
                    </Text>
                  </View>
                )}
                {currentWeek.avgHrv != null && (
                  <View style={styles.weeklyReportRow}>
                    <Text style={styles.weeklyLabel}>Avg Heart Rate Variability</Text>
                    <Text style={styles.weeklyValue}>
                      {Math.round(currentWeek.avgHrv)} ms
                    </Text>
                  </View>
                )}
              </View>
            </View>
          )}

          {/* Next Workout */}
          {nextWorkout != null && (
            <View style={styles.card}>
              <View style={styles.nextWorkoutHeader}>
                <View style={styles.nextWorkoutTitleWrap}>
                  <Text style={styles.cardTitle}>Next Workout</Text>
                  <Text style={styles.nextWorkoutTitle}>{nextWorkout.title}</Text>
                </View>
                <View
                  style={[
                    styles.nextWorkoutTypeBadge,
                    {
                      borderColor: recommendationTypeColor(nextWorkout.recommendationType),
                      backgroundColor: `${recommendationTypeColor(nextWorkout.recommendationType)}20`,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.nextWorkoutTypeLabel,
                      { color: recommendationTypeColor(nextWorkout.recommendationType) },
                    ]}
                  >
                    {capitalize(nextWorkout.recommendationType)}
                  </Text>
                </View>
              </View>

              <Text style={styles.nextWorkoutSummary}>{nextWorkout.shortBlurb}</Text>
              <Text
                style={[
                  styles.nextWorkoutReadiness,
                  { color: readinessLevelColor(nextWorkout.readiness.level) },
                ]}
              >
                Readiness:{" "}
                {nextWorkout.readiness.score != null
                  ? `${nextWorkout.readiness.score}/100 (${nextWorkout.readiness.level})`
                  : "Unavailable"}
              </Text>

              {nextWorkout.cardio != null && (
                <Text style={styles.nextWorkoutMeta}>
                  Cardio: {nextWorkout.cardio.durationMinutes} minutes ({nextWorkout.cardio.focus})
                </Text>
              )}
              {nextWorkout.strength != null && nextWorkout.strength.focusMuscles.length > 0 && (
                <Text style={styles.nextWorkoutMeta}>
                  Strength focus: {nextWorkout.strength.focusMuscles.join(", ")}
                </Text>
              )}

              {nextWorkout.details.length > 0 && (
                <View style={styles.nextWorkoutList}>
                  <Text style={styles.nextWorkoutListTitle}>Plan</Text>
                  {nextWorkout.details.slice(0, 3).map((detail, index) => (
                    <Text key={`next-workout-detail-${index}`} style={styles.nextWorkoutListItem}>
                      {"\u2022"} {detail}
                    </Text>
                  ))}
                </View>
              )}
            </View>
          )}

          {/* Sleep Coach */}
          {showDetailedSections && sleepNeed != null && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Sleep Coach</Text>
              <Text style={styles.sleepNeedTotal}>
                {formatDurationMinutes(sleepNeed.totalNeedMinutes)}
              </Text>
              <Text style={styles.sleepNeedSubtitle}>recommended tonight</Text>
              <View style={styles.sleepNeedBreakdown}>
                <View style={styles.sleepNeedRow}>
                  <Text style={styles.sleepNeedLabel}>Baseline need</Text>
                  <Text style={styles.sleepNeedValue}>
                    {formatDurationMinutes(sleepNeed.baselineMinutes)}
                  </Text>
                </View>
                <View style={styles.sleepNeedRow}>
                  <Text style={styles.sleepNeedLabel}>Strain debt</Text>
                  <Text style={styles.sleepNeedValue}>
                    +{formatDurationMinutes(sleepNeed.strainDebtMinutes)}
                  </Text>
                </View>
                <View style={styles.sleepNeedRow}>
                  <Text style={styles.sleepNeedLabel}>Accumulated debt</Text>
                  <Text style={styles.sleepNeedValue}>
                    +{formatDurationMinutes(Math.round(sleepNeed.accumulatedDebtMinutes * 0.25))}
                  </Text>
                </View>
              </View>
            </View>
          )}

          {/* Healthspan Score */}
          {showDetailedSections &&
            healthspan != null &&
            healthspan.healthspanScore != null &&
            healthspan.metrics.length > 0 && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Healthspan Score</Text>
              <View style={styles.healthspanRow}>
                <Text
                  style={[
                    styles.healthspanScore,
                    { color: scoreColor(healthspan.healthspanScore) },
                  ]}
                >
                  {healthspan.healthspanScore}
                </Text>
                <View style={styles.healthspanMeta}>
                  <Text
                    style={[
                      styles.healthspanStatus,
                      { color: scoreColor(healthspan.healthspanScore) },
                    ]}
                  >
                    {scoreLabel(healthspan.healthspanScore)}
                  </Text>
                  {healthspan.trend != null && (
                    <Text
                      style={[
                        styles.healthspanTrend,
                        {
                          color:
                            healthspan.trend === "improving"
                              ? statusColors.positive
                              : healthspan.trend === "declining"
                                ? statusColors.danger
                                : colors.textSecondary,
                        },
                      ]}
                    >
                      {trendArrow(healthspan.trend)} {healthspan.trend}
                    </Text>
                  )}
                </View>
              </View>
            </View>
          )}

          {/* Daily Steps */}
          {showDetailedSections && latestSteps != null && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Daily Steps</Text>
              <Text style={styles.stepsValue}>
                {Number(latestSteps.steps) > 0
                  ? Number(latestSteps.steps).toLocaleString()
                  : "--"}
              </Text>
              {stepsAvg7d != null && stepsAvg7d > 0 && (
                <Text style={styles.stepsAvg}>
                  7-day avg: {stepsAvg7d.toLocaleString()}
                </Text>
              )}
            </View>
          )}

          {/* Nutrition Summary */}
          {showDetailedSections && latestNutrition != null && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Nutrition Today</Text>
              <Text style={styles.caloriesValue}>
                {Number(latestNutrition.calories) > 0
                  ? Math.round(Number(latestNutrition.calories)).toLocaleString()
                  : "--"}
              </Text>
              <Text style={styles.caloriesUnit}>kcal</Text>
              <View style={styles.macrosRow}>
                <MacroBar
                  label="Protein"
                  grams={Number(latestNutrition.protein_g ?? latestNutrition.proteinG ?? 0)}
                  color={statusColors.info}
                  totalCalories={Number(latestNutrition.calories) || 1}
                />
                <MacroBar
                  label="Carbs"
                  grams={Number(latestNutrition.carbs_g ?? latestNutrition.carbsG ?? 0)}
                  color={statusColors.positive}
                  totalCalories={Number(latestNutrition.calories) || 1}
                />
                <MacroBar
                  label="Fat"
                  grams={Number(latestNutrition.fat_g ?? latestNutrition.fatG ?? 0)}
                  color={statusColors.warning}
                  totalCalories={Number(latestNutrition.calories) || 1}
                />
              </View>
            </View>
          )}

          {/* Body Weight */}
          {showDetailedSections && latestWeight != null && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Body Weight</Text>
              <View style={styles.weightRow}>
                <View>
                  <Text style={styles.weightValue}>
                    {convertWeight(latestWeight.smoothedWeight, unitSystem).toFixed(1)}
                  </Text>
                  <Text style={styles.weightUnit}>{weightLabel(unitSystem)}</Text>
                </View>
                {weightData.length >= 2 && (
                  <WeightSparkline
                    data={weightData.map((d) => d.smoothedWeight)}
                    width={160}
                    height={50}
                  />
                )}
              </View>
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}

// ── Helper Components ─────────────────────────────────────────────────

function ComponentRow({ label, score }: { label: string; score: number }) {
  const color =
    score >= 67 ? colors.positive : score >= 34 ? colors.warning : colors.danger;
  return (
    <View style={componentStyles.row}>
      <Text style={componentStyles.label}>{label}</Text>
      <View style={componentStyles.barTrack}>
        <View
          style={[
            componentStyles.barFill,
            { width: `${score}%`, backgroundColor: color },
          ]}
        />
      </View>
      <Text style={[componentStyles.score, { color }]}>{score}</Text>
    </View>
  );
}

function MiniMetricCard({
  label,
  value,
  unit,
}: {
  label: string;
  value: string;
  unit?: string;
}) {
  return (
    <View style={miniMetricStyles.card}>
      <Text style={miniMetricStyles.label}>{label}</Text>
      <View style={miniMetricStyles.valueRow}>
        <Text style={miniMetricStyles.value}>{value}</Text>
        {unit != null && <Text style={miniMetricStyles.unit}>{unit}</Text>}
      </View>
    </View>
  );
}

function MacroBar({
  label,
  grams,
  color,
  totalCalories,
}: {
  label: string;
  grams: number;
  color: string;
  totalCalories: number;
}) {
  // Approximate calorie contribution: protein=4, carbs=4, fat=9
  const calMultiplier = label === "Fat" ? 9 : 4;
  const macroCalories = grams * calMultiplier;
  const pct = totalCalories > 0 ? Math.min(100, Math.round((macroCalories / totalCalories) * 100)) : 0;

  return (
    <View style={macroStyles.container}>
      <View style={macroStyles.labelRow}>
        <Text style={macroStyles.label}>{label}</Text>
        <Text style={macroStyles.grams}>{Math.round(grams)}g</Text>
      </View>
      <View style={macroStyles.barTrack}>
        <View
          style={[
            macroStyles.barFill,
            { width: `${pct}%`, backgroundColor: color },
          ]}
        />
      </View>
    </View>
  );
}

function WeightSparkline({
  data,
  width,
  height,
}: {
  data: number[];
  width: number;
  height: number;
}) {
  if (data.length < 2) return null;

  const padding = 4;
  const chartWidth = width - padding * 2;
  const chartHeight = height - padding * 2;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const points = data
    .map((value, index) => {
      const x = padding + (index / (data.length - 1)) * chartWidth;
      const y = padding + chartHeight - ((value - min) / range) * chartHeight;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <Svg width={width} height={height}>
      <Polyline
        points={points}
        fill="none"
        stroke={colors.blue}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────

const miniMetricStyles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 12,
    minWidth: 90,
    alignItems: "center",
    gap: 4,
    marginRight: 8,
  },
  label: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  valueRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 2,
  },
  value: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  unit: {
    fontSize: 11,
    color: colors.textSecondary,
    fontWeight: "500",
  },
});

const macroStyles = StyleSheet.create({
  container: {
    flex: 1,
    gap: 4,
  },
  labelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  label: {
    fontSize: 12,
    color: colors.textSecondary,
    fontWeight: "500",
  },
  grams: {
    fontSize: 12,
    color: colors.text,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  barTrack: {
    height: 6,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 3,
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    borderRadius: 3,
  },
});

const componentStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  label: {
    fontSize: 13,
    color: colors.textSecondary,
    width: 140,
  },
  barTrack: {
    flex: 1,
    height: 6,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 3,
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    borderRadius: 3,
  },
  score: {
    fontSize: 14,
    fontWeight: "700",
    width: 30,
    textAlign: "right",
    fontVariant: ["tabular-nums"],
  },
});

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
  date: {
    fontSize: 15,
    color: colors.textSecondary,
    fontWeight: "500",
  },
  detailsHintCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  detailsHintText: {
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 16,
  },
  quickAddButton: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 14,
    gap: 10,
  },
  quickAddPlus: {
    fontSize: 22,
    fontWeight: "600",
    color: colors.accent,
    width: 28,
    textAlign: "center",
  },
  quickAddLabel: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.text,
  },
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 80,
  },
  loadingText: {
    fontSize: 16,
    color: colors.textTertiary,
  },
  emptyRing: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    borderWidth: 14,
    borderColor: colors.surfaceSecondary,
  },
  emptyRingText: {
    fontSize: 48,
    fontWeight: "800",
    color: colors.textTertiary,
  },
  emptyRingSubtext: {
    fontSize: 14,
    color: colors.textTertiary,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  ringsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    paddingVertical: 8,
  },
  ringSection: {
    alignItems: "center",
    gap: 8,
  },
  sectionLabel: {
    fontSize: 13,
    color: colors.textSecondary,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
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
  componentGrid: {
    gap: 10,
  },
  sleepDebt: {
    fontSize: 12,
    color: colors.orange,
    marginTop: 4,
  },
  metricsGrid: {
    gap: 12,
  },
  section: {
    gap: 12,
  },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  viewAllLink: {
    fontSize: 13,
    fontWeight: "500",
    color: colors.accent,
  },
  activitiesStack: {
    gap: 8,
  },
  paginationRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingTop: 4,
  },
  pageButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.surface,
    borderRadius: 8,
  },
  pageButtonDisabled: {
    opacity: 0.4,
  },
  pageButtonText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "500",
  },
  pageButtonTextDisabled: {
    color: colors.textTertiary,
  },
  pageInfo: {
    color: colors.textSecondary,
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },
  // Anomaly banner
  anomalyBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 12,
    gap: 10,
    borderWidth: 1,
    borderColor: colors.warning,
  },
  anomalyIcon: {
    fontSize: 20,
  },
  anomalyText: {
    flex: 1,
    fontSize: 13,
    color: colors.text,
    fontWeight: "500",
  },
  // Health status bar
  healthStatusRow: {
    gap: 0,
    paddingRight: 16,
  },
  // Weekly report
  weeklyReportContent: {
    gap: 8,
  },
  weeklyReportRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  weeklyLabel: {
    fontSize: 14,
    color: colors.textSecondary,
  },
  weeklyValue: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
  },
  // Next workout
  nextWorkoutHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
  },
  nextWorkoutTitleWrap: {
    flex: 1,
    gap: 6,
  },
  nextWorkoutTitle: {
    fontSize: 22,
    fontWeight: "700",
    color: colors.text,
  },
  nextWorkoutTypeBadge: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginTop: 2,
  },
  nextWorkoutTypeLabel: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  nextWorkoutSummary: {
    fontSize: 14,
    color: colors.text,
    lineHeight: 20,
  },
  nextWorkoutReadiness: {
    fontSize: 13,
    fontWeight: "600",
  },
  nextWorkoutMeta: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  nextWorkoutList: {
    gap: 6,
    marginTop: 2,
  },
  nextWorkoutListTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  nextWorkoutListItem: {
    fontSize: 13,
    color: colors.text,
    lineHeight: 19,
  },
  // Sleep coach
  sleepNeedTotal: {
    fontSize: 32,
    fontWeight: "700",
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  sleepNeedSubtitle: {
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: -8,
  },
  sleepNeedBreakdown: {
    gap: 6,
    marginTop: 4,
  },
  sleepNeedRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  sleepNeedLabel: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  sleepNeedValue: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  // Healthspan
  healthspanRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  healthspanScore: {
    fontSize: 48,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  healthspanMeta: {
    gap: 4,
  },
  healthspanStatus: {
    fontSize: 16,
    fontWeight: "600",
  },
  healthspanTrend: {
    fontSize: 13,
    fontWeight: "500",
    textTransform: "capitalize",
  },
  // Steps
  stepsValue: {
    fontSize: 32,
    fontWeight: "700",
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  stepsAvg: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  // Nutrition
  caloriesValue: {
    fontSize: 32,
    fontWeight: "700",
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  caloriesUnit: {
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: -8,
  },
  macrosRow: {
    flexDirection: "row",
    gap: 12,
    marginTop: 4,
  },
  // Body weight
  weightRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  weightValue: {
    fontSize: 32,
    fontWeight: "700",
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  weightUnit: {
    fontSize: 13,
    color: colors.textSecondary,
  },
});
