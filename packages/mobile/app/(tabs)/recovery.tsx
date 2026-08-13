import { formatBaselineContext } from "@dofek/format/baseline-context";
import {
  formatBodyCompositionNumber,
  formatDateShort,
  formatHRV,
  formatIntensity,
  formatNumber,
  formatSpO2,
} from "@dofek/format/format";
import { formatHealthspanTrendContext } from "@dofek/format/healthspan-context";
import { formatMeasurementText } from "@dofek/format/units";
import { shouldShowBlockingLoading } from "@dofek/scoring/loading-policy";
import {
  trendDirection as computeTrend,
  SCORE_ZONES,
  scoreColor,
  scoreLabel,
  trendColor,
} from "@dofek/scoring/scoring";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  LayoutAnimation,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  UIManager,
  View,
} from "react-native";
import { BodyDecisionContext } from "../../components/BodyDecisionContext";
import { Card } from "../../components/Card";
import { SparkLine } from "../../components/charts/SparkLine";
import { DaySelector } from "../../components/DaySelector";
import { HealthStatusCards } from "../../components/HealthStatusCards";
import { MetricCard } from "../../components/MetricCard";
import { ProcessingStatusWidget } from "../../components/ProcessingStatusWidget";
import { getQueryErrorMessage, QueryStatePanel } from "../../components/QueryStatePanel";
import { SubjectiveTrackingPanel } from "../../components/SubjectiveTrackingPanel";
import { TodayPlanCard } from "../../components/TodayPlanCard";
import { trpc } from "../../lib/trpc";
import { useUnitConverter } from "../../lib/units";
import { useProcessingStatus } from "../../lib/useProcessingStatus";
import { useRefresh } from "../../lib/useRefresh";
import { useTimeRangePreference } from "../../lib/useTimeRangePreference";
import { useTodayQueryDate } from "../../lib/useTodayQueryDate";
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

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

function ComponentBar({ label, value, weight }: { label: string; value: number; weight: number }) {
  const color = scoreColor(value);
  return (
    <View style={breakdownStyles.row}>
      <View style={breakdownStyles.labelCol}>
        <Text style={breakdownStyles.label}>{label}</Text>
        <Text style={breakdownStyles.weight}>{formatIntensity(weight * 100)}</Text>
      </View>
      <View style={breakdownStyles.barTrack}>
        <View style={[breakdownStyles.barFill, { width: `${value}%`, backgroundColor: color }]} />
      </View>
      <Text style={breakdownStyles.valueText}>{value}</Text>
    </View>
  );
}

function RecoveryBreakdown({
  components,
  weights,
}: {
  components: {
    hrvScore: number;
    restingHrScore: number;
    sleepScore: number;
    respiratoryRateScore: number;
  };
  weights: {
    hrv: number;
    restingHr: number;
    sleep: number;
    respiratoryRate: number;
  };
}) {
  return (
    <View style={breakdownStyles.container}>
      <ComponentBar
        label="Heart Rate Variability"
        value={components.hrvScore}
        weight={weights.hrv}
      />
      <ComponentBar
        label="Resting Heart Rate"
        value={components.restingHrScore}
        weight={weights.restingHr}
      />
      <ComponentBar label="Sleep" value={components.sleepScore} weight={weights.sleep} />
      <ComponentBar
        label="Respiratory Rate"
        value={components.respiratoryRateScore}
        weight={weights.respiratoryRate}
      />
    </View>
  );
}

function TrendMetricGridItem({
  label,
  value,
  subtle = false,
}: {
  label: string;
  value: string | null;
  subtle?: boolean;
}) {
  return (
    <View style={styles.trendMetricGridItem}>
      <Text style={styles.trendMetricGridLabel}>{label}</Text>
      <Text style={[styles.trendMetricGridValue, subtle && styles.trendMetricGridValueSubtle]}>
        {value ?? "—"}
      </Text>
    </View>
  );
}

