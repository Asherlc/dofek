import { providerLabel } from "@dofek/providers/providers";
import type { HealthStatusMetric } from "dofek-server/mobile-dashboard-contracts";
import { StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing } from "../theme";

interface HealthStatusCardsProps {
  metrics: HealthStatusMetric[];
  formatValue?: (metric: HealthStatusMetric) => string;
  formatComparisonValue?: (metric: HealthStatusMetric, value: number) => string;
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

function displayValue(
  metric: HealthStatusMetric,
  formatValue: HealthStatusCardsProps["formatValue"],
): string {
  return metric.valueText ?? (formatValue ? formatValue(metric) : defaultFormatValue(metric));
}

function statusSymbol(status: HealthStatusMetric["statusToken"]): string {
  if (status === "insufficient_data") return "?";
  if (status === "near_baseline" || status === "moving_as_intended") return "✓";
  if (status === "notable_deviation") return "!";
  return "×";
}

export function HealthStatusCards({
  metrics,
  formatValue,
  formatComparisonValue,
}: HealthStatusCardsProps) {
  if (metrics.length === 0) return null;

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>HEALTH STATUS</Text>
      {metrics.map((metric) => {
        const baseline = metric.baselineText;
        return (
          <View key={metric.metric} style={styles.card}>
            <View style={styles.titleRow}>
              <Text
                accessibilityLabel={`${metric.statusLabel} status`}
                style={[styles.statusSymbol, { color: statusColor(metric.statusColor) }]}
              >
                {statusSymbol(metric.statusToken)}
              </Text>
              <Text
                adjustsFontSizeToFit
                minimumFontScale={0.75}
                numberOfLines={1}
                style={styles.label}
              >
                {metric.label}
              </Text>
            </View>
            <Text
              adjustsFontSizeToFit
              minimumFontScale={0.75}
              numberOfLines={1}
              style={styles.value}
            >
              {displayValue(metric, formatValue)}
            </Text>
            <Text style={[styles.status, { color: statusColor(metric.statusColor) }]}>
              {baseline == null
                ? metric.statusLabel
                : `baseline ${baseline} · ${metric.statusLabel}`}
            </Text>
            <Text style={styles.rule}>{metric.evaluationRule}</Text>
            <Text style={styles.explanation}>{metric.explanation}</Text>
            {metric.provenance ? (
              <Text style={styles.provenance}>
                Source:{" "}
                {metric.provenance.sourceProviders.map(providerLabel).join(", ") || "Unknown"} ·
                Latest: {metric.provenance.latestDate ?? "Unknown"} · Coverage:{" "}
                {metric.provenance.observedDays}/{metric.provenance.windowDays} days
              </Text>
            ) : null}
            {metric.comparison ? (
              <Text style={styles.provenance}>
                {metric.comparison.recentDays}d avg{" "}
                {metric.comparison.recentMean == null
                  ? "—"
                  : (formatComparisonValue?.(metric, metric.comparison.recentMean) ??
                    String(metric.comparison.recentMean))}{" "}
                vs prior {metric.comparison.baselineDays}d avg{" "}
                {metric.comparison.baselineMean == null
                  ? "—"
                  : (formatComparisonValue?.(metric, metric.comparison.baselineMean) ??
                    String(metric.comparison.baselineMean))}{" "}
                ·{" "}
                {metric.comparison.delta == null
                  ? "—"
                  : metric.comparison.delta > 0
                    ? `+${formatComparisonValue?.(metric, metric.comparison.delta) ?? metric.comparison.delta}`
                    : (formatComparisonValue?.(metric, metric.comparison.delta) ??
                      metric.comparison.delta)}
              </Text>
            ) : null}
          </View>
        );
      })}
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
  statusSymbol: {
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 16,
    textAlign: "center",
    width: 16,
  },
  label: {
    color: colors.textSecondary,
    flexShrink: 1,
    fontSize: 11,
    lineHeight: 14,
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
  rule: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
    lineHeight: 17,
  },
  explanation: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  provenance: {
    color: colors.textTertiary,
    fontSize: 12,
    lineHeight: 17,
  },
});
