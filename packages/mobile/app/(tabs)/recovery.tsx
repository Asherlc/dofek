import { formatDateYmd, formatNumber } from "@dofek/format/format";
import { SCORE_ZONES, scoreColor, scoreLabel } from "@dofek/scoring/scoring";
import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Card } from "../../components/Card";
import { SparkLine } from "../../components/charts/SparkLine";
import { DaySelector } from "../../components/DaySelector";
import { MetricCard } from "../../components/MetricCard";
import { trendDirection as computeTrend, trendColor } from "../../lib/scoring";
import { trpc } from "../../lib/trpc";
import { useUnitConverter } from "../../lib/units";
import { useRefresh } from "../../lib/useRefresh";
import { colors } from "../../theme";

function withOpacity(hexColor: string, opacityHex: string): string {
  return `${hexColor}${opacityHex}`;
}

const RECOVERY_SCORE_BANDS = SCORE_ZONES.map((zone) => {
  if (zone.status === "danger") {
    return { min: zone.min, max: zone.max, color: withOpacity(colors.danger, "20") };
  }
  if (zone.status === "warning") {
    return { min: zone.min, max: zone.max, color: withOpacity(colors.warning, "20") };
  }
  return { min: zone.min, max: zone.max, color: withOpacity(colors.positive, "20") };
});

function trendArrow(trend: string | null): string {
  if (trend === "improving") return "\u2191";
  if (trend === "declining") return "\u2193";
  if (trend === "stable") return "\u2192";
  return "";
}

