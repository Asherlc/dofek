import { formatComparisonContext } from "@dofek/format/baseline-context";
import { formatHealthStatusLabel } from "@dofek/format/health-status";
import { formatHealthProvenanceSource } from "@dofek/providers/health-provenance";
import { Ionicons } from "@expo/vector-icons";
import type { HealthStatusMetric } from "dofek-server/mobile-dashboard-contracts";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing } from "../theme";

interface HealthStatusCardsProps {
  metrics: HealthStatusMetric[];
  compact?: boolean;
  formatValue?: (metric: HealthStatusMetric) => string;
  formatComparisonValue?: (metric: HealthStatusMetric, value: number) => string;
  formatComparisonDelta?: (metric: HealthStatusMetric, value: number) => string;
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

function expandedDetails(
  metric: HealthStatusMetric,
  baseline: string | null | undefined,
  blocked: boolean,
  formatComparisonValue: HealthStatusCardsProps["formatComparisonValue"],
  formatComparisonDelta: HealthStatusCardsProps["formatComparisonDelta"],
  grouped: boolean,
) {
  const provenance = metric.provenance;
  return (
    <View style={styles.provenanceDetails}>
      {grouped && baseline != null ? (
        <Text style={styles.provenance}>Baseline: {baseline}</Text>
      ) : null}
      {!blocked || grouped ? <Text style={styles.rule}>{metric.evaluationRule}</Text> : null}
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
            formatValue: (value) => formatComparisonValue?.(metric, value) ?? String(value),
            formatDelta: formatComparisonDelta
              ? (value) => formatComparisonDelta(metric, value)
              : undefined,
            missingMeans: "values",
          })}
        </Text>
      ) : null}
      {provenance ? (
        <>
          <Text style={styles.provenance}>Source: {formatHealthProvenanceSource(provenance)}</Text>
          <Text style={styles.provenance}>
            Latest recorded date: {provenance.latestDate ?? "Unavailable"}
          </Text>
          <Text style={styles.provenance}>
            Coverage: {provenance.observedDays}/{provenance.windowDays} days
          </Text>
        </>
      ) : null}
    </View>
  );
}

export function HealthStatusCards({
  metrics,
  compact = false,
  formatValue,
  formatComparisonValue,
  formatComparisonDelta,
}: HealthStatusCardsProps) {
  const [expandedMetric, setExpandedMetric] = useState<HealthStatusMetric["metric"] | null>(null);

  if (metrics.length === 0) return null;

  return (
    <View style={compact ? styles.groupedContainer : styles.container}>
      {compact ? null : <Text style={styles.heading}>HEALTH STATUS</Text>}
      {metrics.map((metric, index) => {
        const baseline = metric.baselineText;
        const expanded = expandedMetric === metric.metric;
        const blocked = metric.baselineProgress.blocker !== null;
        const interpretation = formatHealthStatusLabel(metric);
        const value = displayValue(metric, formatValue);
        const toggle = () => setExpandedMetric(expanded ? null : metric.metric);

        if (compact) {
          return (
            <View
              key={metric.metric}
              style={[styles.groupedRow, index > 0 ? styles.rowDivider : null]}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${metric.label}, ${value}, ${interpretation}. ${expanded ? "Hide" : "Show"} details`}
                aria-expanded={expanded}
                onPress={toggle}
                style={styles.rowPressable}
              >
                <View style={styles.rowLeading}>
                  <Text style={styles.label}>{metric.label}</Text>
                  <Text style={[styles.status, { color: statusColor(metric.statusColor) }]}>
                    {interpretation}
                  </Text>
                </View>
                <View style={styles.rowTrailing}>
                  <Text style={styles.compactValue}>{value}</Text>
                  <Ionicons
                    name={expanded ? "chevron-up" : "chevron-down"}
                    size={16}
                    color={colors.textTertiary}
                    accessible={false}
                  />
                </View>
              </Pressable>
              {blocked || expanded ? (
                <View style={styles.rowFooter}>
                  {blocked ? (
                    <View
                      accessibilityLabel={`${metric.label} baseline progress`}
                      style={styles.progress}
                    >
                      {metric.baselineProgress.blocker !== "syncing" ? (
                        <Text style={styles.action}>{metric.baselineProgress.action}</Text>
                      ) : null}
                    </View>
                  ) : null}
                  {expanded
                    ? expandedDetails(
                        metric,
                        baseline,
                        blocked,
                        formatComparisonValue,
                        formatComparisonDelta,
                        true,
                      )
                    : null}
                </View>
              ) : null}
            </View>
          );
        }

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
              {value}
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
                {metric.baselineProgress.blocker !== "syncing" ? (
                  <Text style={styles.action}>{metric.baselineProgress.action}</Text>
                ) : null}
              </View>
            ) : null}
            <View style={styles.provenanceDisclosure}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${expanded ? "Hide" : "Show"} details for ${metric.label}`}
                aria-expanded={expanded}
                onPress={toggle}
                style={styles.detailsButton}
              >
                <Text style={styles.provenanceAction}>{expanded ? "Hide details" : "Details"}</Text>
              </Pressable>
            </View>
            {expanded
              ? expandedDetails(
                  metric,
                  baseline,
                  blocked,
                  formatComparisonValue,
                  formatComparisonDelta,
                  false,
                )
              : null}
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
  groupedContainer: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    overflow: "hidden",
  },
  groupedRow: {
    paddingHorizontal: spacing.md,
  },
  rowDivider: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  rowPressable: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    justifyContent: "space-between",
    minHeight: 56,
    paddingVertical: spacing.sm,
  },
  rowFooter: {
    paddingBottom: spacing.sm,
  },
  rowLeading: {
    flexShrink: 1,
    gap: spacing.xs,
  },
  rowTrailing: {
    alignItems: "center",
    flexDirection: "row",
    flexShrink: 1,
    gap: spacing.sm,
  },
  compactValue: {
    color: colors.text,
    flexShrink: 1,
    fontSize: 18,
    fontVariant: ["tabular-nums"],
    fontWeight: "600",
    textAlign: "right",
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
  action: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "600",
    lineHeight: 17,
  },
});
