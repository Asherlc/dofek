import { ScrollView, StyleSheet, Text, View } from "react-native";
import { MetricCard } from "../../components/MetricCard";
import { SleepBar } from "../../components/charts/SleepBar";
import { SparkLine } from "../../components/charts/SparkLine";
import { trpc } from "../../lib/trpc";

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

interface SleepConsistencyRow {
  date: string;
  bedtimeHour: number;
  waketimeHour: number;
  rollingBedtimeStddev: number | null;
  rollingWaketimeStddev: number | null;
  consistencyScore: number | null;
}

function formatDebt(minutes: number): string {
  if (minutes <= 0) return "No sleep debt";
  const hours = Math.floor(Math.abs(minutes) / 60);
  const mins = Math.abs(minutes) % 60;
  return `${hours}h ${mins}m debt`;
}

export default function SleepScreen() {
  const sleepQuery = trpc.recovery.sleepAnalytics.useQuery({ days: 30 });
  const consistencyQuery = trpc.recovery.sleepConsistency.useQuery({ days: 30 });

  const sleepResult = sleepQuery.data as { nightly: SleepNightlyRow[]; sleepDebt: number } | undefined;
  const nightly = sleepResult?.nightly ?? [];
  const sleepDebt = sleepResult?.sleepDebt ?? 0;
  const lastNight = nightly[nightly.length - 1];
  const consistency = (consistencyQuery.data ?? []) as SleepConsistencyRow[];
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
                { color: sleepDebt > 120 ? "#FF3D00" : sleepDebt > 60 ? "#FFD600" : "#00E676" },
              ]}
            >
              {formatDebt(sleepDebt)}
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
              color="#42A5F5"
              subtitle="Last 30 nights"
            />
            <MetricCard
              title="Average Efficiency"
              value={`${Math.round(avgEfficiency)}`}
              unit="%"
              trend={efficiencyTrend}
              color="#5E35B1"
              subtitle="Last 30 nights"
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
                      .filter((c: SleepConsistencyRow) => c.consistencyScore != null)
                      .map((c: SleepConsistencyRow) => c.consistencyScore as number)}
                    width={300}
                    height={50}
                    color="#5E35B1"
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

function formatHour(decimalHour: number): string {
  // Handle hours that wrap past midnight (e.g., 23.5 = 11:30 PM)
  const hour24 = Math.floor(decimalHour) % 24;
  const minutes = Math.round((decimalHour % 1) * 60);
  const period = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 === 0 ? 12 : hour24 > 12 ? hour24 - 12 : hour24;
  return `${hour12}:${String(minutes).padStart(2, "0")} ${period}`;
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
    gap: 12,
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: "#8e8e93",
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
    color: "#8e8e93",
  },
  efficiencyValue: {
    fontSize: 18,
    fontWeight: "700",
    color: "#5E35B1",
    fontVariant: ["tabular-nums"],
  },
  debtValue: {
    fontSize: 28,
    fontWeight: "700",
  },
  debtSubtitle: {
    fontSize: 12,
    color: "#636366",
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
    color: "#fff",
    fontVariant: ["tabular-nums"],
  },
  consistencyLabel: {
    fontSize: 11,
    color: "#636366",
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
    color: "#636366",
  },
  nightlyBarContainer: {
    flex: 1,
  },
});
