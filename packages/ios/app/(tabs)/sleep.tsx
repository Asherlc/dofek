import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { DaySelector } from "../../components/DaySelector";
import { MetricCard } from "../../components/MetricCard";
import { SleepBar } from "../../components/charts/SleepBar";
import { SparkLine } from "../../components/charts/SparkLine";
import { formatHour, formatSleepDebt } from "../../lib/format";
import { trpc } from "../../lib/trpc";
import type { SleepConsistencyRow, SleepNightlyRow } from "../../types/api";
import { colors } from "../../theme";

export default function SleepScreen() {
  const [days, setDays] = useState(30);
  const sleepQuery = trpc.recovery.sleepAnalytics.useQuery({ days });
  const consistencyQuery = trpc.recovery.sleepConsistency.useQuery({ days });

  const sleepResult = sleepQuery.data;
  const nightly = sleepResult?.nightly ?? [];
  const sleepDebt = sleepResult?.sleepDebt ?? 0;
  const lastNight = nightly[nightly.length - 1];
  const consistency = consistencyQuery.data ?? [];
  const latestConsistency = consistency[consistency.length - 1];

  const durationTrend = nightly
    .slice(-14)
    .map((n) => n.durationMinutes);
  const efficiencyTrend = nightly
    .slice(-14)
    .map((n) => n.efficiency);

  const avgDuration =
    nightly.length > 0
      ? nightly.reduce((sum, n) => sum + n.durationMinutes, 0) / nightly.length
      : 0;

  const avgEfficiency =
    nightly.length > 0
      ? nightly.reduce((sum, n) => sum + n.efficiency, 0) / nightly.length
      : 0;

  const isLoading = sleepQuery.isLoading;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
    >
      <DaySelector days={days} onChange={setDays} />

      {isLoading ? (
        <View style={styles.loadingContainer}>
          <Text style={styles.loadingText}>Loading sleep data...</Text>
        </View>
      ) : (
        <>
          {/* Last night's sleep */}
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
              <View style={styles.efficiencyRow}>
                <Text style={styles.efficiencyLabel}>Sleep Efficiency</Text>
                <Text style={styles.efficiencyValue}>
                  {Math.round(lastNight.efficiency)}%
                </Text>
              </View>
            </View>
          )}

          {/* Sleep debt */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Sleep Debt (14 Days)</Text>
            <Text
              style={[
                styles.debtValue,
                { color: sleepDebt > 120 ? colors.danger : sleepDebt > 60 ? colors.warning : colors.positive },
              ]}
            >
              {formatSleepDebt(sleepDebt)}
            </Text>
            <Text style={styles.debtSubtitle}>
              vs 8 hour target per night
            </Text>
          </View>

          {/* Trends */}
          <View style={styles.metricsGrid}>
            <MetricCard
              title="Average Duration"
              value={`${Math.floor(avgDuration / 60)}h ${Math.round(avgDuration % 60)}m`}
              trend={durationTrend}
              color={colors.blue}
              subtitle={`Last ${days} nights`}
            />
            <MetricCard
              title="Average Efficiency"
              value={`${Math.round(avgEfficiency)}`}
              unit="%"
              trend={efficiencyTrend}
              color={colors.purple}
              subtitle={`Last ${days} nights`}
            />
          </View>

          {/* Sleep consistency */}
          {latestConsistency && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Schedule Consistency</Text>
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
              {consistency.length >= 2 && (
                <View style={styles.sparkContainer}>
                  <SparkLine
                    data={consistency
                      .filter((c) => c.consistencyScore != null)
                      .map((c) => c.consistencyScore as number)}
                    width={300}
                    height={50}
                    color={colors.purple}
                    showBaseline
                  />
                </View>
              )}
            </View>
          )}

          {/* Nightly history */}
          {nightly.length > 0 && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Recent Nights</Text>
              <View style={styles.nightlyStack}>
                {nightly.slice(-7).reverse().map((night) => (
                  <View key={night.date} style={styles.nightlyRow}>
                    <Text style={styles.nightlyDate}>
                      {new Date(night.date).toLocaleDateString("en-US", {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                      })}
                    </Text>
                    <View style={styles.nightlyBarContainer}>
                      <SleepBar
                        durationMinutes={night.durationMinutes}
                        deepPct={night.deepPct}
                        remPct={night.remPct}
                        lightPct={night.lightPct}
                        awakePct={night.awakePct}
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
  sparkContainer: {
    alignItems: "center",
    marginTop: 4,
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