export default function RecoveryScreen() {
  const router = useRouter();
  const units = useUnitConverter();
  const [days, setDays] = useState(30);
  const endDate = useMemo(() => formatDateYmd(), []);

  // HRV trend
  const hrvQuery = trpc.recovery.hrvVariability.useQuery({ days });
  const hrvData = hrvQuery.data ?? [];
  const latestHrv = hrvData[hrvData.length - 1];
  const hrvValues = hrvData.flatMap((d) => (d.hrv != null ? [d.hrv] : []));
  const hrvBaseline = latestHrv?.rollingMean;

  // Readiness trend
  const readinessQuery = trpc.recovery.readinessScore.useQuery({ days });
  const readinessData = readinessQuery.data ?? [];
  const readinessValues = readinessData.map((d) => d.readinessScore);
  const latestReadiness = readinessData[readinessData.length - 1];

  // Stress trend
  const stressQuery = trpc.stress.scores.useQuery({ days, endDate });
  const stressResult = stressQuery.data;
  const stressDaily = stressResult?.daily ?? [];
  const stressValues = stressDaily.map((d) => d.stressScore);
  const latestStress = stressResult?.latestScore;
  const stressTrend = stressResult?.trend;

  // Daily metrics for SpO2 and skin temp
  const today = new Date().toLocaleDateString("en-CA");
  const trendsQuery = trpc.dailyMetrics.trends.useQuery({ days, today });
  const trendsData = trendsQuery.data;
  const dailyMetricsQuery = trpc.dailyMetrics.list.useQuery({ days, today });
  const dailyMetricsData = dailyMetricsQuery.data ?? [];

  const spo2Trend = dailyMetricsData
    .filter((d: Record<string, unknown>) => d.spo2_avg != null)
    .map((d: Record<string, unknown>) => Number(d.spo2_avg));

  const skinTempTrend = dailyMetricsData
    .filter((d: Record<string, unknown>) => d.skin_temp_c != null)
    .map((d: Record<string, unknown>) => units.convertTemperature(Number(d.skin_temp_c)));

  // Body weight
  const weightQuery = trpc.bodyAnalytics.smoothedWeight.useQuery({
    days: Math.max(days, 90),
    endDate,
  });
  const weightData = weightQuery.data ?? [];
  const latestWeight = weightData.length > 0 ? weightData[weightData.length - 1] : null;

  // Healthspan
  const healthspanQuery = trpc.healthspan.score.useQuery({
    weeks: Math.max(Math.ceil(days / 7), 4),
    endDate,
  });
  const healthspan = healthspanQuery.data;

  // Steps
  const latestSteps =
    dailyMetricsData.length > 0 ? dailyMetricsData[dailyMetricsData.length - 1] : null;
  const stepsAvg7d =
    dailyMetricsData.length > 0
      ? Math.round(
          dailyMetricsData.reduce(
            (sum: number, d: Record<string, unknown>) => sum + (Number(d.steps) || 0),
            0,
          ) / 7,
        )
      : null;

  const isLoading = hrvQuery.isLoading || readinessQuery.isLoading || stressQuery.isLoading;
  const { refreshing, onRefresh } = useRefresh();

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
      <DaySelector days={days} onChange={setDays} />

      {isLoading ? (
        <View style={styles.loadingContainer}>
          <Text style={styles.loadingText}>Loading trends...</Text>
        </View>
      ) : (
        <>
          {/* Recovery trend chart */}
          {readinessValues.length >= 2 && (
            <Card title="Recovery Score">
              <View style={styles.chartRow}>
                <Text
                  style={[
                    styles.bigValue,
                    {
                      color:
                        latestReadiness?.readinessScore != null
                          ? scoreColor(latestReadiness.readinessScore)
                          : colors.text,
                    },
                  ]}
                >
                  {latestReadiness?.readinessScore ?? "--"}
                </Text>
                <View style={styles.sparkContainer}>
                  <SparkLine
                    data={readinessValues}
                    height={60}
                    color={colors.textSecondary}
                    showBaseline
                    domain={{ min: 0, max: 100 }}
                    backgroundBands={RECOVERY_SCORE_BANDS}
                  />
                </View>
              </View>
              <Text style={styles.chartSubtitle}>
                {days}-day avg:{" "}
                {Math.round(readinessValues.reduce((s, v) => s + v, 0) / readinessValues.length)}
              </Text>
            </Card>
          )}

          {/* HRV detail */}
          <MetricCard
            title="Heart Rate Variability"
            value={latestHrv?.hrv != null ? String(Math.round(latestHrv.hrv)) : "--"}
            unit="ms"
            trend={hrvValues.slice(-14)}
            color={colors.positive}
            subtitle={
              hrvBaseline != null ? `7-day baseline: ${Math.round(hrvBaseline)} ms` : undefined
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
            <Card title="Heart Rate Variability Stability">
              <SparkLine
                data={hrvData.flatMap((d) =>
                  d.rollingCoefficientOfVariation != null ? [d.rollingCoefficientOfVariation] : [],
                )}
                height={50}
                color={colors.teal}
                showBaseline
                showYAxis
                formatYLabel={(value) => `${Math.round(value)}%`}
              />
              <Text style={styles.chartSubtitle}>
                Lower variability = more stable autonomic nervous system
              </Text>
            </Card>
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
              stressTrend === "improving" ? "down" : stressTrend === "worsening" ? "up" : "stable"
            }
          />

          {/* Weekly stress breakdown */}
          {(stressResult?.weekly ?? []).length > 0 && (
            <Card title="Weekly Stress">
              <View style={styles.weeklyGrid}>
                {(stressResult?.weekly ?? []).slice(-4).map((week) => (
                  <View key={week.weekStart} style={styles.weeklyItem}>
                    <Text style={styles.weeklyDate}>
                      {new Date(week.weekStart).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                    </Text>
                    <Text style={styles.weeklyValue}>{formatNumber(week.avgDailyStress)}</Text>
                    <Text style={styles.weeklyLabel}>{week.highStressDays} high days</Text>
                  </View>
                ))}
              </View>
            </Card>
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
              value={formatNumber(units.convertTemperature(trendsData.latest_skin_temp))}
              unit={units.temperatureLabel}
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

          {/* Healthspan Score */}
          {healthspan != null &&
            healthspan.healthspanScore != null &&
            healthspan.metrics.length > 0 && (
              <Card title="Healthspan Score">
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
                        style={[styles.healthspanTrend, { color: trendColor(healthspan.trend) }]}
                      >
                        {trendArrow(healthspan.trend)} {healthspan.trend}
                      </Text>
                    )}
                  </View>
                </View>
              </Card>
            )}

          {/* Body Weight */}
          {latestWeight != null && (
            <Card title="Body Weight">
              <View style={styles.weightRow}>
                <View>
                  <Text style={styles.weightValue}>
                    {formatNumber(units.convertWeight(latestWeight.smoothedWeight))}
                  </Text>
                  <Text style={styles.weightUnit}>{units.weightLabel}</Text>
                </View>
                {weightData.length >= 2 && (
                  <View style={styles.sparkContainer}>
                    <SparkLine
                      data={weightData.map((d) => d.smoothedWeight)}
                      height={50}
                      color={colors.blue}
                      showYAxis
                      formatYLabel={(value) => `${Math.round(units.convertWeight(value))}`}
                    />
                  </View>
                )}
              </View>
            </Card>
          )}

          {/* Daily Steps */}
          {latestSteps != null && (
            <Card title="Daily Steps">
              <Text style={styles.stepsValue}>
                {Number(latestSteps.steps) > 0 ? Number(latestSteps.steps).toLocaleString() : "--"}
              </Text>
              {stepsAvg7d != null && stepsAvg7d > 0 && (
                <Text style={styles.chartSubtitle}>7-day avg: {stepsAvg7d.toLocaleString()}</Text>
              )}
            </Card>
          )}

          {/* Navigation links */}
          <TouchableOpacity
            style={styles.navLink}
            onPress={() => router.push("/sleep")}
            activeOpacity={0.7}
          >
            <Text style={styles.navLinkText}>Sleep Detail</Text>
            <Text style={styles.navChevron}>{"\u203A"}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.navLink}
            onPress={() => router.push("/correlation")}
            activeOpacity={0.7}
          >
            <Text style={styles.navLinkText}>Correlation Explorer</Text>
            <Text style={styles.navChevron}>{"\u203A"}</Text>
          </TouchableOpacity>
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
  chartRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sparkContainer: {
    flex: 1,
    marginLeft: 16,
  },
  bigValue: {
    fontSize: 36,
    fontWeight: "800",
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
  stepsValue: {
    fontSize: 32,
    fontWeight: "700",
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  navLink: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  navLinkText: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.text,
  },
  navChevron: {
    fontSize: 24,
    color: colors.textTertiary,
  },
});
