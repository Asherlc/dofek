import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { colors } from "../theme";
import { ChartDescriptionTooltip } from "./ChartDescriptionTooltip";
import { SparkLine } from "./charts/SparkLine";

interface MetricCardProps {
  title: string;
  value: string;
  unit?: string;
  /** Trend data for sparkline (null values create visible gaps) */
  trend?: (number | null)[];
  /** Color of the value and sparkline */
  color?: string;
  /** Subtitle/context text */
  subtitle?: string;
  /** Trend direction indicator */
  trendDirection?: "up" | "down" | "stable";
  /** Optional chart description for the sparkline tooltip */
  chartDescription?: string;
  /** Opens the records or source evidence contributing to this value */
  onViewData?: () => void;
}

function trendArrow(direction: "up" | "down" | "stable"): string {
  if (direction === "up") return "\u2191";
  if (direction === "down") return "\u2193";
  return "\u2192";
}

export function MetricCard({
  title,
  value,
  unit,
  trend,
  color = colors.text,
  subtitle,
  trendDirection,
  chartDescription,
  onViewData,
}: MetricCardProps) {
  const nonNullCount = trend ? trend.filter((v) => v != null).length : 0;
  const hasTrendChart = nonNullCount >= 2;
  const description =
    chartDescription ?? `This chart shows the recent trend for ${title.toLowerCase()}.`;

  return (
    <View style={styles.card}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>{title}</Text>
        {hasTrendChart && <ChartDescriptionTooltip title={title} description={description} />}
      </View>
      <View style={styles.row}>
        <View style={styles.valueContainer}>
          <Text style={[styles.value, { color }]}>{value}</Text>
          {unit && <Text style={styles.unit}>{unit}</Text>}
          {trendDirection && (
            <Text testID="trend-arrow" style={[styles.trendArrow, { color }]}>
              {trendArrow(trendDirection)}
            </Text>
          )}
        </View>
        {trend && trend.length >= 2 && (
          <View style={styles.sparklineContainer}>
            <SparkLine data={trend} color={color} height={36} />
          </View>
        )}
      </View>
      {subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
      {onViewData ? (
        <TouchableOpacity
          accessibilityLabel={`View data for ${title}`}
          accessibilityRole="button"
          activeOpacity={0.7}
          onPress={onViewData}
          style={styles.dataAction}
        >
          <Text style={styles.dataActionText}>View data</Text>
          <Text accessibilityElementsHidden style={styles.dataActionArrow}>
            ›
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    gap: 8,
  },
  title: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  valueContainer: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 4,
  },
  sparklineContainer: {
    flex: 1,
    height: 36,
    marginLeft: 16,
    alignItems: "flex-end",
  },
  value: {
    fontSize: 28,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  unit: {
    fontSize: 14,
    color: colors.textSecondary,
    fontWeight: "500",
  },
  trendArrow: {
    fontSize: 18,
    fontWeight: "700",
    marginLeft: 4,
  },
  subtitle: {
    fontSize: 12,
    color: colors.textTertiary,
  },
  dataAction: {
    alignItems: "center",
    alignSelf: "flex-start",
    flexDirection: "row",
    minHeight: 44,
  },
  dataActionText: {
    color: colors.blue,
    fontSize: 13,
    fontWeight: "600",
  },
  dataActionArrow: {
    color: colors.blue,
    fontSize: 18,
    marginLeft: 4,
  },
});
