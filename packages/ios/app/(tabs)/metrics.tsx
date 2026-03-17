import { ScrollView, StyleSheet, Text, View } from "react-native";
import { MetricCard } from "../../components/MetricCard";
import { SparkLine } from "../../components/charts/SparkLine";
import { trpc } from "../../lib/trpc";

interface HrvRow {
  date: string;
  hrv: number | null;
  rollingCoefficientOfVariation: number | null;
  rollingMean: number | null;
}

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

interface StressResult {
  daily: Array<{ date: string; stressScore: number }>;
  weekly: Array<{ weekStart: string; cumulativeStress: number; avgDailyStress: number; highStressDays: number }>;
  latestScore: number | null;
  trend: "improving" | "worsening" | "stable";
}

interface WorkloadRow {
  date: string;
  dailyLoad: number;
  acuteLoad: number;
  chronicLoad: number;
  workloadRatio: number | null;
}

export default function MetricsScreen() {
  // HRV trend
  const hrvQuery = trpc.recovery.hrvVariability.useQuery({ days: 30 });
  const hrvData = (hrvQuery.data ?? []) as HrvRow[];
  const latestHrv = hrvData[hrvData.length - 1];
  const hrvValues = hrvData.filter((d: HrvRow) => d.hrv != null).map((d: HrvRow) => d.hrv as number);
  const hrvBaseline = latestHrv?.rollingMean;

  // Readiness trend
  const readinessQuery = trpc.recovery.readinessScore.useQuery({ days: 30 });
  const readinessData = (readinessQuery.data ?? []) as ReadinessRow[];
  const readinessValues = readinessData.map((d: ReadinessRow) => d.readinessScore);
  const latestReadiness = readinessData[readinessData.length - 1];

  // Stress trend
  const stressQuery = trpc.stress.scores.useQuery({ days: 30 });
  const stressResult = stressQuery.data as StressResult | undefined;
  const stressDaily = stressResult?.daily ?? [];
  const stressValues = stressDaily.map((d) => d.stressScore);
  const latestStress = stressResult?.latestScore;
  const stressTrend = stressResult?.trend;

  // Workload ratio trend
  const workloadQuery = trpc.recovery.workloadRatio.useQuery({ days: 30 });
  const workloadData = (workloadQuery.data ?? []) as WorkloadRow[];
  const workloadRatioValues = workloadData
    .filter((d: WorkloadRow) => d.workloadRatio != null)
    .map((d: WorkloadRow) => d.workloadRatio as number);
  const latestRatio = workloadData[workloadData.length - 1]?.workloadRatio;

  const isLoading =
    hrvQuery.isLoading || readinessQuery.isLoading || stressQuery.isLoading;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
    >
      <Text style={styles.header}>30-Day Trends</Text>

      {isLoading ? (
        <View style={styles.loadingContainer}>
          <Text style={styles.loadingText}>Loading trends...</Text>
        </View>
      ) : (
        <>
          {/* Recovery trend chart */}
          {readinessValues.length >= 2 && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Recovery Score</Text>
              <View style={styles.chartRow}>
                <Text style={styles.bigValue}>
                  {latestReadiness?.readinessScore ?? "--"}
                </Text>
                <SparkLine
                  data={readinessValues}
                  width={240}
                  height={60}
                  color="#00E676"
                  showBaseline
                />
              </View>
              <Text style={styles.chartSubtitle}>
                30-day avg: {Math.round(readinessValues.reduce((s, v) => s + v, 0) / readinessValues.length)}
              </Text>
            </View>
          )}

          {/* HRV detail */}
          <MetricCard
            title="Heart Rate Variability"
            value={latestHrv?.hrv != null ? String(Math.round(latestHrv.hrv)) : "--"}
            unit="ms"
            trend={hrvValues.slice(-14)}
            color="#00E676"
            subtitle={
              hrvBaseline != null
                ? `7-day baseline: ${Math.round(hrvBaseline)} ms`
                : undefined
            }
            trendDirection={
              hrvValues.length >= 2
                ? (hrvValues[hrvValues.length - 1] ?? 0) >
                  (hrvValues[hrvValues.length - 2] ?? 0)
                  ? "up"
                  : "down"
                : undefined
            }
          />

          {/* HRV variability (coefficient of variation) */}
          {hrvData.length >= 2 && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>
                Heart Rate Variability Stability
              </Text>
              <SparkLine
                data={hrvData
                  .filter((d: HrvRow) => d.rollingCoefficientOfVariation != null)
                  .map((d: HrvRow) => d.rollingCoefficientOfVariation as number)}
                width={320}
                height={50}
                color="#5AC8FA"
                showBaseline
              />
              <Text style={styles.chartSubtitle}>
                Lower variability = more stable autonomic nervous system
              </Text>
            </View>
          )}

          {/* Stress */}
          <MetricCard
            title="Stress Level"
            value={latestStress != null ? latestStress.toFixed(1) : "--"}
            unit="/ 3"
            trend={stressValues.slice(-14)}
            color={
              (latestStress ?? 0) >= 2
                ? "#FF3D00"
                : (latestStress ?? 0) >= 1
                  ? "#FFD600"
                  : "#00E676"
            }
            subtitle={stressTrend ? `Trend: ${stressTrend}` : undefined}
            trendDirection={
              stressTrend === "improving"
                ? "down"
                : stressTrend === "worsening"
                  ? "up"
                  : "stable"
            }
          />

          {/* Weekly stress breakdown */}
          {(stressResult?.weekly ?? []).length > 0 && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Weekly Stress</Text>
              <View style={styles.weeklyGrid}>
                {(stressResult?.weekly ?? []).slice(-4).map((week) => (
                  <View key={week.weekStart} style={styles.weeklyItem}>
                    <Text style={styles.weeklyDate}>
                      {new Date(week.weekStart).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                    </Text>
                    <Text style={styles.weeklyValue}>
                      {week.avgDailyStress.toFixed(1)}
                    </Text>
                    <Text style={styles.weeklyLabel}>
                      {week.highStressDays} high days
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          )}

          {/* Workload ratio */}
          <MetricCard
            title="Workload Ratio"
            value={latestRatio != null ? latestRatio.toFixed(2) : "--"}
            trend={workloadRatioValues.slice(-14)}
            color={
              latestRatio != null
                ? latestRatio >= 0.8 && latestRatio <= 1.3
                  ? "#00E676"
                  : latestRatio <= 1.5
                    ? "#FFD600"
                    : "#FF3D00"
                : "#8e8e93"
            }
            subtitle="Acute:Chronic ratio (sweet spot: 0.8-1.3)"
          />
        </>
      )}
    </ScrollView>
  );
}

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
  header: {
    fontSize: 28,
    fontWeight: "800",
    color: "#fff",
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
  card: {
    backgroundColor: "#1c1c1e",
    borderRadius: 16,
    padding: 16,
    gap: 10,
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: "#8e8e93",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  chartRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  bigValue: {
    fontSize: 36,
    fontWeight: "800",
    color: "#00E676",
    fontVariant: ["tabular-nums"],
  },
  chartSubtitle: {
    fontSize: 12,
    color: "#636366",
  },
  weeklyGrid: {
    flexDirection: "row",
    justifyContent: "space-around",
  },
  weeklyItem: {
    alignItems: "center",
    gap: 4,
  },
  weeklyDate: {
    fontSize: 11,
    color: "#636366",
  },
  weeklyValue: {
    fontSize: 20,
    fontWeight: "700",
    color: "#fff",
    fontVariant: ["tabular-nums"],
  },
  weeklyLabel: {
    fontSize: 10,
    color: "#636366",
  },
});
