import { StyleSheet, Text, View } from "react-native";
import { ChartDescriptionTooltip } from "./ChartDescriptionTooltip";
import { SparkLine } from "./charts/SparkLine";
import { colors } from "../theme";

interface MetricCardProps {
  title: string;
  value: string;
  unit?: string;
  /** Trend data for sparkline */
  trend?: number[];
  /** Color of the value and sparkline */
  color?: string;
  /** Subtitle/context text */
  subtitle?: string;
  /** Trend direction indicator */
  trendDirection?: "up" | "down" | "stable";
  /** Optional chart description for the sparkline tooltip */
  chartDescription?: string;
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
}: MetricCardProps) {
  const hasTrendChart = Boolean(trend && trend.length >= 2);
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
            <Text
              style={[
                styles.trendArrow,
                {
                  color:
                    trendDirection === "up"
                      ? colors.positive
                      : trendDirection === "down"
                        ? colors.danger
                        : colors.textSecondary,
                },
              ]}
            >
              {trendArrow(trendDirection)}
            </Text>
          )}
        </View>
        {trend && trend.length >= 2 && (
          <SparkLine data={trend} color={color} width={100} height={36} />
        )}
      </View>
      {subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
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
});
