import { useRouter } from "expo-router";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { ActivityCard } from "../../components/ActivityCard";
import { MetricCard } from "../../components/MetricCard";
import { RecoveryRing } from "../../components/charts/RecoveryRing";
import { SleepBar } from "../../components/charts/SleepBar";
import { StrainGauge } from "../../components/charts/StrainGauge";
import { formatSleepDebtInline } from "../../lib/format";
import { trendDirection as computeTrend } from "../../lib/scoring";
import { trpc } from "../../lib/trpc";
import type {
  ActivityRow,
  HeartRateVariabilityRow,
  ReadinessRow,
  SleepAnalyticsResult,
  StressResult,
  WorkloadRow,
} from "../../types/api";
import { ActivityRowSchema } from "../../types/api";
import { colors } from "../../theme";

function todayString(): string {
  const now = new Date();
  return now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

export default function OverviewScreen() {
  const router = useRouter();

  // Fetch readiness/recovery score (last 7 days for trend)
  const readinessQuery = trpc.recovery.readinessScore.useQuery({ days: 7 });
  const readinessData = readinessQuery.data ?? [];
  const todayReadiness = readinessData[readinessData.length - 1];

  // Fetch sleep analytics for last night
  const sleepQuery = trpc.recovery.sleepAnalytics.useQuery({ days: 7 });
  const sleepResult = sleepQuery.data;
  const nightly = sleepResult?.nightly ?? [];
  const lastNight = nightly[nightly.length - 1];
  const sleepDebt = sleepResult?.sleepDebt ?? 0;

  // Fetch workload ratio for strain
  const workloadQuery = trpc.recovery.workloadRatio.useQuery({ days: 7 });
  const workloadData = workloadQuery.data ?? [];
  const todayWorkload = workloadData[workloadData.length - 1];

  // Fetch HRV trend
  const hrvQuery = trpc.recovery.hrvVariability.useQuery({ days: 14 });
  const hrvData = hrvQuery.data ?? [];
  const latestHrv = hrvData[hrvData.length - 1];

  // Fetch stress
  const stressQuery = trpc.stress.scores.useQuery({ days: 7 });
  const stressData = stressQuery.data;

  // Fetch recent activities
  const activitiesQuery = trpc.training.activityStats.useQuery({ days: 7 });
  const recentActivities = ActivityRowSchema.array()
    .catch([])
    .parse(activitiesQuery.data ?? [])
    .slice(0, 3);

  const recoveryScore = todayReadiness?.readinessScore ?? 0;
  const dailyStrain = todayWorkload?.dailyLoad ?? 0;

  const isLoading =
    readinessQuery.isLoading ||
    sleepQuery.isLoading ||
    workloadQuery.isLoading;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
    >
      <Text style={styles.date}>{todayString()}</Text>

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
              <RecoveryRing score={recoveryScore} size={180} />
            </View>
            <View style={styles.ringSection}>
              <Text style={styles.sectionLabel}>Strain</Text>
              <StrainGauge strain={dailyStrain} size={120} />
            </View>
          </View>

          {/* Recovery components breakdown */}
          {todayReadiness?.components && (
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
          {lastNight && (
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
              <Text style={styles.sectionTitle}>Recent Activities</Text>
              <View style={styles.activitiesStack}>
                {recentActivities.map((activity) => (
                  <ActivityCard
                    key={String(activity.id)}
                    name={activity.name ?? ""}
                    activityType={activity.activity_type ?? ""}
                    startedAt={activity.started_at}
                    endedAt={activity.ended_at ?? null}
                    avgHr={activity.avg_hr ?? null}
                    maxHr={activity.max_hr ?? null}
                    avgPower={activity.avg_power ?? null}
                  />
                ))}
              </View>
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}

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
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  activitiesStack: {
    gap: 8,
  },
});
