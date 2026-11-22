import {
  formatPlannedIntervals,
  PLANNED_INTERVAL_MATCH_EXPLANATION,
  PLANNED_INTERVAL_MATCH_SUMMARY,
  type PlannedIntervalInput,
} from "@dofek/format/planned-interval";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../../theme";
import { chartStyles } from "./ActivityDetailCharts";

/** Planned versus recorded cycling intervals; renders nothing without eligible rows. */
export function PlannedIntervalComparison({ rows }: { rows: PlannedIntervalInput[] }) {
  const [matchOpen, setMatchOpen] = useState(false);
  if (rows.length === 0) return null;
  const items = formatPlannedIntervals(rows);
  const first = items[0];
  return (
    <View>
      <Text accessibilityRole="header" style={chartStyles.title}>
        Planned vs. recorded intervals
      </Text>
      <View style={styles.legend} accessibilityElementsHidden importantForAccessibility="no">
        <View style={styles.legendItem}>
          <View style={styles.legendBand} />
          <Text style={styles.secondary}>Planned power</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={styles.legendDot} />
          <Text style={styles.secondary}>Recorded average</Text>
        </View>
      </View>
      {first ? (
        <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          <View style={styles.axis}>
            <Text style={styles.secondary}>{first.scaleMinWatts} W</Text>
            <Text style={styles.secondary}>{first.scaleMaxWatts} W</Text>
          </View>
        </View>
      ) : null}
      {items.map((item) => (
        <View key={item.key} accessible accessibilityLabel={item.powerSummary} style={styles.row}>
          <Text style={styles.name}>{item.name}</Text>
          <View style={styles.scale} accessibilityElementsHidden importantForAccessibility="no">
            <View style={styles.line} />
            {item.isPoint ? (
              <View style={[styles.point, { left: `${item.targetStart}%` }]} />
            ) : (
              <View
                style={[
                  styles.target,
                  { left: `${item.targetStart}%`, width: `${item.targetWidth}%` },
                ]}
              />
            )}
            {item.actualPosition != null ? (
              <View style={[styles.actual, { left: `${item.actualPosition}%` }]} />
            ) : null}
          </View>
          <View style={styles.values}>
            <Text style={item.actualPosition == null ? styles.secondary : styles.recorded}>
              {item.recordedPower}
            </Text>
            <Text style={styles.secondary}>{item.plannedPower}</Text>
          </View>
          <Text style={styles.secondary}>Timer duration</Text>
          <View style={styles.values}>
            <Text style={styles.recorded}>{item.timer}</Text>
            <Text style={styles.secondary}>{item.timerDetail}</Text>
          </View>
        </View>
      ))}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: matchOpen }}
        onPress={() => setMatchOpen((open) => !open)}
        style={styles.disclosure}
      >
        <Text style={styles.secondary}>{PLANNED_INTERVAL_MATCH_SUMMARY}</Text>
      </Pressable>
      {matchOpen ? (
        <Text style={styles.secondary}>{PLANNED_INTERVAL_MATCH_EXPLANATION}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  legend: { flexDirection: "row", flexWrap: "wrap", gap: 16, marginTop: 4 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  legendBand: {
    width: 19,
    height: 10,
    borderRadius: 2,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.surfaceSecondary,
  },
  legendDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.text },
  point: {
    position: "absolute",
    top: 0,
    width: 2,
    height: 15,
    marginLeft: -1,
    backgroundColor: colors.accent,
  },
  disclosure: { minHeight: 44, justifyContent: "center" },
  axis: { flexDirection: "row", justifyContent: "space-between", marginTop: 4 },
  row: {
    gap: 6,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  name: { fontSize: 15, fontWeight: "600", color: colors.text },
  scale: { height: 15, marginHorizontal: 3 },
  line: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 7,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  target: {
    position: "absolute",
    top: 2,
    height: 11,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.surfaceSecondary,
  },
  actual: {
    position: "absolute",
    top: 2,
    width: 11,
    height: 11,
    marginLeft: -5.5,
    borderRadius: 6,
    backgroundColor: colors.text,
  },
  values: { flexDirection: "row", justifyContent: "space-between", flexWrap: "wrap", gap: 8 },
  recorded: { fontSize: 14, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] },
  secondary: { fontSize: 12, color: colors.textSecondary, fontVariant: ["tabular-nums"] },
});
