import { formatDateYmd, shiftDateYmd } from "@dofek/format/format";
import { Stack } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  MultiSourceHeartRateChart,
  sourceColor,
} from "../components/charts/MultiSourceHeartRateChart";
import { getQueryErrorMessage, QueryStatePanel } from "../components/QueryStatePanel";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";
import { rootStackScreenOptions } from "./_layout-options";

function formatDisplayDate(dateString: string): string {
  const [year, month, day] = dateString.split("-");
  if (!year || !month || !day) {
    return dateString;
  }
  return `${month}/${day}/${year}`;
}

export default function DailyHeartRateScreen() {
  const [date, setDate] = useState(() => formatDateYmd());
  const today = formatDateYmd();
  const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const query = trpc.heartRate.dailyBySource.useQuery({ date });
  const sources = query.data;
  const hasSources = sources !== undefined && sources.length > 0;

  const goBack = () => {
    setDate(shiftDateYmd(date, -1));
  };

  const goForward = () => {
    const nextDate = shiftDateYmd(date, 1);
    if (nextDate <= today) {
      setDate(nextDate);
    }
  };

  const isToday = date === today;

  return (
    <>
      <Stack.Screen options={{ ...rootStackScreenOptions, title: "Heart Rate by Source" }} />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {/* Date Navigator */}
        <View style={styles.dateNav}>
          <View style={styles.dateNavRow}>
            <Pressable
              style={styles.dateButton}
              onPress={goBack}
              accessibilityRole="button"
              accessibilityLabel="Previous day"
            >
              <Text style={styles.dateButtonText}>Previous</Text>
            </Pressable>
            <View style={styles.dateLabelContainer}>
              <Text style={styles.dateLabel}>{formatDisplayDate(date)}</Text>
              <Text style={styles.timezoneLabel}>Local day in {localTimezone}</Text>
            </View>
            <Pressable
              style={[styles.dateButton, isToday && styles.dateButtonDisabled]}
              onPress={goForward}
              disabled={isToday}
              accessibilityRole="button"
              accessibilityLabel="Next day"
              accessibilityState={{ disabled: isToday }}
            >
              <Text style={[styles.dateButtonText, isToday && styles.dateButtonTextDisabled]}>
                Next
              </Text>
            </Pressable>
          </View>
          <Pressable
            style={[styles.todayButton, isToday && styles.dateButtonDisabled]}
            onPress={() => setDate(today)}
            disabled={isToday}
            accessibilityRole="button"
            accessibilityLabel="Today"
            accessibilityState={{ disabled: isToday }}
          >
            <Text style={[styles.todayButtonText, isToday && styles.dateButtonTextDisabled]}>
              Today
            </Text>
          </Pressable>
        </View>

        {/* Chart */}
        <View style={styles.chartContainer}>
          {hasSources ? (
            <MultiSourceHeartRateChart sources={sources} height={220} />
          ) : query.isLoading ? (
            <QueryStatePanel variant="loading" minHeight={220} />
          ) : query.error ? (
            <QueryStatePanel
              variant="error"
              message={getQueryErrorMessage(query.error)}
              minHeight={220}
            />
          ) : (
            <QueryStatePanel
              variant="empty"
              message="No heart rate data for this day"
              minHeight={220}
            />
          )}
        </View>

        {hasSources && query.error ? (
          <View style={styles.queryError}>
            <QueryStatePanel
              variant="error"
              message={getQueryErrorMessage(query.error)}
              minHeight={72}
            />
          </View>
        ) : null}

        {/* Legend */}
        {hasSources && sources.length > 1 && (
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
        {hasSources
          ? sources.map((source, index) => (
              <View key={source.providerId} style={styles.sourceCard}>
                <View style={styles.sourceHeader}>
                  <View style={[styles.sourceDot, { backgroundColor: sourceColor(index) }]} />
                  <Text style={styles.sourceName}>{source.providerLabel}</Text>
                  <Text style={styles.sampleCount}>{source.sampleCount} samples</Text>
                </View>
                <View style={styles.statsRow}>
                  <View style={styles.statBox}>
                    <Text style={styles.statLabel}>Min</Text>
                    <Text style={styles.statValue}>{source.minHeartRate}</Text>
                  </View>
                  <View style={styles.statBox}>
                    <Text style={styles.statLabel}>Avg</Text>
                    <Text style={styles.statValue}>{source.avgHeartRate}</Text>
                  </View>
                  <View style={styles.statBox}>
                    <Text style={styles.statLabel}>Max</Text>
                    <Text style={styles.statValue}>{source.maxHeartRate}</Text>
                  </View>
                </View>
              </View>
            ))
          : null}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: 40 },
  dateNav: {
    alignItems: "center",
    gap: 10,
    paddingVertical: 16,
  },
  dateNavRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
  dateButton: {
    minWidth: 36,
    minHeight: 36,
    paddingHorizontal: 10,
    borderRadius: 18,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  dateButtonDisabled: { opacity: 0.3 },
  dateButtonText: { fontSize: 18, fontWeight: "600", color: colors.text },
  dateButtonTextDisabled: { color: colors.textSecondary },
  dateLabelContainer: { alignItems: "center" },
  dateLabel: { fontSize: 16, fontWeight: "600", color: colors.text },
  timezoneLabel: { fontSize: 12, color: colors.textSecondary, marginTop: 4 },
  todayButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: colors.surface,
  },
  todayButtonText: { fontSize: 14, fontWeight: "600", color: colors.text },
  chartContainer: {
    marginHorizontal: 16,
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 12,
    height: 244,
  },
  queryError: { marginHorizontal: 16, marginTop: 12 },
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
