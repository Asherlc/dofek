import { formatComparisonContext, formatComparisonPeriod } from "@dofek/format/baseline-context";
import { formatHealthStatusLabel } from "@dofek/format/health-status";
import {
  formatHealthProvenanceSource,
  formatHealthProvenanceSummary,
} from "@dofek/providers/health-provenance";
import type { HealthStatusMetric } from "dofek-server/mobile-dashboard-contracts";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
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
  const [expandedMetric, setExpandedMetric] = useState<HealthStatusMetric["metric"] | null>(null);

  if (metrics.length === 0) return null;

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>HEALTH STATUS</Text>
      {metrics.map((metric) => {
        const baseline = metric.baselineText;
        const provenance = metric.provenance;
        const expanded = expandedMetric === metric.metric;
        const blocked = metric.baselineProgress.blocker !== null;
        const interpretation = formatHealthStatusLabel(metric);
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
              {baseline == null ? interpretation : `baseline ${baseline} · ${interpretation}`}
            </Text>
            {blocked ? (
              <View
                accessibilityLabel={`${metric.label} baseline progress`}
                style={styles.progress}
              >
                <Text style={styles.rule}>{metric.evaluationRule}</Text>
                <Text style={styles.progressCount}>
                  {metric.baselineProgress.observedObservationDays} of{" "}
                  {metric.baselineProgress.requiredObservationDays} required days recorded
                </Text>
                <Text style={styles.action}>{metric.baselineProgress.action}</Text>
              </View>
            ) : null}
            {metric.comparison ? (
              <Text style={styles.provenance}>{formatComparisonPeriod(metric.comparison)}</Text>
            ) : null}
            <View style={styles.provenanceDisclosure}>
              {provenance ? (
                <Text style={styles.provenanceSummary}>
                  {formatHealthProvenanceSummary(provenance)}
                </Text>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${expanded ? "Hide" : "Show"} details for ${metric.label}`}
                aria-expanded={expanded}
                onPress={() => setExpandedMetric(expanded ? null : metric.metric)}
                style={styles.detailsButton}
              >
                <Text style={styles.provenanceAction}>{expanded ? "Hide details" : "Details"}</Text>
              </Pressable>
            </View>
            {expanded ? (
              <View style={styles.provenanceDetails}>
                {!blocked ? <Text style={styles.rule}>{metric.evaluationRule}</Text> : null}
                <Text style={styles.explanation}>{metric.explanation}</Text>
                {blocked ? (
                  <>
                    <Text style={styles.explanation}>{metric.baselineProgress.requirement}</Text>
                    <Text style={styles.explanation}>{metric.baselineProgress.summary}</Text>
                  </>
                ) : null}
                {metric.comparison ? (
                  <Text style={styles.provenance}>
                    {formatComparisonContext(metric.comparison, {
                      formatValue: (value) =>
                        formatComparisonValue?.(metric, value) ?? String(value),
                      missingMeans: "values",
                    })}
                  </Text>
                ) : null}
                {provenance ? (
                  <>
                    <Text style={styles.provenance}>
                      Source: {formatHealthProvenanceSource(provenance)}
                    </Text>
                    <Text style={styles.provenance}>
                      Latest recorded date: {provenance.latestDate ?? "Unavailable"}
                    </Text>
                    <Text style={styles.provenance}>
                      Coverage: {provenance.observedDays}/{provenance.windowDays} days
                    </Text>
                  </>
                ) : null}
              </View>
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
  provenanceDisclosure: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.xs,
    justifyContent: "space-between",
  },
  detailsButton: {
    justifyContent: "center",
    minHeight: 44,
    minWidth: 44,
  },
  provenanceSummary: {
    color: colors.textTertiary,
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
  },
  provenanceAction: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "600",
    lineHeight: 17,
  },
  provenanceDetails: {
    borderLeftColor: colors.surfaceSecondary,
    borderLeftWidth: 2,
    gap: spacing.xs,
    paddingLeft: spacing.sm,
  },
  progress: {
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  progressCount: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  action: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "600",
    lineHeight: 17,
  },
});
