import { StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing } from "../theme";

type HealthMetricKey =
  | "hrv"
  | "resting_heart_rate"
  | "spo2"
  | "steps"
  | "skin_temperature"
  | "trend_weight"
  | "body_fat_percentage";

interface HealthStatusMetric {
  metric: HealthMetricKey;
  label: string;
  value: number | null;
  baseline: number | null;
  sampleDeviation: number | null;
  deviation: number | null;
  direction: "above" | "below" | "aligned" | "unknown";
  intent: "higher" | "lower" | "maintain" | "neutral";
  statusToken:
    | "insufficient_data"
    | "near_baseline"
    | "moving_as_intended"
    | "notable_deviation"
    | "far_from_baseline";
  statusColor: "positive" | "warning" | "danger" | "muted";
  statusLabel: string;
  explanation: string;
}

interface HealthStatusCardsProps {
  metrics: HealthStatusMetric[];
  formatValue?: (metric: HealthStatusMetric) => string;
}

function statusColor(status: HealthStatusMetric["statusColor"]): string {
  if (status === "positive") return colors.positive;
  if (status === "warning") return colors.warning;
  if (status === "danger") return colors.danger;
  return colors.textTertiary;
}

function defaultFormatValue(metric: HealthStatusMetric): string {
  if (metric.value == null) return "—";
  return Number.isInteger(metric.value) ? String(metric.value) : metric.value.toFixed(1);
}

export function HealthStatusCards({ metrics, formatValue }: HealthStatusCardsProps) {
  if (metrics.length === 0) return null;

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>HEALTH STATUS</Text>
      {metrics.map((metric) => (
        <View key={metric.metric} style={styles.card}>
          <View style={styles.titleRow}>
            <View
              style={[styles.statusDot, { backgroundColor: statusColor(metric.statusColor) }]}
            />
            <Text style={styles.label}>{metric.label}</Text>
          </View>
          <Text style={styles.value}>
            {formatValue ? formatValue(metric) : defaultFormatValue(metric)}
          </Text>
          <Text style={[styles.status, { color: statusColor(metric.statusColor) }]}>
            {metric.statusLabel}
          </Text>
          <Text style={styles.explanation}>{metric.explanation}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.sm,
  },
  heading: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.5,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.md,
    gap: spacing.xs,
  },
  titleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  statusDot: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  label: {
    color: colors.textSecondary,
    fontSize: 12,
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  value: {
    color: colors.text,
    fontSize: 24,
    fontVariant: ["tabular-nums"],
    fontWeight: "600",
  },
  status: {
    fontSize: 13,
    fontWeight: "600",
  },
  explanation: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
});
