import { ScrollView, StyleSheet, Text, View } from "react-native";
import { ActivityCard } from "../../components/ActivityCard";
import { MetricCard } from "../../components/MetricCard";
import { RecoveryRing } from "../../components/charts/RecoveryRing";
import { SleepBar } from "../../components/charts/SleepBar";
import { StrainGauge } from "../../components/charts/StrainGauge";
import { trpc } from "../../lib/trpc";

interface ReadinessRow {
  date: string;
  readinessScore: number;
  components: {
    hrvScore: number;
    restingHrScore: number;
    sleepScore: number;
    loadBalanceScore: number;
  };
}

interface SleepNightlyRow {
  date: string;
  durationMinutes: number;
  deepPct: number;
  remPct: number;
  lightPct: number;
  awakePct: number;
  efficiency: number;
  rollingAvgDuration: number | null;
}

interface WorkloadRow {
  date: string;
  dailyLoad: number;
  acuteLoad: number;
  chronicLoad: number;
  workloadRatio: number | null;
}

interface HrvRow {
  date: string;
  hrv: number | null;
  rollingCoefficientOfVariation: number | null;
  rollingMean: number | null;
}

interface StressResult {
  daily: Array<{ date: string; stressScore: number }>;
  weekly: Array<{ weekStart: string; cumulativeStress: number; avgDailyStress: number; highStressDays: number }>;
  latestScore: number | null;
  trend: "improving" | "worsening" | "stable";
}

function todayString(): string {
  const now = new Date();
  return now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

export default function OverviewScreen() {
  // Fetch readiness/recovery score (last 7 days for trend)
  const readinessQuery = trpc.recovery.readinessScore.useQuery({ days: 7 });
  const readinessData = (readinessQuery.data ?? []) as ReadinessRow[];
  const todayReadiness = readinessData[readinessData.length - 1];

  // Fetch sleep analytics for last night
  const sleepQuery = trpc.recovery.sleepAnalytics.useQuery({ days: 7 });
  const sleepResult = sleepQuery.data as { nightly: SleepNightlyRow[]; sleepDebt: number } | undefined;
  const lastNight = sleepResult?.nightly?.[sleepResult.nightly.length - 1];
  const sleepDebt = sleepResult?.sleepDebt ?? 0;

  // Fetch workload ratio for strain
  const workloadQuery = trpc.recovery.workloadRatio.useQuery({ days: 7 });
  const workloadData = (workloadQuery.data ?? []) as WorkloadRow[];
  const todayWorkload = workloadData[workloadData.length - 1];

  // Fetch HRV trend
  const hrvQuery = trpc.recovery.hrvVariability.useQuery({ days: 14 });
  const hrvData = (hrvQuery.data ?? []) as HrvRow[];
  const latestHrv = hrvData[hrvData.length - 1];

  // Fetch stress
  const stressQuery = trpc.stress.scores.useQuery({ days: 7 });
  const stressData = stressQuery.data as StressResult | undefined;

  // Fetch recent activities
  const activitiesQuery = trpc.training.activityStats.useQuery({ days: 7 });
  const recentActivities = ((activitiesQuery.data ?? []) as Array<Record<string, unknown>>).slice(0, 3);

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
                  {Math.round(sleepDebt / 60)}h {sleepDebt % 60}m sleep debt (14 days)
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
              trend={hrvData.filter((d: HrvRow) => d.hrv != null).map((d: HrvRow) => d.hrv as number)}
              color="#00E676"
              trendDirection={
                hrvData.length >= 2
                  ? (hrvData[hrvData.length - 1]?.hrv ?? 0) >
                    (hrvData[hrvData.length - 2]?.hrv ?? 0)
                    ? "up"
                    : "down"
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
                  ? "#FF3D00"
                  : (stressData?.latestScore ?? 0) >= 1
                    ? "#FFD600"
                    : "#00E676"
              }
              subtitle={stressData?.trend ? `Trend: ${stressData.trend}` : undefined}
            />
          </View>

          {/* Recent activities */}
          {recentActivities.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Recent Activities</Text>
              <View style={styles.activitiesStack}>
                {recentActivities.map((activity: Record<string, unknown>) => (
                  <ActivityCard
                    key={String(activity.id)}
                    name={String(activity.name ?? "")}
                    activityType={String(activity.activity_type ?? "")}
                    startedAt={String(activity.started_at)}
                    endedAt={
                      activity.ended_at != null
                        ? String(activity.ended_at)
                        : null
                    }
                    avgHr={
                      activity.avg_hr != null ? Number(activity.avg_hr) : null
                    }
                    maxHr={
                      activity.max_hr != null ? Number(activity.max_hr) : null
                    }
                    avgPower={
                      activity.avg_power != null
                        ? Number(activity.avg_power)
                        : null
                    }
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
    score >= 67 ? "#00E676" : score >= 34 ? "#FFD600" : "#FF3D00";
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

import { StyleSheet as ComponentStyleSheet } from "react-native";

const componentStyles = ComponentStyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  label: {
    fontSize: 13,
    color: "#8e8e93",
    width: 140,
  },
  barTrack: {
    flex: 1,
    height: 6,
    backgroundColor: "#2a2a2e",
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
    backgroundColor: "#000",
  },
  content: {
    padding: 16,
    paddingBottom: 100,
    gap: 16,
  },
  date: {
    fontSize: 15,
    color: "#8e8e93",
    fontWeight: "500",
  },
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 80,
  },
  loadingText: {
    fontSize: 16,
    color: "#636366",
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
    color: "#8e8e93",
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  card: {
    backgroundColor: "#1c1c1e",
    borderRadius: 16,
    padding: 16,
    gap: 12,
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: "#8e8e93",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  componentGrid: {
    gap: 10,
  },
  sleepDebt: {
    fontSize: 12,
    color: "#FF8A65",
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
    color: "#8e8e93",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  activitiesStack: {
    gap: 8,
  },
});
