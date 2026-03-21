import { useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useRouter } from "expo-router";
import { ChartTitleWithTooltip } from "../../components/ChartTitleWithTooltip";
import { DaySelector } from "../../components/DaySelector";
import { MetricCard } from "../../components/MetricCard";
import { SparkLine } from "../../components/charts/SparkLine";
import { formatNumber } from "@dofek/format/format";
import { trendDirection as computeTrend } from "../../lib/scoring";
import { trpc } from "../../lib/trpc";
import { convertTemperature, temperatureLabel, useUnitSystem } from "../../lib/units";
import type {
  HeartRateVariabilityRow,
  ReadinessRow,
  StressResult,
  WorkloadRatioRow,
} from "../../types/api";
import { colors } from "../../theme";

export default function MetricsScreen() {
  const router = useRouter();
  const unitSystem = useUnitSystem();
  const [days, setDays] = useState(30);

  // HRV trend
  const hrvQuery = trpc.recovery.hrvVariability.useQuery({ days });
  const hrvData = hrvQuery.data ?? [];
  const latestHrv = hrvData[hrvData.length - 1];
  const hrvValues = hrvData.filter((d) => d.hrv != null).map((d) => d.hrv as number);
  const hrvBaseline = latestHrv?.rollingMean;

  // Readiness trend
  const readinessQuery = trpc.recovery.readinessScore.useQuery({ days });
  const readinessData = readinessQuery.data ?? [];
  const readinessValues = readinessData.map((d) => d.readinessScore);
  const latestReadiness = readinessData[readinessData.length - 1];

  // Stress trend
  const stressQuery = trpc.stress.scores.useQuery({ days });
  const stressResult = stressQuery.data;
  const stressDaily = stressResult?.daily ?? [];
  const stressValues = stressDaily.map((d) => d.stressScore);
  const latestStress = stressResult?.latestScore;
  const stressTrend = stressResult?.trend;

  // Workload ratio trend
  const workloadQuery = trpc.recovery.workloadRatio.useQuery({ days });
  const workloadData = workloadQuery.data?.timeSeries ?? [];
  const workloadRatioValues = workloadData
    .filter((d) => d.workloadRatio != null)
    .map((d) => d.workloadRatio as number);
  const latestRatio = workloadData[workloadData.length - 1]?.workloadRatio;

  // Daily metrics for SpO2 and skin temp
  const trendsQuery = trpc.dailyMetrics.trends.useQuery({ days });
  const trendsData = trendsQuery.data;
  const dailyMetricsQuery = trpc.dailyMetrics.list.useQuery({ days });
  const dailyMetricsData = dailyMetricsQuery.data ?? [];

  const spo2Trend = dailyMetricsData
    .filter((d: Record<string, unknown>) => d.spo2_avg != null)
    .map((d: Record<string, unknown>) => Number(d.spo2_avg));

  const skinTempTrend = dailyMetricsData
    .filter((d: Record<string, unknown>) => d.skin_temp_c != null)
    .map((d: Record<string, unknown>) => convertTemperature(Number(d.skin_temp_c), unitSystem));

  const isLoading =
    hrvQuery.isLoading || readinessQuery.isLoading || stressQuery.isLoading;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
    >
      <Text style={styles.header}>{days}-Day Trends</Text>

      <DaySelector days={days} onChange={setDays} />

      <TouchableOpacity
        style={styles.insightsButton}
        onPress={() => router.push("/insights")}
        activeOpacity={0.7}
      >
        <Text style={styles.insightsButtonEmoji}>{"\uD83D\uDCA1"}</Text>
        <View style={styles.insightsButtonText}>
          <Text style={styles.insightsButtonLabel}>Insights</Text>
          <Text style={styles.insightsButtonDescription}>Patterns and correlations in your data</Text>
        </View>
        <Text style={styles.insightsButtonChevron}>{"\u203A"}</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.insightsButton}
        onPress={() => router.push("/predictions")}
        activeOpacity={0.7}
      >
        <Text style={styles.insightsButtonEmoji}>{"\uD83D\uDD2E"}</Text>
        <View style={styles.insightsButtonText}>
          <Text style={styles.insightsButtonLabel}>Predictions</Text>
          <Text style={styles.insightsButtonDescription}>Machine learning forecasts for your metrics</Text>
        </View>
        <Text style={styles.insightsButtonChevron}>{"\u203A"}</Text>
      </TouchableOpacity>

      {isLoading ? (
        <View style={styles.loadingContainer}>
          <Text style={styles.loadingText}>Loading trends...</Text>
        </View>
      ) : (
        <>
          {/* Recovery trend chart */}
          {readinessValues.length >= 2 && (
            <View style={styles.card}>
              <ChartTitleWithTooltip
                title="Recovery Score"
                description="This chart shows your recovery score trend over the selected period."
                textStyle={styles.cardTitle}
              />
              <View style={styles.chartRow}>
                <Text style={styles.bigValue}>
                  {latestReadiness?.readinessScore ?? "--"}
                </Text>
                <SparkLine
                  data={readinessValues}
                  width={240}
                  height={60}
                  color={colors.positive}
                  showBaseline
                />
              </View>
              <Text style={styles.chartSubtitle}>
                {days}-day avg: {Math.round(readinessValues.reduce((s, v) => s + v, 0) / readinessValues.length)}
              </Text>
            </View>
          )}

          {/* HRV detail */}
          <MetricCard
            title="Heart Rate Variability"
            value={latestHrv?.hrv != null ? String(Math.round(latestHrv.hrv)) : "--"}
            unit="ms"
            trend={hrvValues.slice(-14)}
            color={colors.positive}
            subtitle={
              hrvBaseline != null
                ? `7-day baseline: ${Math.round(hrvBaseline)} ms`
                : undefined
            }
            trendDirection={
              hrvValues.length >= 2
                ? computeTrend(
                    hrvValues[hrvValues.length - 1] ?? 0,
                    hrvValues[hrvValues.length - 2] ?? 0,
                  )
                : undefined
            }
          />

          {/* HRV variability (coefficient of variation) */}
          {hrvData.length >= 2 && (
            <View style={styles.card}>
              <ChartTitleWithTooltip
                title="Heart Rate Variability Stability"
                description="This chart tracks heart rate variability consistency using the rolling coefficient of variation."
                textStyle={styles.cardTitle}
              />
              <SparkLine
                data={hrvData
                  .filter((d) => d.rollingCoefficientOfVariation != null)
                  .map((d) => d.rollingCoefficientOfVariation as number)}
                width={320}
                height={50}
                color={colors.teal}
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
            value={latestStress != null ? formatNumber(latestStress) : "--"}
            unit="/ 3"
            trend={stressValues.slice(-14)}
            color={
              (latestStress ?? 0) >= 2
                ? colors.danger
                : (latestStress ?? 0) >= 1
                  ? colors.warning
                  : colors.positive
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
              <ChartTitleWithTooltip
                title="Weekly Stress"
                description="This chart summarizes average daily stress and number of high-stress days by week."
                textStyle={styles.cardTitle}
              />
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
                      {formatNumber(week.avgDailyStress)}
                    </Text>
                    <Text style={styles.weeklyLabel}>
                      {week.highStressDays} high days
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          )}

          {/* SpO2 */}
          {trendsData?.latest_spo2 != null && (
            <MetricCard
              title="Blood Oxygen"
              value={String(Math.round(trendsData.latest_spo2))}
              unit="%"
              trend={spo2Trend}
              color={colors.blue}
              trendDirection={
                spo2Trend.length >= 2
                  ? computeTrend(
                      spo2Trend[spo2Trend.length - 1] ?? 0,
                      spo2Trend[spo2Trend.length - 2] ?? 0,
                    )
                  : undefined
              }
            />
          )}

          {/* Skin Temperature */}
          {trendsData?.latest_skin_temp != null && (
            <MetricCard
              title="Skin Temperature"
              value={formatNumber(convertTemperature(trendsData.latest_skin_temp, unitSystem))}
              unit={temperatureLabel(unitSystem)}
              trend={skinTempTrend}
              color={colors.orange}
              trendDirection={
                skinTempTrend.length >= 2
                  ? computeTrend(
                      skinTempTrend[skinTempTrend.length - 1] ?? 0,
                      skinTempTrend[skinTempTrend.length - 2] ?? 0,
                    )
                  : undefined
              }
            />
          )}

          {/* Workload ratio */}
          <MetricCard
            title="Workload Ratio"
            value={latestRatio != null ? formatNumber(latestRatio, 2) : "--"}
            trend={workloadRatioValues.slice(-14)}
            color={
              latestRatio != null
                ? latestRatio >= 0.8 && latestRatio <= 1.3
                  ? colors.positive
                  : latestRatio <= 1.5
                    ? colors.warning
                    : colors.danger
                : colors.textSecondary
            }
            subtitle="Short-term vs long-term training load ratio (sweet spot: 0.8-1.3)"
          />
        </>
      )}
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
  header: {
    fontSize: 28,
    fontWeight: "800",
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
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    gap: 10,
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
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
    color: colors.positive,
    fontVariant: ["tabular-nums"],
  },
  chartSubtitle: {
    fontSize: 12,
    color: colors.textTertiary,
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
    color: colors.textTertiary,
  },
  weeklyValue: {
    fontSize: 20,
    fontWeight: "700",
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  weeklyLabel: {
    fontSize: 10,
    color: colors.textTertiary,
  },
  insightsButton: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
  },
  insightsButtonEmoji: {
    fontSize: 24,
    marginRight: 12,
  },
  insightsButtonText: {
    flex: 1,
  },
  insightsButtonLabel: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.text,
  },
  insightsButtonDescription: {
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: 2,
  },
  insightsButtonChevron: {
    fontSize: 24,
    color: colors.textTertiary,
    marginLeft: 8,
  },
});
