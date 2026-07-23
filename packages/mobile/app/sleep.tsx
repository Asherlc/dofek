import {
  formatDateLong,
  formatDateShort,
  formatDurationMinutes,
  formatHour,
  formatIntensity,
  formatSleepDebt,
  isToday,
  isYesterday,
} from "@dofek/format/format";
import { shouldShowBlockingLoading } from "@dofek/scoring/loading-policy";
import { sleepDebtColor } from "@dofek/scoring/scoring";
import { useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { ChartTitleWithTooltip } from "../components/ChartTitleWithTooltip";
import { Hypnogram } from "../components/charts/Hypnogram";
import { SleepBar } from "../components/charts/SleepBar";
import { SparkLine } from "../components/charts/SparkLine";
import { DaySelector } from "../components/DaySelector";
import { MetricCard } from "../components/MetricCard";
import { ProcessingStatusWidget } from "../components/ProcessingStatusWidget";
import { QueryStatePanel } from "../components/QueryStatePanel";
import { trpc } from "../lib/trpc";
import { useProcessingStatus } from "../lib/useProcessingStatus";
import { useRefresh } from "../lib/useRefresh";
import { colors } from "../theme";
import type { SleepConsistencyRow } from "../types/api";

export default function SleepScreen() {
  const [days, setDays] = useState(30);
  const sleepQuery = trpc.recovery.sleepAnalytics.useQuery({ days });
  const latestStagesQuery = trpc.sleep.latestStages.useQuery();
  const consistencyQuery = trpc.recovery.sleepConsistency.useQuery({ days });
  const processingStatus = useProcessingStatus({ datasets: ["sleep"] });

  const sleepResult = sleepQuery.data;
  const nightly = sleepResult?.nightly ?? [];
  const sleepDebt = sleepResult?.sleepDebt;
  const averageDurationMinutes = sleepResult?.averageDurationMinutes;
  const averageEfficiencyPercent = sleepResult?.averageEfficiencyPercent;
  const mostRecentNight = nightly[nightly.length - 1];
  const lastNight = (() => {
    if (!mostRecentNight) return undefined;
    const date = new Date(`${mostRecentNight.date}T00:00:00`);
    return isToday(date) || isYesterday(date) ? mostRecentNight : undefined;
  })();
  const consistency = consistencyQuery.data ?? [];
  const latestConsistency = consistency[consistency.length - 1];

  const durationTrend = nightly.slice(-14).map((n) => n.sleepMinutes);
  const efficiencyTrend = nightly.slice(-14).map((n) => n.efficiency);

  const isLoading = shouldShowBlockingLoading({
    data: nightly,
    isLoading: sleepQuery.isLoading,
    isFetching: sleepQuery.isFetching,
  });
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

      <ProcessingStatusWidget
        data={processingStatus.data}
        error={processingStatus.error}
        loading={processingStatus.isLoading}
      />

      {isLoading ? (
        <View style={styles.loadingContainer}>
          <Text style={styles.loadingText}>Loading sleep data...</Text>
        </View>
      ) : nightly.length === 0 ? (
        <QueryStatePanel
          variant="empty"
          title="No sleep data"
          message="No sleep data has been synced yet."
        />
      ) : (
        <>
          {/* Last night's sleep */}
          {lastNight && (
            <View style={styles.card}>
              <ChartTitleWithTooltip
                title="Last Night"
                description="This sleep stage bar shows how your most recent night was split across deep, REM, light, and awake time."
                textStyle={styles.cardTitle}
              />
              <SleepBar
                durationMinutes={lastNight.durationMinutes}
                deepPercentage={lastNight.deepPct}
                remPercentage={lastNight.remPct}
                lightPercentage={lastNight.lightPct}
                awakePercentage={lastNight.awakePct}
              />
              <View style={styles.efficiencyRow}>
                <Text style={styles.efficiencyLabel}>Sleep Efficiency</Text>
                <Text style={styles.efficiencyValue}>{formatIntensity(lastNight.efficiency)}</Text>
              </View>
            </View>
          )}

          {/* Hypnogram */}
          {(latestStagesQuery.data?.length ?? 0) > 0 && (
            <View style={styles.card}>
              <ChartTitleWithTooltip
                title="Last Night"
                description="This hypnogram shows the progression of your sleep stages throughout the night — when you were in deep, REM, light, or awake phases."
                textStyle={styles.cardTitle}
              />
              <Hypnogram data={latestStagesQuery.data ?? []} />
            </View>
          )}

          {/* Sleep debt */}
          {sleepDebt != null && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Sleep Debt (14 Days)</Text>
              <Text style={[styles.debtValue, { color: sleepDebtColor(sleepDebt) }]}>
                {formatSleepDebt(sleepDebt)}
              </Text>
              <Text style={styles.debtSubtitle}>vs 8 hour target per night</Text>
            </View>
          )}

          {/* Trends */}
          {averageDurationMinutes != null && averageEfficiencyPercent != null && (
            <View style={styles.metricsGrid}>
              <MetricCard
                title="Average Duration"
                value={formatDurationMinutes(averageDurationMinutes)}
                trend={durationTrend}
                color={colors.blue}
                subtitle={`Last ${days} nights`}
              />
              <MetricCard
                title="Average Efficiency"
                value={formatIntensity(averageEfficiencyPercent)}
                trend={efficiencyTrend}
                color={colors.purple}
                subtitle={`Last ${days} nights`}
              />
            </View>
          )}

          {/* Sleep consistency */}
          {latestConsistency && (
            <View style={styles.card}>
              <ChartTitleWithTooltip
                title="Schedule Consistency"
                description="This chart tracks how consistent your sleep and wake timing has been over recent nights."
                textStyle={styles.cardTitle}
              />
              <View style={styles.consistencyRow}>
                <View style={styles.consistencyStat}>
                  <Text style={styles.consistencyValue}>
                    {latestConsistency.consistencyScore ?? "--"}
                  </Text>
                  <Text style={styles.consistencyLabel}>Score</Text>
                </View>
                <View style={styles.consistencyStat}>
                  <Text style={styles.consistencyValue}>
                    {formatHour(latestConsistency.bedtimeHour)}
                  </Text>
                  <Text style={styles.consistencyLabel}>Avg Bedtime</Text>
                </View>
                <View style={styles.consistencyStat}>
                  <Text style={styles.consistencyValue}>
                    {formatHour(latestConsistency.waketimeHour)}
                  </Text>
                  <Text style={styles.consistencyLabel}>Avg Wake</Text>
                </View>
              </View>
              {consistency.length >= 2 &&
                (() => {
                  const scored = consistency.filter(
                    (c): c is SleepConsistencyRow & { consistencyScore: number } =>
                      c.consistencyScore != null,
                  );
                  const first = scored[0];
                  const last = scored[scored.length - 1];
                  if (!first || !last) return null;
                  return (
                    <>
                      <View style={styles.chartWithAxes}>
                        <View style={styles.yAxis}>
                          <Text style={styles.axisLabel}>100</Text>
                          <Text style={styles.axisLabel}>0</Text>
                        </View>
                        <View style={styles.chartBody}>
                          <SparkLine
                            data={scored.map((c) => c.consistencyScore)}
                            height={60}
                            color={colors.purple}
                            showBaseline
                          />
                          <View style={styles.xAxis}>
                            <Text style={styles.axisLabel}>{formatDateShort(first.date)}</Text>
                            <Text style={styles.axisLabel}>{formatDateShort(last.date)}</Text>
                          </View>
                        </View>
                      </View>
                      <View style={styles.legend}>
                        <View style={styles.legendItem}>
                          <View style={[styles.legendLine, { backgroundColor: colors.purple }]} />
                          <Text style={styles.legendText}>Consistency Score</Text>
                        </View>
                        <View style={styles.legendItem}>
                          <View style={[styles.legendDashed, { borderColor: "#3a3a3e" }]} />
                          <Text style={styles.legendText}>Average</Text>
                        </View>
                      </View>
                    </>
                  );
                })()}
            </View>
          )}

          {/* Nightly history */}
          {nightly.length > 0 && (
            <View style={styles.card}>
              <ChartTitleWithTooltip
                title="Recent Nights"
                description="These stacked bars compare the sleep-stage breakdown for your most recent nights."
                textStyle={styles.cardTitle}
              />
              <View style={styles.nightlyStack}>
                {nightly
                  .slice(-7)
                  .reverse()
                  .map((night) => (
                    <View key={night.date} style={styles.nightlyRow}>
                      <Text style={styles.nightlyDate}>{formatDateLong(night.date)}</Text>
                      <View style={styles.nightlyBarContainer}>
                        <SleepBar
                          durationMinutes={night.durationMinutes}
                          deepPercentage={night.deepPct}
                          remPercentage={night.remPct}
                          lightPercentage={night.lightPct}
                          awakePercentage={night.awakePct}
                          showLegend={false}
                        />
                      </View>
                    </View>
                  ))}
              </View>
            </View>
          )}
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
  efficiencyRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 4,
  },
  efficiencyLabel: {
    fontSize: 14,
    color: colors.textSecondary,
  },
  efficiencyValue: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.purple,
    fontVariant: ["tabular-nums"],
  },
  debtValue: {
    fontSize: 28,
    fontWeight: "700",
  },
  debtSubtitle: {
    fontSize: 12,
    color: colors.textTertiary,
  },
  metricsGrid: {
    gap: 12,
  },
  consistencyRow: {
    flexDirection: "row",
    justifyContent: "space-around",
  },
  consistencyStat: {
    alignItems: "center",
    gap: 4,
  },
  consistencyValue: {
    fontSize: 20,
    fontWeight: "700",
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  consistencyLabel: {
    fontSize: 11,
    color: colors.textTertiary,
  },
  chartWithAxes: {
    flexDirection: "row",
    marginTop: 4,
  },
  yAxis: {
    justifyContent: "space-between",
    paddingRight: 6,
    paddingBottom: 18,
  },
  chartBody: {
    flex: 1,
  },
  xAxis: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 4,
  },
  axisLabel: {
    fontSize: 10,
    color: colors.textTertiary,
    fontVariant: ["tabular-nums"],
  },
  legend: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 16,
    marginTop: 8,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  legendLine: {
    width: 14,
    height: 2,
    borderRadius: 1,
  },
  legendDashed: {
    width: 14,
    height: 0,
    borderTopWidth: 1,
    borderStyle: "dashed",
  },
  legendText: {
    fontSize: 10,
    color: colors.textTertiary,
  },
  nightlyStack: {
    gap: 12,
  },
  nightlyRow: {
    gap: 4,
  },
  nightlyDate: {
    fontSize: 12,
    color: colors.textTertiary,
  },
  nightlyBarContainer: {
    flex: 1,
  },
});
