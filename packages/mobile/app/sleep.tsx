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
import { formatRecordLocalTime } from "@dofek/format/record-local-time";
import { getMissingSleepStates } from "@dofek/format/sleep-data-state";
import { shouldShowBlockingLoading } from "@dofek/scoring/loading-policy";
import { sleepDebtColor } from "@dofek/scoring/scoring";
import { useRef } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { ChartTitleWithTooltip } from "../components/ChartTitleWithTooltip";
import { Hypnogram } from "../components/charts/Hypnogram";
import { SleepBar } from "../components/charts/SleepBar";
import { SparkLine } from "../components/charts/SparkLine";
import { DaySelector } from "../components/DaySelector";
import { MetricCard } from "../components/MetricCard";
import { ProcessingStatusWidget } from "../components/ProcessingStatusWidget";
import { QueryStatePanel } from "../components/QueryStatePanel";
import { SleepSourceReview } from "../components/SleepSourceReview";
import { trpc } from "../lib/trpc";
import { useProcessingStatus } from "../lib/useProcessingStatus";
import { useRefresh } from "../lib/useRefresh";
import { useTimeRangePreference } from "../lib/useTimeRangePreference";
import { colors } from "../theme";
import type { SleepConsistencyRow, SleepNightlyRow } from "../types/api";

function hasStagePercentages(night: SleepNightlyRow): night is SleepNightlyRow & {
  durationMinutes: number;
  deepPct: number;
  remPct: number;
  lightPct: number;
  awakePct: number;
} {
  return (
    night.stageState.status === "available" &&
    night.durationMinutes != null &&
    night.deepPct != null &&
    night.remPct != null &&
    night.lightPct != null &&
    night.awakePct != null
  );
}

function SleepUnavailableDetails({
  night,
  compact = false,
}: {
  night: SleepNightlyRow;
  compact?: boolean;
}) {
  const missingStates = getMissingSleepStates(night);
  if (compact) {
    return (
      <View style={styles.stageUnavailableDetails}>
        {missingStates.map((state) => (
          <View key={`${state.reason}-${state.nextAction}`}>
            <Text style={styles.stageUnavailable}>{state.reason}</Text>
            <Text style={styles.stageUnavailableNextAction}>{state.nextAction}</Text>
          </View>
        ))}
      </View>
    );
  }

  return (
    <View style={styles.partialRecord}>
      <Text style={styles.partialRecordTitle}>
        {night.durationMinutes == null ? "Sleep data unavailable" : "Partial sleep record"}
      </Text>
      {night.durationMinutes != null && (
        <Text style={styles.partialRecordDuration}>
          {formatDurationMinutes(night.durationMinutes)} recorded
        </Text>
      )}
      {missingStates.map((state) => (
        <View key={`${state.reason}-${state.nextAction}`}>
          <Text style={styles.partialRecordMessage}>{state.reason}</Text>
          <Text style={styles.partialRecordNextAction}>{state.nextAction}</Text>
        </View>
      ))}
    </View>
  );
}

function renderStageContent(night: SleepNightlyRow, compact = false) {
  if (hasStagePercentages(night)) {
    return (
      <SleepBar
        durationMinutes={night.durationMinutes}
        deepPercentage={night.deepPct}
        remPercentage={night.remPct}
        lightPercentage={night.lightPct}
        awakePercentage={night.awakePct}
        showLegend={!compact}
      />
    );
  }

  if (night.durationMinutes === 0 && night.stageState.status === "available") {
    return (
      <Text style={compact ? styles.stageUnavailable : styles.partialRecordDuration}>
        {formatDurationMinutes(night.durationMinutes)} recorded
      </Text>
    );
  }

  return <SleepUnavailableDetails night={night} compact={compact} />;
}

