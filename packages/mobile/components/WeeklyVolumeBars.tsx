import { formatNumber } from "@dofek/format/format";
import { StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";

export function WeeklyVolumeBars({
  weeks,
  unit,
}: {
  weeks: { week: string; value: number | null }[];
  unit: string;
}) {
  const max = weeks.reduce((maximum, row) => Math.max(maximum, row.value ?? 0), 0);
  return (
    <>
      {weeks.map((row) => (
        <View
          key={row.week}
          style={styles.row}
          accessibilityLabel={`${row.week}: ${row.value == null ? "Not recorded" : `${row.value} ${unit}`}`}
        >
          <Text style={styles.text}>{row.week}</Text>
          <View style={styles.track}>
            <View
              style={[styles.bar, { width: `${max === 0 ? 0 : ((row.value ?? 0) / max) * 100}%` }]}
            />
          </View>
          <Text style={styles.text}>{row.value == null ? "—" : formatNumber(row.value)}</Text>
        </View>
      ))}
    </>
  );
}
const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 },
  text: { color: colors.textSecondary },
  track: { flex: 1, height: 8, backgroundColor: colors.surfaceSecondary, borderRadius: 4 },
  bar: { height: 8, backgroundColor: colors.accent, borderRadius: 4 },
});
