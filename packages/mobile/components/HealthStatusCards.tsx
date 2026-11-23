import { formatComparisonContext } from "@dofek/format/baseline-context";
import { formatHealthStatusLabel } from "@dofek/format/health-status";
import { formatHealthProvenanceSource } from "@dofek/providers/health-provenance";
import { Ionicons } from "@expo/vector-icons";
import type { HealthStatusMetric } from "dofek-server/mobile-dashboard-contracts";
import { useState } from "react";
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
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

const compactRespiratoryUnit = " breaths/min";

function compactReading(metric: HealthStatusMetric, value: string) {
  if (metric.metric === "respiratory_rate" && value.endsWith(compactRespiratoryUnit)) {
    return (
      <>
        {value.slice(0, -compactRespiratoryUnit.length)}
        <Text style={styles.compactUnit}>{compactRespiratoryUnit}</Text>
      </>
    );
  }
  return value;
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
  const { fontScale } = useWindowDimensions();
  const stacked = fontScale > 1;

  if (metrics.length === 0) return null;

  return (
    <View style={compact ? styles.groupedContainer : styles.container}>
      {compact ? null : <Text style={styles.heading}>HEALTH STATUS</Text>}
      {metrics.map((metric) => {
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
              style={[styles.tile, stacked ? styles.tileStacked : styles.tileHalf]}
            >
              <View style={styles.tileCard}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${metric.label}, ${value}, ${interpretation}. ${expanded ? "Hide" : "Show"} details`}
                  aria-expanded={expanded}
                  onPress={toggle}
                  style={styles.tilePressable}
                >
                  <Text style={styles.tileLabel}>{metric.label}</Text>
                  <View style={styles.tileReadingRow}>
                    <Text style={styles.compactValue}>{compactReading(metric, value)}</Text>
                    <Ionicons
                      name={expanded ? "chevron-up" : "chevron-down"}
                      size={16}
                      color={colors.textTertiary}
                      accessible={false}
                    />
                  </View>
                  <Text
                    style={[
                      styles.status,
                      {
                        color:
                          metric.statusToken === "near_baseline"
                            ? colors.textTertiary
                            : statusColor(metric.statusColor),
                      },
                    ]}
                  >
                    {interpretation}
                  </Text>
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
    alignItems: "flex-start",
    flexDirection: "row",
    flexWrap: "wrap",
  },
  tile: {
    padding: spacing.xs,
  },
  tileHalf: {
    flexBasis: "50%",
    maxWidth: "50%",
  },
  tileStacked: {
    flexBasis: "100%",
    maxWidth: "100%",
  },
  tileCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.xl,
    borderWidth: 1,
    gap: spacing.xs,
  },
  tilePressable: {
    gap: spacing.xs,
    minHeight: 44,
    padding: spacing.sm,
  },
  tileReadingRow: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing.xs,
    justifyContent: "space-between",
  },
  rowFooter: {
    paddingBottom: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.xs,
  },
  compactValue: {
    color: colors.text,
    flexShrink: 1,
    fontSize: 20,
    fontVariant: ["tabular-nums"],
    fontWeight: "600",
    minWidth: 0,
  },
  compactUnit: {
    color: colors.textSecondary,
    fontSize: 11,
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
  tileLabel: {
    color: colors.textSecondary,
    flexShrink: 1,
    fontSize: 13,
    fontWeight: "600",
    lineHeight: 17,
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
