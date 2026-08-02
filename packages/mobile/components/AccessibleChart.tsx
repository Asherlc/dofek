import { type ReactNode, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";

export interface AccessibleChartRow {
  label: string;
  value: string;
}

interface AccessibleChartProps {
  title: string;
  summary: string;
  rows: AccessibleChartRow[];
  children: ReactNode;
}

/**
 * Cross-platform chart alternative for exact values and assistive technology.
 * Design trade-offs are documented in docs/accessible-chart-justification.md.
 */
export function AccessibleChart({ title, summary, rows, children }: AccessibleChartProps) {
  const [expanded, setExpanded] = useState(false);
  const action = expanded ? "Hide" : "View";

  return (
    <View style={styles.container}>
      <View accessible accessibilityRole="image" accessibilityLabel={`${title}. ${summary}`}>
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {children}
        </View>
      </View>
      <Text style={styles.summary}>{summary}</Text>
      {rows.length > 0 && (
        <>
          <Pressable
            onPress={() => setExpanded((current) => !current)}
            accessibilityRole="button"
            accessibilityLabel={`${action} ${title} data`}
            accessibilityState={{ expanded }}
            style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
          >
            <Text style={styles.buttonText}>{action} chart data</Text>
          </Pressable>
          {expanded && (
            <View accessibilityRole="list" style={styles.list}>
              {rows.map((row) => (
                <View
                  key={`${row.label}-${row.value}`}
                  accessible
                  accessibilityLabel={`${row.label}: ${row.value}`}
                  style={styles.row}
                >
                  <Text style={styles.rowLabel}>{row.label}</Text>
                  <Text style={styles.rowValue}>{row.value}</Text>
                </View>
              ))}
            </View>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 8,
  },
  summary: {
    color: colors.textTertiary,
    fontSize: 12,
    lineHeight: 17,
  },
  button: {
    alignItems: "center",
    alignSelf: "flex-start",
    borderColor: colors.textTertiary,
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 12,
  },
  buttonPressed: {
    opacity: 0.7,
  },
  buttonText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
  },
  list: {
    borderColor: colors.surfaceSecondary,
    borderRadius: 8,
    borderWidth: 1,
  },
  row: {
    borderBottomColor: colors.surfaceSecondary,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 2,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  rowLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
  },
  rowValue: {
    color: colors.text,
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },
});
