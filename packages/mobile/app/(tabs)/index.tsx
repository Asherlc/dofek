import { formatDurationMinutes } from "@dofek/format/format";
import { formatSummaryDateContext } from "@dofek/format/summary-date-context";
import { isConnectionFailure, userFacingErrorMessage } from "@dofek/format/user-facing-error";
import { shouldShowBlockingLoading } from "@dofek/scoring/loading-policy";
import { useRouter } from "expo-router";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import Animated, { Easing, FadeInUp } from "react-native-reanimated";
import { Card } from "../../components/Card";
import { SleepBar } from "../../components/charts/SleepBar";
import { OverviewEvidence, overviewDays } from "../../components/OverviewEvidence";
import { ProcessingStatusWidget } from "../../components/ProcessingStatusWidget";
import { ProviderGuide } from "../../components/ProviderGuide";
import { getQueryErrorMessage, QueryStatePanel } from "../../components/QueryStatePanel";
import { trpc } from "../../lib/trpc";
import { useUnitConverter } from "../../lib/units";
import { useProcessingStatus } from "../../lib/useProcessingStatus";
import { useProviderGuide } from "../../lib/useProviderGuide";
import { useRefresh } from "../../lib/useRefresh";
import { useTodayQueryDate } from "../../lib/useTodayQueryDate";
import { colors, duration } from "../../theme";

export default function OverviewScreen() {
  const router = useRouter();
  const units = useUnitConverter();
  const providerGuide = useProviderGuide();
  const endDate = useTodayQueryDate();
  const overviewInput = { days: overviewDays, endDate };
  const overviewOptions = { placeholderData: <Data,>(previous: Data | undefined) => previous };
  const insightsQuery = trpc.insights.compute.useQuery(overviewInput, overviewOptions);
  const trendsQuery = trpc.dailyMetrics.trends.useQuery(overviewInput, overviewOptions);
  const heartRateQuery = trpc.dailyMetrics.hrvBaseline.useQuery(overviewInput, overviewOptions);

  // Consolidated dashboard data fetch
  const dashboardQuery = trpc.mobileDashboard.dashboardV2.useQuery(
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

  const lastNight = dashboardData?.sleep?.lastNight;
  const anomalies = anomalyQuery.data ?? dashboardData?.anomalies;

  const isLoading = shouldShowBlockingLoading({
    data: dashboardData,
    isFetching: dashboardQuery.isFetching,
    isLoading: dashboardQuery.isLoading,
  });
  const isError = dashboardQuery.isError && dashboardData == null;
  const hasBackgroundError = dashboardQuery.isError && dashboardData != null;
  const connectionFailures = [
    providerGuide.error,
    dashboardQuery.error,
    insightsQuery.error,
    trendsQuery.error,
    heartRateQuery.error,
    processingStatusQuery.error,
  ].filter((error) => error != null && isConnectionFailure(error));
  const sharedConnectionFailure = connectionFailures.length > 1;

  const { refreshing, onRefresh } = useRefresh({
    refresh: async () => {
      await Promise.all([
        dashboardQuery.refetch(),
        insightsQuery.refetch(),
        trendsQuery.refetch(),
        heartRateQuery.refetch(),
        anomalyQuery.refetch(),
        processingStatusQuery.refetch(),
      ]);
    },
    invalidate: null,
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
      <Text accessibilityRole="header" style={styles.heading}>
        Overview
      </Text>
      {/* Provider guide — shown to new users with no connected providers */}
      {providerGuide.showProviderGuide && (
        <ProviderGuide onDismiss={providerGuide.dismiss} providers={providerGuide.providers} />
      )}

      {sharedConnectionFailure ? (
        <QueryStatePanel
          variant="error"
          message={userFacingErrorMessage(connectionFailures[0])}
          minHeight={72}
        />
      ) : null}

      {providerGuide.error &&
      !(sharedConnectionFailure && isConnectionFailure(providerGuide.error)) ? (
        <QueryStatePanel
          variant="error"
          title="Could not refresh provider setup"
          message={getQueryErrorMessage(providerGuide.error)}
          minHeight={72}
        />
      ) : null}

      <ProcessingStatusWidget
        data={processingStatusQuery.data}
        error={
          sharedConnectionFailure && isConnectionFailure(processingStatusQuery.error)
            ? undefined
            : processingStatusQuery.error
        }
        loading={processingStatusQuery.isLoading}
      />

      <OverviewEvidence
        endDate={endDate}
        insights={insightsQuery}
        trends={trendsQuery}
        heartRate={heartRateQuery}
        units={units}
        hideConnectionErrors={sharedConnectionFailure}
        openBody={() => router.push("/body")}
        openHeartRate={() => router.push({ pathname: "/body", params: { section: "heart-rate" } })}
        openCorrelation={() => router.push("/correlation")}
      />

      {isError && !(sharedConnectionFailure && isConnectionFailure(dashboardQuery.error)) ? (
        <QueryStatePanel
          variant="error"
          message={getQueryErrorMessage(dashboardQuery.error, "Failed to load dashboard.")}
        />
      ) : null}

      {hasBackgroundError &&
      !(sharedConnectionFailure && isConnectionFailure(dashboardQuery.error)) ? (
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
            {anomalies.anomalies[0]?.baselineMean} ± {anomalies.anomalies[0]?.baselineStddev})
          </Text>
        </View>
      )}

      {dashboardData?.summaryDateContext ? (
        <Text style={styles.date}>
          {formatSummaryDateContext(dashboardData.summaryDateContext)}
        </Text>
      ) : null}

      <Animated.View
        entering={FadeInUp.delay(160)
          .duration(duration.slow)
          .easing(Easing.bezier(0.16, 1, 0.3, 1))}
      >
        {isError ? null : isLoading ? (
          <Card title="Last Night">
            <QueryStatePanel variant="loading" minHeight={120} />
          </Card>
        ) : lastNight ? (
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
                  {formatDurationMinutes(lastNight.durationMinutes)} recorded. Sleep stages were not
                  reported.
                </Text>
              )}
            </Card>
          </TouchableOpacity>
        ) : (
          <Card title="Last Night">
            <Text style={styles.noDataText}>
              {dashboardQuery.isPaused && dashboardData == null
                ? "Waiting for a connection"
                : "No sleep data"}
            </Text>
          </Card>
        )}
      </Animated.View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  heading: { color: colors.text, fontSize: 30, fontWeight: "700", letterSpacing: -0.8 },
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
});