export default function SleepScreen() {
  const scrollViewRef = useRef<ScrollView>(null);
  const sleepSourcesYRef = useRef(0);
  const { days, description, setDays } = useTimeRangePreference("sleep");
  const sleepQuery = trpc.recovery.sleepAnalytics.useQuery({ days });
  const latestStagesQuery = trpc.sleep.latestStages.useQuery();
  const consistencyQuery = trpc.recovery.sleepConsistency.useQuery({ days });
  const processingStatus = useProcessingStatus({ datasets: ["sleep"] });

  const sleepResult = sleepQuery.data;
  const nightly = sleepResult?.nightly ?? [];
  const sleepDebt = sleepResult?.sleepDebt;
  const averageSleepMinutes = sleepResult?.averageSleepMinutes;
  const averageEfficiencyPercent = sleepResult?.averageEfficiencyPercent;
  const mostRecentNight = nightly[nightly.length - 1];
  const lastNight = (() => {
    if (!mostRecentNight) return undefined;
    const date = new Date(`${mostRecentNight.date}T00:00:00`);
    return isToday(date) || isYesterday(date) ? mostRecentNight : undefined;
  })();
  const consistency = consistencyQuery.data ?? [];
  const latestConsistency = consistency[consistency.length - 1];
  const lastNightBedtime = lastNight
    ? formatRecordLocalTime(lastNight.startedAt, lastNight.localTimeContext, "start")
    : "--";
  const lastNightWake =
    lastNight?.endedAt == null
      ? "--"
      : formatRecordLocalTime(lastNight.endedAt, lastNight.localTimeContext, "end");

  const durationTrend = nightly.slice(-14).map((n) => n.sleepMinutes);
  const efficiencyTrend = nightly
    .slice(-14)
    .map((night) => night.efficiency)
    .filter((efficiency): efficiency is number => efficiency != null);

  const isLoading = shouldShowBlockingLoading({
    data: nightly,
    isLoading: sleepQuery.isLoading,
    isFetching: sleepQuery.isFetching,
  });
  const { refreshing, onRefresh } = useRefresh();
  const scrollToSleepSources = () => {
    scrollViewRef.current?.scrollTo({
      animated: true,
      y: Math.max(sleepSourcesYRef.current - 16, 0),
    });
  };

  return (
    <ScrollView
      ref={scrollViewRef}
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

      <ProcessingStatusWidget
        data={processingStatus.data}
        error={processingStatus.error}
        loading={processingStatus.isLoading}
      />

      {isLoading ? (
        <View style={styles.loadingContainer}>
          <Text style={styles.loadingText}>Loading sleep data...</Text>
        </View>
      ) : sleepQuery.isError && !sleepQuery.data ? (
        <QueryStatePanel variant="error" message={sleepQuery.error.message} />
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
              {renderStageContent(lastNight)}
              <Text style={styles.sleepTiming}>
                {lastNightBedtime === "--" || lastNightWake === "--"
                  ? "Local sleep time unavailable"
                  : `${lastNightBedtime} – ${lastNightWake}`}
              </Text>
              {lastNight.efficiency != null && (
                <View style={styles.efficiencyRow}>
                  <Text style={styles.efficiencyLabel}>Sleep Efficiency</Text>
                  <Text style={styles.efficiencyValue}>
                    {formatIntensity(lastNight.efficiency)}
                  </Text>
                </View>
              )}
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
              <Text style={styles.debtSubtitle}>Compared with your sleep target</Text>
            </View>
          )}

          {/* Trends */}
          {(averageSleepMinutes != null || averageEfficiencyPercent != null) && (
            <View style={styles.metricsGrid}>
              {averageSleepMinutes != null && (
                <MetricCard
                  title="Average Duration"
                  value={formatDurationMinutes(averageSleepMinutes)}
                  trend={durationTrend}
                  color={colors.blue}
                  subtitle={`Last ${days} nights`}
                  onViewData={scrollToSleepSources}
                />
              )}
              {averageEfficiencyPercent != null && (
                <MetricCard
                  title="Average Efficiency"
                  value={formatIntensity(averageEfficiencyPercent)}
                  trend={efficiencyTrend}
                  color={colors.purple}
                  subtitle={`Last ${days} nights`}
                  onViewData={scrollToSleepSources}
                />
              )}
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
                        {renderStageContent(night, true)}
                      </View>
                    </View>
                  ))}
              </View>
            </View>
          )}

          <View
            onLayout={(event) => {
              sleepSourcesYRef.current = event.nativeEvent.layout.y;
            }}
          >
            <SleepSourceReview nights={[...nightly].slice(-7).reverse()} />
          </View>
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
  sleepTiming: {
    color: colors.textSecondary,
    fontSize: 13,
    textAlign: "center",
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
  partialRecord: {
    gap: 4,
    paddingVertical: 8,
  },
  partialRecordTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.text,
  },
  partialRecordDuration: {
    fontSize: 15,
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  partialRecordMessage: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  partialRecordNextAction: {
    fontSize: 13,
    color: colors.textTertiary,
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
  stageUnavailable: {
    fontSize: 12,
    color: colors.textSecondary,
    paddingVertical: 8,
  },
  stageUnavailableDetails: {
    gap: 4,
    paddingVertical: 8,
  },
  stageUnavailableNextAction: {
    fontSize: 12,
    color: colors.textTertiary,
  },
});
