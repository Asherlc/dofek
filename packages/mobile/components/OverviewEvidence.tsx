import { formatDateShort, shiftDateYmd } from "@dofek/format/format";
import type { UnitConverter } from "@dofek/format/units";
import { isConnectionFailure } from "@dofek/format/user-facing-error";
import type { AppRouterOutputs } from "dofek-server/router";
import { type ReactNode, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Line } from "react-native-svg";
import {
  formatHealthCardComparison,
  formatHealthCardComparisonDelta,
  formatHealthCardValue,
} from "../lib/health-status-format";
import { colors, fonts, radius, spacing } from "../theme";
import { SparkLine } from "./charts/SparkLine";
import { HealthStatusCards } from "./HealthStatusCards";
import { getQueryErrorMessage, QueryStatePanel } from "./QueryStatePanel";

export const overviewDays = 90;
type Insight = Pick<
  AppRouterOutputs["insights"]["compute"][number],
  | "confidence"
  | "type"
  | "effectSize"
  | "action"
  | "metric"
  | "message"
  | "detail"
  | "dataPoints"
  | "evidence"
>;
type Trends = Pick<
  NonNullable<AppRouterOutputs["dailyMetrics"]["trends"]>,
  "latest_resting_hr" | "restingHeartRateTrendLabel" | "healthStatus"
> | null;
type HeartRate = Pick<
  AppRouterOutputs["dailyMetrics"]["hrvBaseline"][number],
  "resting_hr" | "resting_hr_mean_7d"
>[];

interface QueryResult<Data> {
  data?: Data;
  isLoading: boolean;
  isPaused?: boolean;
  error?: unknown;
}

interface OverviewEvidenceProps {
  endDate: string;
  insights: QueryResult<Insight[]>;
  trends: QueryResult<Trends>;
  heartRate: QueryResult<HeartRate>;
  units: UnitConverter;
  hideConnectionErrors?: boolean;
  openHeartRate: () => void;
  openBody: () => void;
  openCorrelation: () => void;
}

function LinkButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={styles.link}
    >
      <Text style={styles.linkText}>{label} →</Text>
    </Pressable>
  );
}

function isGroupedNoData(hideConnectionErrors: boolean, query: QueryResult<unknown>): boolean {
  return hideConnectionErrors && query.data == null && isConnectionFailure(query.error);
}

function renderSectionState({
  query,
  empty,
  hideConnectionError = false,
}: {
  query: QueryResult<unknown>;
  empty?: string;
  hideConnectionError?: boolean;
}): ReactNode {
  if (query.error) {
    if (hideConnectionError && isConnectionFailure(query.error)) return null;
    return (
      <QueryStatePanel variant="error" message={getQueryErrorMessage(query.error)} minHeight={62} />
    );
  }
  if (query.isLoading && query.data == null) {
    return <QueryStatePanel variant="loading" minHeight={62} />;
  }
  if (query.isPaused && query.data === undefined) {
    return <QueryStatePanel variant="empty" message="Waiting for a connection" minHeight={62} />;
  }
  return empty ? <QueryStatePanel variant="empty" message={empty} minHeight={62} /> : null;
}

function InsightScatter({ insight }: { insight: Insight }) {
  const points =
    insight.dataPoints?.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)) ??
    [];
  if (points.length < 2) return null;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const xMin = Math.min(...xs);
  const yMin = Math.min(...ys);
  const xSpan = Math.max(...xs) - xMin || 1;
  const ySpan = Math.max(...ys) - yMin || 1;
  return (
    <View
      style={styles.figure}
      accessible
      accessibilityLabel={`Scatter plot of ${insight.action} and ${insight.metric}`}
    >
      <Text style={styles.description}>{insight.metric}</Text>
      <Svg viewBox="0 0 128 53" width="100%" height={53}>
        <Line x1={5} x2={5} y1={4} y2={49} stroke={colors.border} />
        <Line x1={5} x2={124} y1={49} y2={49} stroke={colors.border} />
        {points.map((point) => (
          <Circle
            key={`${point.date}-${point.x}-${point.y}`}
            cx={8 + ((point.x - xMin) / xSpan) * 113}
            cy={46 - ((point.y - yMin) / ySpan) * 40}
            r={2.5}
            fill={colors.accent}
          />
        ))}
      </Svg>
      <Text style={styles.description}>{insight.action}</Text>
    </View>
  );
}

