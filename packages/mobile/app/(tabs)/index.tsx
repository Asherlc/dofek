import {
  formatDateYmd,
  formatDurationMinutes,
  formatSleepDebtInline,
  isToday,
  isYesterday,
} from "@dofek/format/format";
import type { NextWorkoutRecommendation } from "dofek-server/types";
import { useRouter } from "expo-router";
import { useMemo } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Card } from "../../components/Card";
import { ChartTitleWithTooltip } from "../../components/ChartTitleWithTooltip";
import { RecoveryRing } from "../../components/charts/RecoveryRing";
import { SleepBar } from "../../components/charts/SleepBar";
import { StrainGauge } from "../../components/charts/StrainGauge";
import { OnboardingWelcome } from "../../components/OnboardingWelcome";
import { readinessLevelColor } from "../../lib/scoring";
import { trpc } from "../../lib/trpc";
import { useAutoSync } from "../../lib/useAutoSync";
import { useOnboarding } from "../../lib/useOnboarding";
import { useRefresh } from "../../lib/useRefresh";
import { colors } from "../../theme";

function todayString(): string {
  const now = new Date();
  return now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function recommendationTypeColor(type: NextWorkoutRecommendation["recommendationType"]): string {
  if (type === "rest") return colors.orange;
  if (type === "strength") return colors.positive;
  return colors.blue;
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

export default function TodayScreen() {
  const router = useRouter();
  const onboarding = useOnboarding();
  const days = 30;
  const endDate = useMemo(() => formatDateYmd(), []);

  // Fetch readiness/recovery score
  const readinessQuery = trpc.recovery.readinessScore.useQuery({ days, endDate });
  const readinessData = readinessQuery.data ?? [];
  const latestReadiness = readinessData[readinessData.length - 1];
  const todayReadiness = (() => {
    if (!latestReadiness) return undefined;
    const readinessDate = new Date(`${latestReadiness.date}T00:00:00`);
    return isToday(readinessDate) || isYesterday(readinessDate) ? latestReadiness : undefined;
  })();

  // Fetch sleep analytics for last night
  const sleepQuery = trpc.recovery.sleepAnalytics.useQuery({ days });
  const sleepResult = sleepQuery.data;
  const nightly = sleepResult?.nightly ?? [];
  const mostRecentNight = nightly[nightly.length - 1];
  const lastNight = (() => {
    if (!mostRecentNight) return undefined;
    const date = new Date(mostRecentNight.date);
    return isToday(date) || isYesterday(date) ? mostRecentNight : undefined;
  })();
  const sleepDebt = sleepResult?.sleepDebt ?? 0;

  // Fetch workload ratio for strain
  const workloadQuery = trpc.recovery.workloadRatio.useQuery({ days, endDate });
  const workloadResult = workloadQuery.data;

  // Auto-sync when data is stale
  const dailyMetricsQuery = trpc.dailyMetrics.trends.useQuery({ days, endDate });
  const metrics = dailyMetricsQuery.data;
  useAutoSync(metrics?.latest_date);

  // Next workout recommendation
  const nextWorkoutQuery = trpc.training.nextWorkout.useQuery({ endDate });
  const nextWorkout = nextWorkoutQuery.data;

  // Sleep need
  const sleepNeedQuery = trpc.sleepNeed.calculate.useQuery({ endDate });
  const sleepNeed = sleepNeedQuery.data;

  // Anomaly detection
  const anomalyQuery = trpc.anomalyDetection.check.useQuery({ endDate });
  const anomalies = anomalyQuery.data;

  const recoveryScore = todayReadiness?.readinessScore ?? null;
  const strainIsToday = workloadResult?.displayedDate
    ? isToday(new Date(`${workloadResult.displayedDate}T00:00:00`))
    : false;
  const dailyStrain = strainIsToday ? (workloadResult?.displayedStrain ?? 0) : 0;

  const readinessLoading = readinessQuery.isLoading;
  const workloadLoading = workloadQuery.isLoading;
  const sleepAnalyticsLoading = sleepQuery.isLoading;

  const triggerSync = trpc.sync.triggerSync.useMutation();
  const { refreshing, onRefresh } = useRefresh(() => {
    triggerSync.mutate({ sinceDays: 1 });
  });

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
      {/* Onboarding — shown to new users with no connected providers */}
      {onboarding.showOnboarding && (
        <OnboardingWelcome onDismiss={onboarding.dismiss} providers={onboarding.providers} />
      )}

      {/* Anomaly Alert Banner */}
      {anomalies != null && anomalies.anomalies.length > 0 && (
        <View style={styles.anomalyBanner}>
          <Text style={styles.anomalyIcon}>{"\u26A0\uFE0F"}</Text>
          <Text style={styles.anomalyText}>
            {anomalies.anomalies[0]?.metric}: {anomalies.anomalies[0]?.value} (baseline{" "}
            {anomalies.anomalies[0]?.baselineMean} ± {anomalies.anomalies[0]?.baselineStddev})
          </Text>
        </View>
      )}

      <Text style={styles.date}>{todayString()}</Text>

      {/* Log food */}
      <TouchableOpacity
        style={styles.quickAddButton}
        onPress={() => router.push("/food/add")}
        activeOpacity={0.7}
      >
        <Text style={styles.quickAddPlus}>+</Text>
        <Text style={styles.quickAddLabel}>Log Food</Text>
      </TouchableOpacity>

      {/* Recovery + Strain rings — tappable for navigation */}
      <View style={styles.ringsRow}>
        <TouchableOpacity
          style={styles.ringSection}
          onPress={() => router.navigate("/(tabs)/recovery")}
          activeOpacity={0.7}
        >
          <ChartTitleWithTooltip
            title="Recovery"
            description="This ring visualizes your readiness score based on recovery-related signals."
            textStyle={styles.sectionLabel}
          />
          {readinessLoading ? (
            <View style={[styles.emptyRing, { width: 180, height: 180, opacity: 0.4 }]}>
              <Text style={styles.emptyRingText}>...</Text>
            </View>
          ) : recoveryScore != null ? (
            <RecoveryRing score={recoveryScore} size={180} />
          ) : (
            <View style={[styles.emptyRing, { width: 180, height: 180 }]}>
              <Text style={styles.emptyRingText}>--</Text>
              <Text style={styles.emptyRingSubtext}>No data yet</Text>
            </View>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.ringSection}
          onPress={() => router.navigate("/(tabs)/strain")}
          activeOpacity={0.7}
        >
          <ChartTitleWithTooltip
            title="Strain"
            description="This gauge shows your most recent daily training strain relative to your recent baseline."
            textStyle={styles.sectionLabel}
          />
          {workloadLoading ? (
            <View style={[styles.emptyRing, { width: 120, height: 120, opacity: 0.4 }]}>
              <Text style={styles.emptyRingText}>...</Text>
            </View>
          ) : (
            <StrainGauge strain={dailyStrain} size={120} />
          )}
        </TouchableOpacity>
      </View>

      {/* Recovery components breakdown */}
      {todayReadiness?.components && (
        <Card title="Recovery Breakdown">
          <View style={styles.componentGrid}>
            <ComponentRow
              label="Heart Rate Variability"
              score={todayReadiness.components.hrvScore}
            />
            <ComponentRow
              label="Resting Heart Rate"
              score={todayReadiness.components.restingHrScore}
            />
            <ComponentRow label="Sleep Quality" score={todayReadiness.components.sleepScore} />
            <ComponentRow
              label="Respiratory Rate"
              score={todayReadiness.components.respiratoryRateScore}
            />
          </View>
        </Card>
      )}

      {/* Sleep summary */}
      {!sleepAnalyticsLoading && lastNight && (
        <TouchableOpacity activeOpacity={0.7} onPress={() => router.push("/sleep")}>
          <Card title="Last Night">
            <SleepBar
              durationMinutes={lastNight.durationMinutes}
              deepPercentage={lastNight.deepPct}
              remPercentage={lastNight.remPct}
              lightPercentage={lastNight.lightPct}
              awakePercentage={lastNight.awakePct}
            />
            {sleepDebt > 0 && (
              <Text style={styles.sleepDebt}>{formatSleepDebtInline(sleepDebt)}</Text>
            )}
          </Card>
        </TouchableOpacity>
      )}

      {/* Next Workout */}
      {nextWorkout != null && isToday(new Date(nextWorkout.generatedAt)) && (
        <Card title="Next Workout">
          <View style={styles.nextWorkoutHeader}>
            <View style={styles.nextWorkoutTitleWrap}>
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
              {nextWorkout.details.slice(0, 3).map((detail) => (
                <Text key={detail} style={styles.nextWorkoutListItem}>
                  {"\u2022"} {detail}
                </Text>
              ))}
            </View>
          )}
        </Card>
      )}

      {/* Sleep Coach */}
      {sleepNeed != null && (
        <Card title="Sleep Coach">
          {sleepNeed.canRecommend ? (
            <>
              <Text style={styles.sleepNeedTotal}>
                {formatDurationMinutes(sleepNeed.totalNeedMinutes)}
              </Text>
              <Text style={styles.sleepNeedSubtitle}>recommended tonight</Text>
            </>
          ) : (
            <Text style={styles.sleepNeedMissing}>Need last night's sleep for recommendation</Text>
          )}
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
        </Card>
      )}
    </ScrollView>
  );
}

// ── Helper Components ─────────────────────────────────────────────────

function ComponentRow({ label, score }: { label: string; score: number }) {
  const color = score >= 67 ? colors.positive : score >= 34 ? colors.warning : colors.danger;
  return (
    <View style={componentStyles.row}>
      <Text style={componentStyles.label}>{label}</Text>
      <View style={componentStyles.barTrack}>
        <View style={[componentStyles.barFill, { width: `${score}%`, backgroundColor: color }]} />
      </View>
      <Text style={[componentStyles.score, { color }]}>{score}</Text>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────

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
  componentGrid: {
    gap: 10,
  },
  sleepDebt: {
    fontSize: 12,
    color: colors.orange,
    marginTop: 4,
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
  sleepNeedMissing: {
    fontSize: 15,
    color: colors.textTertiary,
    marginTop: 4,
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
});
