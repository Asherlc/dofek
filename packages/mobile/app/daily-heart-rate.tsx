import { formatDateYmd } from "@dofek/format/format";
import { Stack } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  MultiSourceHeartRateChart,
  sourceColor,
} from "../components/charts/MultiSourceHeartRateChart";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";
import { rootStackScreenOptions } from "./_layout";

function formatDisplayDate(dateString: string): string {
  const [year, month, day] = dateString.split("-");
  return `${month}/${day}/${year}`;
}

export default function DailyHeartRateScreen() {
  const [date, setDate] = useState(() => formatDateYmd());

  const query = trpc.heartRate.dailyBySource.useQuery({ date });
  const sources = query.data ?? [];

  const goBack = () => {
    const previous = new Date(date);
    previous.setDate(previous.getDate() - 1);
    setDate(formatDateYmd(previous));
  };

  const goForward = () => {
    const next = new Date(date);
    next.setDate(next.getDate() + 1);
    const today = formatDateYmd();
    const nextDate = formatDateYmd(next);
    if (nextDate <= today) {
      setDate(nextDate);
    }
  };

  const isToday = date === formatDateYmd();

  return (
    <>
      <Stack.Screen options={{ ...rootStackScreenOptions, title: "Heart Rate by Source" }} />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {/* Date Navigator */}
        <View style={styles.dateNav}>
          <Pressable style={styles.dateButton} onPress={goBack}>
            <Text style={styles.dateButtonText}>{"<"}</Text>
          </Pressable>
          <Text style={styles.dateLabel}>{formatDisplayDate(date)}</Text>
          <Pressable
            style={[styles.dateButton, isToday && styles.dateButtonDisabled]}
            onPress={goForward}
            disabled={isToday}
          >
            <Text style={[styles.dateButtonText, isToday && styles.dateButtonTextDisabled]}>
              {">"}
            </Text>
          </Pressable>
        </View>

        {/* Chart */}
        <View style={styles.chartContainer}>
          {sources.length > 0 ? (
            <MultiSourceHeartRateChart sources={sources} height={220} />
          ) : (
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>
                {query.isLoading ? "Loading..." : "No heart rate data for this day"}
              </Text>
            </View>
          )}
        </View>

        {/* Legend */}
        {sources.length > 1 && (
          <View style={styles.legend}>
            {sources.map((source, index) => (
              <View key={source.providerId} style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: sourceColor(index) }]} />
                <Text style={styles.legendLabel}>{source.providerLabel}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Source Summary */}
        {sources.map((source, index) => {
          const heartRates = source.samples.map((sample) => sample.heartRate);
          const min = Math.min(...heartRates);
          const avg = Math.round(
            heartRates.reduce((sum, value) => sum + value, 0) / heartRates.length,
          );
          const max = Math.max(...heartRates);

          return (
            <View key={source.providerId} style={styles.sourceCard}>
              <View style={styles.sourceHeader}>
                <View style={[styles.sourceDot, { backgroundColor: sourceColor(index) }]} />
                <Text style={styles.sourceName}>{source.providerLabel}</Text>
                <Text style={styles.sampleCount}>{source.samples.length} samples</Text>
              </View>
              <View style={styles.statsRow}>
                <View style={styles.statBox}>
                  <Text style={styles.statLabel}>Min</Text>
                  <Text style={styles.statValue}>{min}</Text>
                </View>
                <View style={styles.statBox}>
                  <Text style={styles.statLabel}>Avg</Text>
                  <Text style={styles.statValue}>{avg}</Text>
                </View>
                <View style={styles.statBox}>
                  <Text style={styles.statLabel}>Max</Text>
                  <Text style={styles.statValue}>{max}</Text>
                </View>
              </View>
            </View>
          );
        })}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: 40 },
  dateNav: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    paddingVertical: 16,
  },
  dateButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  dateButtonDisabled: { opacity: 0.3 },
  dateButtonText: { fontSize: 18, fontWeight: "600", color: colors.text },
  dateButtonTextDisabled: { color: colors.textSecondary },
  dateLabel: { fontSize: 16, fontWeight: "600", color: colors.text },
  chartContainer: {
    marginHorizontal: 16,
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 12,
    height: 244,
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: { fontSize: 14, color: colors.textSecondary },
  legend: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginHorizontal: 16,
    marginTop: 12,
  },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendLabel: { fontSize: 13, color: colors.textSecondary },
  sourceCard: {
    marginHorizontal: 16,
    marginTop: 12,
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 16,
  },
  sourceHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 12,
  },
  sourceDot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  sourceName: { fontSize: 15, fontWeight: "600", color: colors.text, flex: 1 },
  sampleCount: { fontSize: 13, color: colors.textSecondary },
  statsRow: { flexDirection: "row", gap: 8 },
  statBox: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 8,
    backgroundColor: colors.background,
    borderRadius: 8,
  },
  statLabel: { fontSize: 12, fontWeight: "600", color: colors.textSecondary, marginBottom: 4 },
  statValue: {
    fontSize: 20,
    fontWeight: "700",
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
});