const breakdownStyles = StyleSheet.create({
  container: {
    gap: 10,
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.surfaceSecondary,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  labelCol: {
    width: 120,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  label: {
    fontSize: 12,
    color: colors.textSecondary,
    flexShrink: 1,
  },
  weight: {
    fontSize: 10,
    color: colors.textTertiary,
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
  valueText: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.text,
    width: 28,
    textAlign: "right",
    fontVariant: ["tabular-nums"],
  },
});

export default function RecoveryScreen() {
  const router = useRouter();
  const units = useUnitConverter();
  const utils = trpc.useUtils();
  const { days, description, isHydrated, setDays } = useTimeRangePreference("recovery");
  const endDate = useTodayQueryDate();
  const hasCommittedHydratedRange = useRef(false);
  const preservePreviousRangeData = isHydrated && hasCommittedHydratedRange.current;
  useEffect(() => {
    hasCommittedHydratedRange.current = isHydrated;
  }, [isHydrated]);

  const recoveryQuery = trpc.mobileDashboard.recovery.useQuery(
    { days, endDate },
    {
      enabled: isHydrated,
      placeholderData: preservePreviousRangeData ? (previousData) => previousData : undefined,
    },
  );
  const todayPlanQuery = trpc.todayPlan.get.useQuery(
    { days: 30, endDate },
    { enabled: isHydrated },
  );
  const processingStatus = useProcessingStatus({ datasets: ["activity", "sleep", "recovery"] });
  const recoveryData = isHydrated ? recoveryQuery.data : undefined;

  const hrvData = recoveryData?.hrvVariability ?? [];
  const hrvBaselineData = recoveryData?.hrvBaseline ?? [];
  const baselineRelative = recoveryData?.baselineRelative ?? [];
  const hrvContext = baselineRelative.find((metric) => metric.metric === "hrv");
  const restingHeartRateContext = baselineRelative.find(
    (metric) => metric.metric === "resting_heart_rate",
  );
  const respiratoryRateContext = baselineRelative.find(
    (metric) => metric.metric === "respiratory_rate",
  );
  const sleepEfficiencyContext = baselineRelative.find(
    (metric) => metric.metric === "sleep_efficiency",
  );
  const hrvValues = hrvData.flatMap((d) => (d.hrv != null ? [d.hrv] : []));
  const restingHeartRateValues = hrvBaselineData.flatMap((d) =>
    d.resting_hr != null ? [d.resting_hr] : [],
  );

  const readinessData = recoveryData?.readinessScore ?? [];
  const readinessValues = readinessData.map((d) => d.readinessScore);
  const latestReadiness = readinessData[readinessData.length - 1];

  const stressResult = recoveryData?.stress;
  const stressDaily = stressResult?.daily ?? [];
  const stressValues = stressDaily.map((d) => d.stressScore);
  const latestStress = stressResult?.latestScore;
  const stressTrend = stressResult?.trend;

  const trendsData = recoveryData?.trends;
  const dailyMetricsData = recoveryData?.dailyMetrics ?? [];

  const spo2Trend = dailyMetricsData
    .filter((d) => d.spo2_avg != null)
    .map((d) => Number(d.spo2_avg));

  const skinTempTrend = dailyMetricsData
    .filter((d) => d.skin_temp_c != null)
    .map((d) => units.convertTemperature(Number(d.skin_temp_c)));

  const weightData = recoveryData?.weight ?? [];
  const latestWeight = weightData.length > 0 ? weightData[weightData.length - 1] : null;
  const bodyFatData = recoveryData?.bodyFatTrend ?? [];
  const latestBodyFat = bodyFatData.at(-1) ?? null;
  const weightPrediction = recoveryData?.weightPrediction;
  const bodyFatPrediction = recoveryData?.bodyFatPrediction;

  const healthspan = recoveryData?.healthspan;

  const latestSteps =
    dailyMetricsData.length > 0 ? dailyMetricsData[dailyMetricsData.length - 1] : null;
  const stepsAvg7d =
    dailyMetricsData.length > 0
      ? Math.round(
          dailyMetricsData.reduce((sum, d) => sum + (Number(d.steps) || 0), 0) /
            dailyMetricsData.length,
        )
      : null;

  const [recoveryExpanded, setRecoveryExpanded] = useState(false);
  const [bodyTrendMetric, setBodyTrendMetric] = useState<"weight" | "bodyFat">("weight");
  const displayedBodyTrendMetric =
    bodyTrendMetric === "weight"
      ? latestWeight != null || latestBodyFat == null
        ? "weight"
        : "bodyFat"
      : latestBodyFat != null || latestWeight == null
        ? "bodyFat"
        : "weight";
  const displaysWeightTrend = displayedBodyTrendMetric === "weight";
  const displayedPrediction = displaysWeightTrend ? weightPrediction : bodyFatPrediction;
  const displayedTrendRate = displayedPrediction?.ratePerWeek ?? null;

  const isLoading = shouldShowBlockingLoading({
    data: recoveryData,
    isLoading: recoveryQuery.isLoading,
    isFetching: recoveryQuery.isFetching,
  });
  const { refreshing, onRefresh } = useRefresh({
    invalidate: () =>
      Promise.all([
        utils.mobileDashboard.recovery.invalidate(),
        utils.todayPlan.get.invalidate(),
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

      <SubjectiveTrackingPanel />

      <ProcessingStatusWidget
        data={processingStatus.data}
        error={processingStatus.error}
        loading={processingStatus.isLoading}
      />

      <TodayPlanCard
        plan={todayPlanQuery.data}
        loading={todayPlanQuery.isLoading}
        error={todayPlanQuery.error}
      />

      {recoveryQuery.isError ? (
        <QueryStatePanel
          variant="error"
          title={
            recoveryData == null
              ? "Recovery data is unavailable"
              : "Recovery data could not refresh"
          }
          message={getQueryErrorMessage(recoveryQuery.error)}
          minHeight={96}
          onRetry={() => {
            void recoveryQuery.refetch();
          }}
          retryLabel="Retry recovery data"
          retrying={recoveryQuery.isFetching}
        />
      ) : null}

      {recoveryData != null && (
        <HealthStatusCards
          metrics={recoveryData.healthStatus}
          formatValue={(metric) => {
            if (metric.metric === "trend_weight") {
              return formatMeasurementText(units.formatWeight(metric.value));
            }
            if (metric.metric === "skin_temperature") {
              return formatMeasurementText(units.formatTemperature(metric.value));
            }
            if (metric.metric === "spo2") return formatSpO2(metric.value);
            if (metric.metric === "respiratory_rate") {
              return metric.value == null ? "—" : `${formatNumber(metric.value)} breaths/min`;
            }
            if (metric.metric === "sleep_efficiency") {
              return metric.value == null ? "—" : `${formatNumber(metric.value)}%`;
            }
            if (metric.value == null) return "—";
            if (metric.metric === "body_fat_percentage") {
              return `${formatBodyCompositionNumber(metric.value)}%`;
            }
            return `${formatNumber(metric.value, 0)} bpm`;
          }}
          formatComparisonValue={(metric, value) => {
            if (metric.metric === "skin_temperature") {
              return formatMeasurementText(units.formatTemperatureDelta(value));
            }
            if (metric.metric === "spo2") return formatSpO2(value);
            if (metric.metric === "hrv") return formatHRV(value);
            if (metric.metric === "steps") return formatNumber(value, 0);
            return formatNumber(value);
          }}
        />
      )}

      {isLoading ? (
        <QueryStatePanel variant="loading" minHeight={200} />
      ) : recoveryData != null ? (
        <>
          {/* Recovery trend chart */}
          {readinessValues.length >= 2 && (
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={() => {
                LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                setRecoveryExpanded((prev) => !prev);
              }}
              accessibilityRole="button"
              accessibilityLabel={`${recoveryExpanded ? "Collapse" : "Expand"} recovery score`}
              accessibilityState={{ expanded: recoveryExpanded }}
            >
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
                <View style={styles.subtitleRow}>
                  <Text style={styles.chartSubtitle}>
                    {days}-day avg:{" "}
                    {Math.round(
                      readinessValues.reduce((s, v) => s + v, 0) / readinessValues.length,
                    )}
                  </Text>
                  <Text style={styles.expandHint}>{recoveryExpanded ? "▲" : "▼"}</Text>
                </View>
                {recoveryExpanded && latestReadiness && (
                  <RecoveryBreakdown
                    components={latestReadiness.components}
                    weights={latestReadiness.weights}
                  />
                )}
              </Card>
            </TouchableOpacity>
          )}

          {/* HRV detail */}
          <MetricCard
            title="Heart Rate Variability"
            value={formatHRV(hrvContext?.value)}
            trend={hrvValues.slice(-14)}
            color={colors.positive}
            subtitle={hrvContext ? formatBaselineContext(hrvContext, { unit: "ms" }) : undefined}
            trendDirection={
              hrvValues.length >= 2
                ? computeTrend(
                    hrvValues[hrvValues.length - 1] ?? 0,
                    hrvValues[hrvValues.length - 2] ?? 0,
                  )
                : undefined
            }
          />

          <MetricCard
            title="Resting Heart Rate"
            value={
              restingHeartRateContext?.value != null
                ? formatNumber(restingHeartRateContext.value, 0)
                : "--"
            }
            unit="bpm"
            trend={restingHeartRateValues.slice(-14)}
            color={colors.warning}
            subtitle={
              restingHeartRateContext
                ? formatBaselineContext(restingHeartRateContext, { unit: "bpm" })
                : undefined
            }
            trendDirection={
              restingHeartRateValues.length >= 2
                ? computeTrend(
                    restingHeartRateValues[restingHeartRateValues.length - 1] ?? 0,
                    restingHeartRateValues[restingHeartRateValues.length - 2] ?? 0,
                  )
                : undefined
            }
            onViewData={() => router.push("/daily-heart-rate")}
          />

          {respiratoryRateContext ? (
            <MetricCard
              title="Respiratory Rate"
              value={
                respiratoryRateContext.value != null
                  ? formatNumber(respiratoryRateContext.value)
                  : "--"
              }
              unit="breaths/min"
              color={colors.blue}
              subtitle={formatBaselineContext(respiratoryRateContext, { unit: "breaths/min" })}
            />
          ) : null}

          {sleepEfficiencyContext ? (
            <MetricCard
              title="Sleep Efficiency"
              value={
                sleepEfficiencyContext.value != null
                  ? formatNumber(sleepEfficiencyContext.value)
                  : "--"
              }
              unit="%"
              color={colors.teal}
              subtitle={formatBaselineContext(sleepEfficiencyContext, { unit: "%" })}
              onViewData={() => router.push("/sleep")}
            />
          ) : null}

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
                formatYLabel={formatIntensity}
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
                    <Text style={styles.weeklyDate}>{formatDateShort(week.weekStart)}</Text>
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
              value={formatSpO2(trendsData.latest_spo2)}
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
              value={formatMeasurementText(units.formatTemperature(trendsData.latest_skin_temp))}
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
          {healthspan != null && healthspan.availability.status === "insufficient_data" ? (
            <Card title="Healthspan Score">
              <Text style={styles.healthspanAvailabilitySummary}>
                {healthspan.availability.summary}
              </Text>
              {healthspan.availability.nextCondition != null ? (
                <Text style={styles.healthspanAvailabilityDetail}>
                  {healthspan.availability.nextCondition}
                </Text>
              ) : null}
              {healthspan.availability.missingMetricLabels.length > 0 ? (
                <Text style={styles.healthspanAvailabilityDetail}>
                  Missing supported metrics:{" "}
                  {healthspan.availability.missingMetricLabels.join(", ")}
                </Text>
              ) : null}
            </Card>
          ) : healthspan != null &&
            healthspan.healthspanScore != null &&
            healthspan.metrics.length > 0 ? (
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
                    <Text style={[styles.healthspanTrend, { color: trendColor(healthspan.trend) }]}>
                      {formatHealthspanTrendContext(healthspan.trend)}
                    </Text>
                  )}
                </View>
              </View>
            </Card>
          ) : null}

          {(latestWeight != null || latestBodyFat != null) && (
            <Card>
              <View style={styles.trendHeader}>
                <Text style={styles.trendTitle}>
                  {displaysWeightTrend ? "TREND WEIGHT" : "TREND BODY FAT"}
                </Text>
                <View style={styles.trendMetricSelector} accessibilityRole="tablist">
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel="Weight"
                    accessibilityState={{ selected: displaysWeightTrend }}
                    onPress={() => setBodyTrendMetric("weight")}
                    style={[
                      styles.trendMetricSelectorButton,
                      displaysWeightTrend && styles.trendMetricSelectorButtonSelected,
                    ]}
                  >
                    <Text
                      style={[
                        styles.trendMetricSelectorText,
                        displaysWeightTrend && styles.trendMetricSelectorTextSelected,
                      ]}
                    >
                      Weight
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel="Body Fat"
                    accessibilityState={{ selected: !displaysWeightTrend }}
                    onPress={() => setBodyTrendMetric("bodyFat")}
                    style={[
                      styles.trendMetricSelectorButton,
                      !displaysWeightTrend && styles.trendMetricSelectorButtonSelected,
                    ]}
                  >
                    <Text
                      style={[
                        styles.trendMetricSelectorText,
                        !displaysWeightTrend && styles.trendMetricSelectorTextSelected,
                      ]}
                    >
                      Body Fat
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
              <View style={styles.weightRow}>
                <View>
                  <Text style={styles.weightValue}>
                    {displaysWeightTrend
                      ? formatMeasurementText(units.formatWeight(latestWeight?.smoothedWeight ?? 0))
                      : `${formatBodyCompositionNumber(latestBodyFat?.smoothedBodyFatPct ?? 0)}%`}
                  </Text>
                  {displaysWeightTrend ? (
                    <>
                      <Text style={styles.weightScale}>
                        {latestWeight?.smoothedWeightStatus?.label}
                      </Text>
                      {latestWeight?.rawWeight != null && latestWeight.rawWeightStatus != null && (
                        <Text style={styles.weightScale}>
                          {latestWeight.rawWeightStatus.label}:{" "}
                          {formatMeasurementText(units.formatWeight(latestWeight.rawWeight))}
                        </Text>
                      )}
                    </>
                  ) : (
                    <>
                      <Text style={styles.weightScale}>
                        {latestBodyFat?.smoothedBodyFatStatus?.label}
                      </Text>
                      {latestBodyFat?.rawBodyFatPct != null &&
                        latestBodyFat.rawBodyFatStatus != null && (
                          <Text style={styles.weightScale}>
                            {latestBodyFat.rawBodyFatStatus.label}:{" "}
                            {formatBodyCompositionNumber(latestBodyFat.rawBodyFatPct)}%
                          </Text>
                        )}
                    </>
                  )}
                  {displaysWeightTrend && weightPrediction?.goal?.estimatedDate != null && (
                    <Text style={styles.weightGoal}>
                      Goal:{" "}
                      {formatMeasurementText(
                        units.formatWeight(weightPrediction.goal.goalWeightKg),
                      )}{" "}
                      by ~{formatDateShort(weightPrediction.goal.estimatedDate)}
                    </Text>
                  )}
                </View>
                {(displaysWeightTrend ? weightData.length : bodyFatData.length) >= 2 && (
                  <View
                    accessible
                    accessibilityRole="image"
                    accessibilityLabel={
                      displaysWeightTrend
                        ? `Weight trend: ${weightData
                            .map(
                              (row) =>
                                `${row.date} ${formatMeasurementText(units.formatWeight(row.smoothedWeight))}`,
                            )
                            .join("; ")}.`
                        : `Body fat trend: ${bodyFatData
                            .map(
                              (row) =>
                                `${row.date} ${formatBodyCompositionNumber(row.smoothedBodyFatPct)}%`,
                            )
                            .join("; ")}.`
                    }
                    style={styles.sparkContainer}
                  >
                    <View
                      accessibilityElementsHidden
                      importantForAccessibility="no-hide-descendants"
                    >
                      <SparkLine
                        data={
                          displaysWeightTrend
                            ? weightData.map((row) => row.smoothedWeight)
                            : bodyFatData.map((row) => row.smoothedBodyFatPct)
                        }
                        height={50}
                        color={displaysWeightTrend ? colors.blue : colors.purple}
                        showYAxis
                        formatYLabel={(value) =>
                          displaysWeightTrend
                            ? formatBodyCompositionNumber(units.convertWeight(value))
                            : `${formatBodyCompositionNumber(value)}%`
                        }
                      />
                    </View>
                  </View>
                )}
              </View>
              <View style={styles.trendMetricGrid}>
                <TrendMetricGridItem
                  label="RATE"
                  subtle
                  value={
                    displayedTrendRate == null
                      ? null
                      : displaysWeightTrend
                        ? `${displayedTrendRate > 0 ? "+" : ""}${formatMeasurementText(units.formatWeight(displayedTrendRate))}/wk`
                        : `${displayedTrendRate > 0 ? "+" : ""}${formatBodyCompositionNumber(displayedTrendRate)}%/wk`
                  }
                />
                <TrendMetricGridItem
                  label="7D"
                  value={
                    displayedPrediction?.periodDeltas.days7 == null
                      ? null
                      : displaysWeightTrend
                        ? `${displayedPrediction.periodDeltas.days7 > 0 ? "+" : ""}${formatMeasurementText(units.formatWeight(displayedPrediction.periodDeltas.days7))}`
                        : `${displayedPrediction.periodDeltas.days7 > 0 ? "+" : ""}${formatBodyCompositionNumber(displayedPrediction.periodDeltas.days7)}%`
                  }
                />
                <TrendMetricGridItem
                  label="14D"
                  value={
                    displayedPrediction?.periodDeltas.days14 == null
                      ? null
                      : displaysWeightTrend
                        ? `${displayedPrediction.periodDeltas.days14 > 0 ? "+" : ""}${formatMeasurementText(units.formatWeight(displayedPrediction.periodDeltas.days14))}`
                        : `${displayedPrediction.periodDeltas.days14 > 0 ? "+" : ""}${formatBodyCompositionNumber(displayedPrediction.periodDeltas.days14)}%`
                  }
                />
                <TrendMetricGridItem
                  label="30D"
                  value={
                    displayedPrediction?.periodDeltas.days30 == null
                      ? null
                      : displaysWeightTrend
                        ? `${displayedPrediction.periodDeltas.days30 > 0 ? "+" : ""}${formatMeasurementText(units.formatWeight(displayedPrediction.periodDeltas.days30))}`
                        : `${displayedPrediction.periodDeltas.days30 > 0 ? "+" : ""}${formatBodyCompositionNumber(displayedPrediction.periodDeltas.days30)}%`
                  }
                />
              </View>
              {displaysWeightTrend && (
                <BodyDecisionContext context={recoveryData.decisionContext} />
              )}
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
            onPress={() => router.push("/breathwork")}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Breathwork"
          >
            <Text style={styles.navLinkText}>Breathwork</Text>
            <Text style={styles.navChevron}>{"\u203A"}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.navLink}
            onPress={() => router.push("/sleep")}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Sleep Detail"
          >
            <Text style={styles.navLinkText}>Sleep Detail</Text>
            <Text style={styles.navChevron}>{"\u203A"}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.navLink}
            onPress={() => router.push("/correlation")}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Correlation Explorer"
          >
            <Text style={styles.navLinkText}>Correlation Explorer</Text>
            <Text style={styles.navChevron}>{"\u203A"}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.navLink}
            onPress={() => router.push("/behavior-associations")}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Behavior Associations"
          >
            <Text style={styles.navLinkText}>Behavior Associations</Text>
            <Text style={styles.navChevron}>{"\u203A"}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.navLink}
            onPress={() => router.push("/experiments")}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Personal Experiments"
          >
            <Text style={styles.navLinkText}>Personal Experiments</Text>
            <Text style={styles.navChevron}>{"\u203A"}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.navLink}
            onPress={() => router.push("/daily-heart-rate")}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Heart Rate by Source"
          >
            <Text style={styles.navLinkText}>Heart Rate by Source</Text>
            <Text style={styles.navChevron}>{"\u203A"}</Text>
          </TouchableOpacity>
        </>
      ) : null}
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
  subtitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  expandHint: {
    fontSize: 10,
    color: colors.textTertiary,
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
  },
  healthspanAvailabilitySummary: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
    lineHeight: 20,
  },
  healthspanAvailabilityDetail: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
  weightRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  trendHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  trendTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    letterSpacing: 0.5,
  },
  trendMetricSelector: {
    flexDirection: "row",
    padding: 2,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 8,
  },
  trendMetricSelectorButton: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  trendMetricSelectorButtonSelected: {
    backgroundColor: colors.accent,
  },
  trendMetricSelectorText: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  trendMetricSelectorTextSelected: {
    color: colors.background,
  },
  trendMetricGrid: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: colors.surfaceSecondary,
    paddingTop: 12,
  },
  trendMetricGridItem: {
    flex: 1,
    alignItems: "center",
    gap: 3,
  },
  trendMetricGridLabel: {
    fontSize: 10,
    color: colors.textTertiary,
  },
  trendMetricGridValue: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  trendMetricGridValueSubtle: {
    color: colors.textSecondary,
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
  weightRate: {
    fontSize: 13,
    fontWeight: "600",
    marginTop: 2,
  },
  weightScale: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 2,
  },
  weightGoal: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 2,
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
