import { formatNumber, formatSigned } from "@dofek/format/format";
import { statusColors } from "@dofek/scoring/colors";
import { useMemo, useState } from "react";
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import Svg, { Circle, Line } from "react-native-svg";
import { ChartTitleWithTooltip } from "../components/ChartTitleWithTooltip";
import { trpc } from "../lib/trpc";
import { useRefresh } from "../lib/useRefresh";
import { colors } from "../theme";

// ── Constants ──

const DAY_OPTIONS = [
  { label: "90d", value: 90 },
  { label: "180d", value: 180 },
  { label: "1y", value: 365 },
];

const LAG_OPTIONS = [
  { label: "Same day", value: 0 },
  { label: "+1 day", value: 1 },
  { label: "+2 days", value: 2 },
  { label: "+3 days", value: 3 },
];

const DOMAIN_ORDER = ["Recovery", "Sleep", "Nutrition", "Activity", "Body"];

const CONFIDENCE_COLORS: Record<string, string> = {
  strong: statusColors.positive,
  emerging: statusColors.warning,
  early: "#636366",
  insufficient: "#636366",
};

// ── Selector Components ──

function DaySelector({ days, onChange }: { days: number; onChange: (d: number) => void }) {
  return (
    <View style={styles.selectorRow}>
      {DAY_OPTIONS.map((opt) => (
        <TouchableOpacity
          key={opt.value}
          style={[styles.selectorButton, days === opt.value && styles.selectorButtonActive]}
          onPress={() => onChange(opt.value)}
          activeOpacity={0.7}
        >
          <Text style={[styles.selectorText, days === opt.value && styles.selectorTextActive]}>
            {opt.label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function LagSelector({ lag, onChange }: { lag: number; onChange: (l: number) => void }) {
  return (
    <View style={styles.selectorRow}>
      {LAG_OPTIONS.map((opt) => (
        <TouchableOpacity
          key={opt.value}
          style={[styles.selectorButton, lag === opt.value && styles.selectorButtonActive]}
          onPress={() => onChange(opt.value)}
          activeOpacity={0.7}
        >
          <Text style={[styles.selectorText, lag === opt.value && styles.selectorTextActive]}>
            {opt.label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ── Metric Picker ──

interface MetricItem {
  id: string;
  label: string;
  unit: string;
  domain: string;
}

function MetricPicker({
  label,
  selected,
  metrics,
  onSelect,
}: {
  label: string;
  selected: string;
  metrics: MetricItem[];
  onSelect: (id: string) => void;
}) {
  const grouped = useMemo(() => {
    const groups: Record<string, MetricItem[]> = {};
    for (const m of metrics) {
      const domain = m.domain.charAt(0).toUpperCase() + m.domain.slice(1);
      if (!groups[domain]) groups[domain] = [];
      groups[domain].push(m);
    }
    return DOMAIN_ORDER.filter((d) => groups[d]?.length).map((d) => ({
      domain: d,
      items: groups[d] ?? [],
    }));
  }, [metrics]);

  return (
    <View style={styles.pickerContainer}>
      <Text style={styles.pickerLabel}>{label}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroller}>
        {grouped.map(({ domain, items }) => (
          <View key={domain} style={styles.chipGroup}>
            <Text style={styles.chipGroupLabel}>{domain}</Text>
            <View style={styles.chipRow}>
              {items.map((m) => (
                <TouchableOpacity
                  key={m.id}
                  style={[styles.chip, selected === m.id && styles.chipActive]}
                  onPress={() => onSelect(m.id)}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.chipText, selected === m.id && styles.chipTextActive]}>
                    {m.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

// ── Correlation Bar ──

function CorrelationBar({ rho, label }: { rho: number; label: string }) {
  const clamped = Math.max(-1, Math.min(1, rho));
  const fillPct = Math.abs(clamped) * 50;
  const isPositive = clamped >= 0;
  const barColor = isPositive ? statusColors.positive : statusColors.danger;

  return (
    <View style={styles.corrBarContainer}>
      <Text style={styles.corrBarLabel}>{label}</Text>
      <View style={styles.corrBarTrack}>
        <View style={styles.corrBarCenter} />
        <View
          style={[
            styles.corrBarFill,
            {
              backgroundColor: barColor,
              width: `${fillPct}%`,
              ...(isPositive ? { left: "50%" } : { right: "50%" }),
            },
          ]}
        />
      </View>
      <Text style={[styles.corrBarValue, { color: barColor }]}>{formatSigned(clamped, 2)}</Text>
    </View>
  );
}

// ── Scatter Plot ──

function ScatterPlot({
  dataPoints,
  regression,
  rho,
  xLabel,
  yLabel: _yLabel,
  width: chartWidth,
}: {
  dataPoints: Array<{ x: number; y: number; date: string }>;
  regression: { slope: number; intercept: number; rSquared: number };
  rho: number;
  xLabel: string;
  yLabel: string;
  width: number;
}) {
  const padding = { top: 16, right: 16, bottom: 32, left: 48 };
  const plotWidth = chartWidth - padding.left - padding.right;
  const plotHeight = 240;

  const xs = dataPoints.map((p) => p.x);
  const ys = dataPoints.map((p) => p.y);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;

  const scaleX = (v: number) => padding.left + ((v - xMin) / xRange) * plotWidth;
  const scaleY = (v: number) => padding.top + plotHeight - ((v - yMin) / yRange) * plotHeight;

  const trendColor = rho >= 0 ? statusColors.positive : statusColors.danger;
  const lineY1 = regression.slope * xMin + regression.intercept;
  const lineY2 = regression.slope * xMax + regression.intercept;

  return (
    <View style={styles.chartContainer}>
      <Svg width={chartWidth} height={plotHeight + padding.top + padding.bottom}>
        {/* Grid lines */}
        <Line
          x1={padding.left}
          y1={padding.top}
          x2={padding.left}
          y2={padding.top + plotHeight}
          stroke="#27272a"
          strokeWidth={1}
        />
        <Line
          x1={padding.left}
          y1={padding.top + plotHeight}
          x2={padding.left + plotWidth}
          y2={padding.top + plotHeight}
          stroke="#27272a"
          strokeWidth={1}
        />

        {/* Regression line */}
        <Line
          x1={scaleX(xMin)}
          y1={scaleY(lineY1)}
          x2={scaleX(xMax)}
          y2={scaleY(lineY2)}
          stroke={trendColor}
          strokeWidth={2}
          strokeDasharray="6,4"
          opacity={0.7}
        />

        {/* Data points */}
        {dataPoints.map((p) => (
          <Circle
            key={`${p.date}-${p.x}-${p.y}`}
            cx={scaleX(p.x)}
            cy={scaleY(p.y)}
            r={3}
            fill="#a1a1aa"
            opacity={0.5}
          />
        ))}
      </Svg>
      <View style={styles.axisLabels}>
        <Text style={styles.axisLabel}>{xLabel}</Text>
      </View>
    </View>
  );
}

// ── Main Screen ──

export default function CorrelationScreen() {
  const [days, setDays] = useState(365);
  const [metricX, setMetricX] = useState("protein");
  const [metricY, setMetricY] = useState("hrv");
  const [lag, setLag] = useState(0);
  const { width } = useWindowDimensions();
  const isWide = width >= 600;

  const metricsQuery = trpc.correlation.metrics.useQuery({});
  const correlationQuery = trpc.correlation.compute.useQuery(
    { metricX, metricY, days, lag },
    { enabled: metricX !== metricY },
  );

  const data = correlationQuery.data;
  const metrics = metricsQuery.data ?? [];
  const xMetric = metrics.find((m) => m.id === metricX);
  const yMetric = metrics.find((m) => m.id === metricY);

  const { refreshing, onRefresh } = useRefresh();

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, isWide && styles.contentWide]}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.textSecondary}
        />
      }
    >
      {/* Time range */}
      <Text style={styles.sectionLabel}>Time Range</Text>
      <DaySelector days={days} onChange={setDays} />

      {/* Metric pickers */}
      {metrics.length > 0 && (
        <>
          <MetricPicker label="X Axis" selected={metricX} metrics={metrics} onSelect={setMetricX} />
          <MetricPicker label="Y Axis" selected={metricY} metrics={metrics} onSelect={setMetricY} />
        </>
      )}

      {/* Lag selector */}
      <Text style={styles.sectionLabel}>Lag</Text>
      <LagSelector lag={lag} onChange={setLag} />
      <Text style={styles.lagHint}>
        {lag > 0
          ? `How ${xMetric?.label ?? "X"} today relates to ${yMetric?.label ?? "Y"} ${lag === 1 ? "tomorrow" : `${lag} days later`}`
          : "Same-day comparison"}
      </Text>

      {/* Same metric warning */}
      {metricX === metricY && (
        <View style={styles.warningCard}>
          <Text style={styles.warningText}>Select two different metrics to compare.</Text>
        </View>
      )}

      {/* Loading */}
      {correlationQuery.isLoading && metricX !== metricY && (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>Analyzing...</Text>
        </View>
      )}

      {/* Results */}
      {data && metricX !== metricY && (
        <>
          {/* Correlation strength card */}
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <ChartTitleWithTooltip
                title="Correlation Strength"
                description="These bars show how strongly the two selected metrics move together."
                textStyle={styles.cardTitle}
              />
              <View
                style={[
                  styles.confidenceBadge,
                  { backgroundColor: `${CONFIDENCE_COLORS[data.confidenceLevel] ?? "#636366"}22` },
                ]}
              >
                <Text
                  style={[
                    styles.confidenceBadgeText,
                    { color: CONFIDENCE_COLORS[data.confidenceLevel] ?? "#636366" },
                  ]}
                >
                  {data.confidenceLevel}
                </Text>
              </View>
            </View>

            <CorrelationBar rho={data.spearmanRho} label="Spearman" />
            <CorrelationBar rho={data.pearsonR} label="Pearson" />

            <View style={styles.statsRow}>
              <Text style={styles.statText}>R² = {formatNumber(data.regression.rSquared, 3)}</Text>
              <Text style={styles.statText}>n = {data.sampleCount}</Text>
              <Text style={styles.statText}>
                p = {data.spearmanPValue < 0.001 ? "< 0.001" : formatNumber(data.spearmanPValue, 3)}
              </Text>
            </View>
          </View>

          {/* Insight card */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Finding</Text>
            <Text style={styles.insightText}>{data.insight}</Text>

            {data.sampleCount > 0 && (
              <View style={styles.statsGrid}>
                <View style={styles.statsGridItem}>
                  <Text style={styles.statsGridLabel}>{xMetric?.label ?? metricX}</Text>
                  <Text style={styles.statsGridValue}>
                    {formatNumber(data.xStats.mean)} ± {formatNumber(data.xStats.stddev)}{" "}
                    {xMetric?.unit}
                  </Text>
                </View>
                <View style={styles.statsGridItem}>
                  <Text style={styles.statsGridLabel}>{yMetric?.label ?? metricY}</Text>
                  <Text style={styles.statsGridValue}>
                    {formatNumber(data.yStats.mean)} ± {formatNumber(data.yStats.stddev)}{" "}
                    {yMetric?.unit}
                  </Text>
                </View>
              </View>
            )}
          </View>

          {/* Scatter plot */}
          {data.dataPoints.length > 0 && (
            <View style={styles.card}>
              <ChartTitleWithTooltip
                title="Scatter Plot"
                description="This chart plots each data point and a trend line to visualize how the two metrics relate."
                textStyle={styles.cardTitle}
              />
              <ScatterPlot
                dataPoints={data.dataPoints}
                regression={data.regression}
                rho={data.spearmanRho}
                xLabel={`${xMetric?.label ?? metricX} (${xMetric?.unit ?? ""})`}
                yLabel={`${yMetric?.label ?? metricY} (${yMetric?.unit ?? ""})`}
                width={isWide ? 660 : width - 48}
              />
            </View>
          )}
        </>
      )}

      {/* Disclaimer */}
      <Text style={styles.disclaimer}>
        Correlation does not imply causation. These are observational patterns in your data.
      </Text>
    </ScrollView>
  );
}

// ── Styles ──

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: 16,
    paddingBottom: 100,
    gap: 12,
  },
  contentWide: {
    maxWidth: 700,
    alignSelf: "center",
    width: "100%",
  },

  sectionLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },

  // Selectors
  selectorRow: {
    flexDirection: "row",
    gap: 6,
  },
  selectorButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: colors.surface,
  },
  selectorButtonActive: {
    backgroundColor: colors.surfaceSecondary,
  },
  selectorText: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  selectorTextActive: {
    color: colors.text,
    fontWeight: "600",
  },

  // Metric picker
  pickerContainer: {
    gap: 6,
  },
  pickerLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  chipScroller: {
    flexGrow: 0,
  },
  chipGroup: {
    marginRight: 16,
    gap: 4,
  },
  chipGroupLabel: {
    fontSize: 10,
    color: colors.textTertiary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: colors.surface,
  },
  chipActive: {
    backgroundColor: colors.accent,
  },
  chipText: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  chipTextActive: {
    color: colors.text,
    fontWeight: "600",
  },

  lagHint: {
    fontSize: 11,
    color: colors.textTertiary,
  },

  // Cards
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 16,
    gap: 10,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  cardTitle: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },

  // Confidence badge
  confidenceBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  confidenceBadgeText: {
    fontSize: 10,
    fontWeight: "600",
    textTransform: "capitalize",
  },

  // Correlation bars
  corrBarContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  corrBarLabel: {
    fontSize: 10,
    color: colors.textTertiary,
    width: 60,
  },
  corrBarTrack: {
    flex: 1,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#27272a",
    overflow: "hidden",
    position: "relative",
  },
  corrBarCenter: {
    position: "absolute",
    left: "50%",
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: "#52525b",
  },
  corrBarFill: {
    position: "absolute",
    top: 0,
    bottom: 0,
    borderRadius: 5,
    opacity: 0.7,
  },
  corrBarValue: {
    fontSize: 12,
    fontFamily: "Courier",
    fontWeight: "600",
    width: 50,
    textAlign: "right",
  },

  // Stats
  statsRow: {
    flexDirection: "row",
    gap: 16,
    paddingTop: 4,
  },
  statText: {
    fontSize: 11,
    color: colors.textTertiary,
  },

  // Insight
  insightText: {
    fontSize: 14,
    color: colors.text,
    lineHeight: 20,
  },

  statsGrid: {
    flexDirection: "row",
    gap: 16,
    paddingTop: 4,
  },
  statsGridItem: {
    flex: 1,
    gap: 2,
  },
  statsGridLabel: {
    fontSize: 10,
    color: colors.textTertiary,
  },
  statsGridValue: {
    fontSize: 13,
    color: colors.textSecondary,
  },

  // Chart
  chartContainer: {
    alignItems: "center",
  },
  axisLabels: {
    alignItems: "center",
    marginTop: -8,
  },
  axisLabel: {
    fontSize: 10,
    color: colors.textTertiary,
  },

  // Warning
  warningCard: {
    backgroundColor: "#422006",
    borderRadius: 8,
    padding: 12,
  },
  warningText: {
    fontSize: 13,
    color: "#fbbf24",
  },

  // Empty
  emptyContainer: {
    alignItems: "center",
    paddingVertical: 40,
  },
  emptyText: {
    fontSize: 14,
    color: colors.textSecondary,
  },

  // Disclaimer
  disclaimer: {
    fontSize: 11,
    color: colors.textTertiary,
    textAlign: "center",
    fontStyle: "italic",
    paddingTop: 8,
  },
});
