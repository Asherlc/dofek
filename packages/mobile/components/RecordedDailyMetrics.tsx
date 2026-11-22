import {
  formatRecordedDailyMetric,
  GARMIN_INTERVALS_DISCLOSURE,
  type RecordedDailyMetricRow,
  recordedMetricsNeedGarminDisclosure,
} from "@dofek/format/recorded-daily-metrics";
import { providerSourceLabel } from "@dofek/providers/providers";
import { StyleSheet, Text, View } from "react-native";
import { useUnitConverter } from "../lib/units";
import { colors } from "../theme";

/** Provider-reported, date-only observations; the screen owns the query and its error state. */
export function RecordedDailyMetrics({
  rows,
}: {
  rows: readonly RecordedDailyMetricRow[] | undefined;
}) {
  const units = useUnitConverter();
  if (!rows || rows.length === 0) return null;

  return (
    <View style={styles.card} accessibilityLabel="Provider-reported observations">
      <Text accessibilityRole="header" style={styles.title}>
        Provider-reported
      </Text>
      {rows.map((row) => {
        const formatted = formatRecordedDailyMetric(row, units);
        return (
          <View key={`${row.date}:${row.metric}:${row.providerId}`} style={styles.row}>
            <Text style={styles.date}>{formatted.date}</Text>
            <Text style={styles.label}>{formatted.label}</Text>
            <Text style={styles.value}>{formatted.value}</Text>
            <Text style={styles.source}>{providerSourceLabel(row.providerId, row.sourceName)}</Text>
          </View>
        );
      })}
      {recordedMetricsNeedGarminDisclosure(rows) ? (
        <Text style={styles.disclosure}>{GARMIN_INTERVALS_DISCLOSURE}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: 16, padding: 16, gap: 8 },
  title: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 8 },
  date: { color: colors.textTertiary, fontSize: 12 },
  label: { color: colors.text, fontSize: 14, flexShrink: 1 },
  value: { color: colors.text, fontSize: 14, fontWeight: "600" },
  source: { color: colors.textTertiary, fontSize: 12 },
  disclosure: { color: colors.textTertiary, fontSize: 12 },
});