export function OverviewEvidence({
  endDate,
  insights,
  trends,
  heartRate,
  units,
  hideConnectionErrors = false,
  openHeartRate,
  openBody,
  openCorrelation,
}: OverviewEvidenceProps) {
  const [calculationOpen, setCalculationOpen] = useState(false);
  const topInsight = insights.data
    ?.filter((insight) => insight.confidence !== "insufficient")
    .sort((first, second) => Math.abs(second.effectSize) - Math.abs(first.effectSize))[0];
  const association =
    topInsight?.evidence?.relationship === "descriptive_association" ||
    topInsight?.type === "conditional";
  const heartRateTrend = (heartRate.data ?? []).map((row) =>
    row.resting_hr == null ? null : row.resting_hr_mean_7d,
  );
  const hasTrend = heartRateTrend.filter((value) => value != null).length > 1;
  const latest = trends.data?.latest_resting_hr;
  const healthStatus = trends.data?.healthStatus ?? [];
  const baselineProgress = healthStatus.find(
    (metric) => metric.metric === "resting_heart_rate",
  )?.baselineProgress;
  const startDate = shiftDateYmd(endDate, 1 - overviewDays);
  const dateOptions = { timeZone: "UTC" };
  const insightStatus = renderSectionState({
    query: insights,
    hideConnectionError: hideConnectionErrors,
  });
  // A distinct heart rate failure still owns the trend card even when the
  // grouped trend query has no data — keep the card so its error stays visible.
  const hasDistinctHeartRateError =
    heartRate.error != null && !isConnectionFailure(heartRate.error);
  const hideTrendCard =
    isGroupedNoData(hideConnectionErrors, trends) &&
    heartRate.data == null &&
    !hasDistinctHeartRateError;
  const hideHealthMonitor = isGroupedNoData(hideConnectionErrors, trends);
  return (
    <View style={styles.content}>
      <Text style={styles.date}>
        {formatDateShort(startDate, dateOptions)} – {formatDateShort(endDate, dateOptions)}
      </Text>
      {topInsight || insightStatus ? (
        <View style={styles.card}>
          <Text style={styles.eyebrow}>{association ? "Key association" : "Key correlation"}</Text>
          {topInsight ? (
            <>
              <Text style={styles.title} accessibilityRole="header">
                {topInsight.message}
              </Text>
              <View style={styles.split}>
                <View style={styles.readout}>
                  <Text style={styles.value}>
                    {association
                      ? (topInsight.evidence?.estimateLabel ?? "—")
                      : topInsight.effectSize.toFixed(2)}
                  </Text>
                  <Text style={styles.description}>
                    {topInsight.evidence?.label ??
                      (association ? "Descriptive association" : "Descriptive correlation")}
                  </Text>
                </View>
                <InsightScatter insight={topInsight} />
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: calculationOpen }}
                onPress={() => setCalculationOpen((open) => !open)}
                style={styles.link}
              >
                <Text style={styles.linkText}>
                  Calculation details {calculationOpen ? "⌃" : "⌄"}
                </Text>
              </Pressable>
              {calculationOpen ? (
                <>
                  <Text style={styles.description}>
                    {topInsight.evidence?.method ?? topInsight.detail}
                  </Text>
                  <LinkButton label="Open Correlation" onPress={openCorrelation} />
                </>
              ) : null}
            </>
          ) : null}
          {insightStatus}
        </View>
      ) : null}
      {hideTrendCard ? null : (
        <View style={styles.card}>
          <Text style={styles.eyebrow}>Recent trend</Text>
          <Text style={styles.title} accessibilityRole="header">
            Resting heart rate
          </Text>
          <View style={styles.split}>
            <View style={styles.readout}>
              <Text style={styles.value}>{latest == null ? "—" : Math.round(latest)}</Text>
              <Text style={styles.description}>bpm</Text>
              <Text style={styles.description}>
                {trends.data?.restingHeartRateTrendLabel ?? "Waiting for baseline"}
              </Text>
            </View>
            <View style={styles.figure}>
              <Text style={styles.description}>7-day average</Text>
              {hasTrend ? (
                <SparkLine data={heartRateTrend} height={51} color={colors.accent} />
              ) : (
                renderSectionState({
                  query: heartRate,
                  empty: "No trend available",
                  hideConnectionError: hideConnectionErrors,
                })
              )}
            </View>
          </View>
          {hasTrend
            ? renderSectionState({
                query: heartRate,
                hideConnectionError: hideConnectionErrors,
              })
            : null}
          <LinkButton label="View heart rate data" onPress={openHeartRate} />
          {baselineProgress && baselineProgress.blocker !== null ? (
            <View style={styles.baseline}>
              <Text style={styles.description}>{baselineProgress.requirement}</Text>
              <Text style={styles.description}>{baselineProgress.summary}</Text>
              {baselineProgress.blocker !== "syncing" ? (
                <Text style={styles.description}>{baselineProgress.action}</Text>
              ) : null}
            </View>
          ) : null}
        </View>
      )}
      {hideHealthMonitor ? null : (
        <>
          <View style={styles.monitorHeading}>
            <Text style={styles.title} accessibilityRole="header">
              Health monitor
            </Text>
            <LinkButton label="View Body" onPress={openBody} />
          </View>
          {healthStatus.length > 0 ? (
            <HealthStatusCards
              compact
              metrics={healthStatus}
              formatValue={(metric) => formatHealthCardValue(metric, units)}
              formatComparisonValue={(metric, value) =>
                formatHealthCardComparison(metric, value, units)
              }
              formatComparisonDelta={(metric, value) =>
                formatHealthCardComparisonDelta(metric, value, units)
              }
            />
          ) : null}
          {renderSectionState({
            query: trends,
            empty: healthStatus.length === 0 ? "No health measurements to display" : undefined,
            hideConnectionError: hideConnectionErrors,
          })}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing.sm },
  date: { color: colors.textSecondary, fontSize: 14, marginBottom: spacing.xs },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.xs,
  },
  eyebrow: {
    color: colors.textSecondary,
    fontSize: 11,
    letterSpacing: 1.3,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  title: { color: colors.text, fontSize: 17, fontWeight: "700" },
  description: { color: colors.textSecondary, fontSize: 12 },
  value: { color: colors.accent, fontFamily: fonts.mono, fontSize: 27, fontWeight: "700" },
  split: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
    marginVertical: spacing.xs,
  },
  readout: { flex: 1, gap: spacing.xs },
  figure: { flex: 1, minWidth: 100 },
  link: { minHeight: 44, justifyContent: "center", alignSelf: "flex-start" },
  linkText: { color: colors.accent, fontSize: 14, fontWeight: "700" },
  monitorHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  baseline: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.sm,
    gap: spacing.xs,
  },
});
