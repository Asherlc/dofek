import { formatDurationMinutes, formatSleepDebtInline } from "@dofek/format/format";
import { formatSummaryDateContext } from "@dofek/format/summary-date-context";
import { shouldShowBlockingLoading } from "@dofek/scoring/loading-policy";
import { useRouter } from "expo-router";
import { useEffect } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import Animated, {
  Easing,
  FadeInUp,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { Card } from "../../components/Card";
import { ChartTitleWithTooltip } from "../../components/ChartTitleWithTooltip";
import { RecoveryRing } from "../../components/charts/RecoveryRing";
import { SleepBar } from "../../components/charts/SleepBar";
import { StrainGauge } from "../../components/charts/StrainGauge";
import { ProcessingStatusWidget } from "../../components/ProcessingStatusWidget";
import { ProviderGuide } from "../../components/ProviderGuide";
import { getQueryErrorMessage, QueryStatePanel } from "../../components/QueryStatePanel";
import { SkeletonCircle } from "../../components/Skeleton";
import { TodayPlanCard } from "../../components/TodayPlanCard";
import { trpc } from "../../lib/trpc";
import { useProcessingStatus } from "../../lib/useProcessingStatus";
import { useProviderGuide } from "../../lib/useProviderGuide";
import { useRefresh } from "../../lib/useRefresh";
import { useTodayQueryDate } from "../../lib/useTodayQueryDate";
import { colors, duration } from "../../theme";

export default function TodayScreen() {
  const router = useRouter();
  const providerGuide = useProviderGuide();
  const endDate = useTodayQueryDate();

  // Consolidated dashboard data fetch
  const dashboardQuery = trpc.mobileDashboard.dashboardV2.useQuery(
    { endDate },
    { placeholderData: (previousData) => previousData },
  );
  const todayPlanQuery = trpc.todayPlan.get.useQuery(
    { endDate },
    { placeholderData: (previousData) => previousData },
  );
  const processingStatusQuery = useProcessingStatus({
    datasets: ["activity", "sleep", "recovery", "training", "body"],
  });
  const dashboardData = dashboardQuery.data;
  const anomalyQuery = trpc.anomalyDetection.check.useQuery(
    { endDate },
    { staleTime: 10 * 60 * 1000, enabled: dashboardData != null },
  );

  // Derived readiness/recovery
  const todayReadiness = dashboardData?.readiness ?? undefined;
  const recoveryScore = todayReadiness?.score ?? null;

  // Derived sleep
  const sleepResult = dashboardData?.sleep;
  const lastNight = sleepResult?.lastNight ?? undefined;
  const sleepDebt = sleepResult?.sleepDebt ?? 0;

  // Derived strain
  const strainResult = dashboardData?.strain;
  const dailyStrain = strainResult?.dailyStrain ?? 0;

  // Alerts and sleep guidance from consolidated query
  const sleepNeed = dashboardData?.sleepNeed;
  const isSleepDataMissing = sleepNeed?.availability === "missing_previous_night";
  const anomalies = anomalyQuery.data ?? dashboardData?.anomalies;

  const isLoading = shouldShowBlockingLoading({
    data: dashboardData,
    isFetching: dashboardQuery.isFetching,
    isLoading: dashboardQuery.isLoading,
  });
  const isError = dashboardQuery.isError && dashboardData == null;
  const hasBackgroundError = dashboardQuery.isError && dashboardData != null;

  const { refreshing, onRefresh } = useRefresh({
    refresh: async () => {
      await Promise.all([
        dashboardQuery.refetch(),
        todayPlanQuery.refetch(),
        anomalyQuery.refetch(),
        processingStatusQuery.refetch(),
      ]);
    },
    invalidate: null,
  });

  if (isError) {
    return (
      <View style={styles.container}>
        <QueryStatePanel
          variant="error"
          message={getQueryErrorMessage(dashboardQuery.error, "Failed to load dashboard.")}
        />
      </View>
    );
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
      {/* Provider guide — shown to new users with no connected providers */}
      {providerGuide.showProviderGuide && (
        <ProviderGuide onDismiss={providerGuide.dismiss} providers={providerGuide.providers} />
      )}

      {providerGuide.error ? (
        <QueryStatePanel
          variant="error"
          title="Could not refresh provider setup"
          message={getQueryErrorMessage(providerGuide.error)}
          minHeight={72}
        />
      ) : null}

      <ProcessingStatusWidget
        data={processingStatusQuery.data}
        error={processingStatusQuery.error}
        loading={processingStatusQuery.isLoading}
      />

      <TodayPlanCard
        plan={todayPlanQuery.data}
        loading={todayPlanQuery.isLoading}
        error={todayPlanQuery.error}
      />

      {hasBackgroundError ? (
        <QueryStatePanel
          variant="error"
          message={getQueryErrorMessage(dashboardQuery.error, "Failed to refresh dashboard.")}
          minHeight={72}
        />
      ) : null}

      {/* Anomaly Alert Banner */}
      {anomalies != null && anomalies.anomalies.length > 0 && (
        <View style={styles.anomalyBanner}>
          <Text style={styles.anomalyIcon}>{"\u26A0\uFE0F"}</Text>
          <Text style={styles.anomalyText}>
            {anomalies.anomalies[0]?.metric}: {anomalies.anomalies[0]?.value} (baseline{" "}
            {anomalies.anomalies[0]?.baselineMean} \u00b1 {anomalies.anomalies[0]?.baselineStddev})
          </Text>
        </View>
      )}

      {dashboardData?.summaryDateContext ? (
        <Text style={styles.date}>
          {formatSummaryDateContext(dashboardData.summaryDateContext)}
        </Text>
      ) : null}

      {/* Recovery + Strain rings — tappable for navigation */}
      <View style={styles.ringsRow}>
        <View style={styles.ringSection}>
          <ChartTitleWithTooltip
            title="Recovery"
            description="This ring visualizes your readiness score based on recovery-related signals."
            textStyle={styles.sectionLabel}
          />
          <TouchableOpacity
            style={styles.ringTouchTarget}
            onPress={() => router.navigate("/(tabs)/recovery")}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Open Recovery"
            accessibilityState={{ busy: isLoading }}
          >
            {isLoading ? (
              <SkeletonCircle size={180} />
            ) : recoveryScore != null ? (
              <RecoveryRing score={recoveryScore} size={180} />
            ) : (
              <View style={[styles.emptyRing, { width: 180, height: 180 }]}>
                <Text style={styles.emptyRingText}>--</Text>
                <Text style={styles.emptyRingSubtext}>No data yet</Text>
              </View>
            )}
          </TouchableOpacity>
        </View>
        <View style={styles.ringSection}>
          <ChartTitleWithTooltip
            title="Strain"
            description="This gauge shows your most recent daily training strain relative to your recent baseline."
            textStyle={styles.sectionLabel}
          />
          <TouchableOpacity
            style={styles.ringTouchTarget}
            onPress={() => router.navigate("/(tabs)/strain")}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Open Strain"
            accessibilityState={{ busy: isLoading }}
          >
            {isLoading ? (
              <SkeletonCircle size={120} />
            ) : (
              <StrainGauge strain={dailyStrain} size={120} />
            )}
          </TouchableOpacity>
        </View>
      </View>

      {/* Recovery components breakdown */}
      {todayReadiness?.components && (
        <Animated.View
          entering={FadeInUp.delay(80)
            .duration(duration.slow)
            .easing(Easing.bezier(0.16, 1, 0.3, 1))}
        >
          <Card title="Recovery Breakdown">
            <View style={styles.componentGrid}>
              <ComponentRow
                label="Heart Rate Variability"
                score={todayReadiness.components.hrvScore}
                delay={0}
              />
              <ComponentRow
                label="Resting Heart Rate"
                score={todayReadiness.components.restingHrScore}
                delay={100}
              />
              <ComponentRow
                label="Sleep Quality"
                score={todayReadiness.components.sleepScore}
                delay={200}
              />
              <ComponentRow
                label="Respiratory Rate"
                score={todayReadiness.components.respiratoryRateScore}
                delay={300}
              />
            </View>
          </Card>
        </Animated.View>
      )}

      {/* Sleep summary */}
      {!isLoading && isSleepDataMissing && (
        <Animated.View
          entering={FadeInUp.delay(160)
            .duration(duration.slow)
            .easing(Easing.bezier(0.16, 1, 0.3, 1))}
        >
          <Card title="Sleep Data Needed">
            <Text style={styles.sleepNeedMissing}>{sleepNeed.epistemicStatus?.label}</Text>
            <Text style={styles.sleepNeedMissing}>{sleepNeed.message}</Text>
          </Card>
        </Animated.View>
      )}

      {!isLoading && !isSleepDataMissing && (
        <Animated.View
          entering={FadeInUp.delay(160)
            .duration(duration.slow)
            .easing(Easing.bezier(0.16, 1, 0.3, 1))}
        >
          {lastNight ? (
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={() => router.push("/sleep")}
              accessibilityRole="button"
              accessibilityLabel="Open last night sleep details"
            >
              <Card title="Last Night">
                {dashboardData?.summaryDateContext ? (
                  <Text style={styles.sleepDate}>
                    Night of{" "}
                    {formatSummaryDateContext({
                      ...dashboardData.summaryDateContext,
                      effectiveDate: lastNight.date,
                    })}
                  </Text>
                ) : null}
                {lastNight.stagingAvailable ? (
                  <SleepBar
                    durationMinutes={lastNight.durationMinutes}
                    deepPercentage={lastNight.deepPct ?? 0}
                    remPercentage={lastNight.remPct ?? 0}
                    lightPercentage={lastNight.lightPct ?? 0}
                    awakePercentage={lastNight.awakePct ?? 0}
                  />
                ) : (
                  <Text style={styles.noDataText}>
                    {formatDurationMinutes(lastNight.durationMinutes)} recorded. Sleep stages were
                    not reported.
                  </Text>
                )}
                {sleepDebt > 0 && (
                  <Text style={styles.sleepDebt}>{formatSleepDebtInline(sleepDebt)}</Text>
                )}
              </Card>
            </TouchableOpacity>
          ) : (
            <Card title="Last Night">
              <Text style={styles.noDataText}>No sleep data</Text>
            </Card>
          )}
        </Animated.View>
      )}

      {/* Sleep estimate */}
      {!isLoading && !isSleepDataMissing && (sleepNeed || !lastNight) && (
        <Animated.View
          entering={FadeInUp.delay(320)
            .duration(duration.slow)
            .easing(Easing.bezier(0.16, 1, 0.3, 1))}
        >
          <Card title="Sleep Estimate">
            {sleepNeed == null ? (
              <Text style={styles.noDataText}>No sleep data</Text>
            ) : sleepNeed.availability === "available" ? (
              <>
                <Text style={styles.sleepNeedSubtitle}>{sleepNeed.epistemicStatus.label}</Text>
                <Text style={styles.sleepNeedTotal}>
                  {`${sleepNeed.estimateMetadata.valueQualifier} ${formatDurationMinutes(sleepNeed.totalNeedMinutes)}`}
                </Text>
                <Text style={styles.sleepNeedSubtitle}>
                  {sleepNeed.estimateMetadata.summaryLabel}
                </Text>
                <View style={styles.sleepNeedBreakdown}>
                  <View style={styles.sleepNeedRow}>
                    <Text style={styles.sleepNeedLabel}>
                      {sleepNeed.estimateMetadata.componentLabels.baseline}
                    </Text>
                    <Text style={styles.sleepNeedValue}>
                      {formatDurationMinutes(sleepNeed.baselineMinutes)}
                    </Text>
                  </View>
                  <View style={styles.sleepNeedRow}>
                    <Text style={styles.sleepNeedLabel}>
                      {sleepNeed.estimateMetadata.componentLabels.strainDebt}
                    </Text>
                    <Text style={styles.sleepNeedValue}>
                      +{formatDurationMinutes(sleepNeed.strainDebtMinutes)}
                    </Text>
                  </View>
                  <View style={styles.sleepNeedRow}>
                    <Text style={styles.sleepNeedLabel}>
                      {sleepNeed.estimateMetadata.componentLabels.debtRecovery}
                    </Text>
                    <Text style={styles.sleepNeedValue}>
                      +{formatDurationMinutes(sleepNeed.debtRecoveryMinutes)}
                    </Text>
                  </View>
                </View>
                <View style={styles.sleepNeedMetadata}>
                  <Text style={styles.sleepNeedMetadataText}>
                    {sleepNeed.estimateMetadata.basisLabel}
                  </Text>
                  <Text style={styles.sleepNeedMetadataText}>
                    {sleepNeed.estimateMetadata.coverageLabel}
                  </Text>
                  <Text style={styles.sleepNeedMetadataText}>
                    {sleepNeed.estimateMetadata.methodLabel}
                  </Text>
                  <Text style={styles.sleepNeedMetadataText}>
                    {sleepNeed.estimateMetadata.uncertaintyLabel}
                  </Text>
                  <Text style={styles.sleepNeedMetadataText}>
                    {sleepNeed.estimateMetadata.limitationLabel}
                  </Text>
                </View>
              </>
            ) : (
              <>
                <Text style={styles.sleepNeedMissing}>{sleepNeed.epistemicStatus.label}</Text>
                <Text style={styles.noDataText}>{sleepNeed.message}</Text>
                <Text style={styles.sleepNeedMissing}>{sleepNeed.nextAction}</Text>
              </>
            )}
          </Card>
        </Animated.View>
      )}
    </ScrollView>
  );
}

// ── Helper Components ─────────────────────────────────────────────────

function ComponentRow({
  label,
  score,
  delay = 0,
}: {
  label: string;
  score: number;
  delay?: number;
}) {
  const color = score >= 67 ? colors.positive : score >= 34 ? colors.warning : colors.danger;
  const barWidth = useSharedValue(0);

  useEffect(() => {
    barWidth.value = withDelay(
      100 + delay,
      withTiming(score, { duration: duration.countUp, easing: Easing.bezier(0.16, 1, 0.3, 1) }),
    );
  }, [barWidth, score, delay]);

  const barStyle = useAnimatedStyle(() => ({
    width: `${barWidth.value}%`,
    backgroundColor: color,
  }));

  return (
    <View style={componentStyles.row}>
      <Text style={componentStyles.label}>{label}</Text>
      <View style={componentStyles.barTrack}>
        <Animated.View style={[componentStyles.barFill, barStyle]} />
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
  sleepDate: {
    color: colors.textSecondary,
    fontSize: 12,
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
  ringTouchTarget: {
    alignItems: "center",
  },
  ringState: {
    width: 180,
  },
  gaugeState: {
    width: 140,
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
  noDataText: {
    fontSize: 15,
    color: colors.textTertiary,
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
  sleepNeedMetadata: {
    gap: 4,
    marginTop: 8,
  },
  sleepNeedMetadataText: {
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 17,
  },
});
