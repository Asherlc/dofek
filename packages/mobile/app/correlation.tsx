import { formatNumber, formatSigned } from "@dofek/format/format";
import { providerLabel } from "@dofek/providers/providers";
import { chartColors } from "@dofek/scoring/colors";
import { CORRELATION_AVAILABILITY_DESCRIPTION } from "@dofek/stats/correlation";
import {
  formatCorrelationComparison,
  formatCorrelationLagOption,
} from "@dofek/stats/correlation-lag";
import type { AppRouterOutputs } from "dofek-server/router";
import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import Svg, { Circle, Line } from "react-native-svg";
import { AccessibleChart } from "../components/AccessibleChart";
import { ChartTitleWithTooltip } from "../components/ChartTitleWithTooltip";
import { DaySelector } from "../components/DaySelector";
import { getQueryErrorMessage, QueryStatePanel } from "../components/QueryStatePanel";
import { trpc } from "../lib/trpc";
import { useRefresh } from "../lib/useRefresh";
import { useTimeRangePreference } from "../lib/useTimeRangePreference";
import { colors } from "../theme";

// ── Constants ──

const DAY_OPTIONS = [
  { label: "90d", value: 90 },
  { label: "180d", value: 180 },
  { label: "1y", value: 365 },
];

const LAG_OPTIONS = [0, 1, 2, 3].map((value) => ({
  label: formatCorrelationLagOption(value),
  value,
}));

const DOMAIN_ORDER = ["Recovery", "Sleep", "Nutrition", "Activity", "Body"];
const METRIC_FAMILY_ROUTES = {
  recovery: "/recovery",
  sleep: "/sleep",
  nutrition: "/food",
  activity: "/activities",
  body: "/recovery",
} as const;

type CorrelationObservationsOutput = AppRouterOutputs["correlation"]["observations"];
type PairedObservation = CorrelationObservationsOutput["items"][number];
type ObservationContributor = PairedObservation["x"]["contributors"][number];

function formatObservationValue(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString() : formatNumber(value);
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
          accessibilityRole="button"
          accessibilityLabel={opt.label}
          accessibilityState={{ selected: lag === opt.value }}
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
  description: string;
  availabilityDescription: string;
}

function MetricPicker({
  label,
  selected,
  metrics,
  onSelect,
  unavailableMetricId,
  searchQuery,
  onSearchChange,
}: {
  label: string;
  selected: string;
  metrics: MetricItem[];
  onSelect: (id: string) => void;
  unavailableMetricId: string;
  searchQuery: string;
  onSearchChange: (value: string) => void;
}) {
  const grouped = useMemo(() => {
    const groups: Record<string, MetricItem[]> = {};
    const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase();
    for (const m of metrics) {
      const matchesSearch =
        normalizedSearchQuery.length === 0 ||
        [m.label, m.unit, m.domain, m.description, m.availabilityDescription]
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalizedSearchQuery);
      if (!matchesSearch) continue;
      const domain = m.domain.charAt(0).toUpperCase() + m.domain.slice(1);
      if (!groups[domain]) groups[domain] = [];
      groups[domain].push(m);
    }
    return DOMAIN_ORDER.filter((d) => groups[d]?.length).map((d) => ({
      domain: d,
      items: groups[d] ?? [],
    }));
  }, [metrics, searchQuery]);
  const selectedMetric = metrics.find((metric) => metric.id === selected);

  return (
    <View style={styles.pickerContainer}>
      <Text style={styles.pickerLabel}>{label}</Text>
      <TextInput
        value={searchQuery}
        onChangeText={onSearchChange}
        accessibilityLabel={`Search ${label} metrics`}
        placeholder="Search metrics"
        placeholderTextColor={colors.textTertiary}
        autoCapitalize="none"
        style={styles.metricSearch}
      />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroller}>
        {grouped.map(({ domain, items }) => (
          <View key={domain} style={styles.chipGroup}>
            <Text style={styles.chipGroupLabel}>{domain}</Text>
            <View style={styles.chipRow}>
              {items.map((m) => {
                const isUnavailable = m.id === unavailableMetricId;
                return (
                  <TouchableOpacity
                    key={m.id}
                    style={[
                      styles.chip,
                      selected === m.id && styles.chipActive,
                      isUnavailable && styles.chipUnavailable,
                    ]}
                    onPress={isUnavailable ? undefined : () => onSelect(m.id)}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={`${m.label} (${m.unit})`}
                    accessibilityState={{
                      disabled: isUnavailable,
                      selected: selected === m.id,
                    }}
                    disabled={isUnavailable}
                  >
                    <Text
                      style={[
                        styles.chipText,
                        selected === m.id && styles.chipTextActive,
                        isUnavailable && styles.chipTextUnavailable,
                      ]}
                    >
                      {m.label} ({m.unit})
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        ))}
      </ScrollView>
      {grouped.length === 0 && <Text style={styles.noMatchingMetrics}>No matching metrics</Text>}
      {selectedMetric && (
        <View style={styles.metricDetails}>
          <Text style={styles.metricDescription}>{selectedMetric.description}</Text>
          <Text style={styles.metricAvailability}>{selectedMetric.availabilityDescription}</Text>
        </View>
      )}
    </View>
  );
}

function CoverageSummary({
  coverage,
}: {
  coverage: {
    selectedDayCount: number;
    eligiblePairDayCount: number;
    observedXDayCount: number;
    observedYDayCount: number;
    pairedDayCount: number;
    missingPairDayCount: number;
  };
}) {
  return (
    <View style={styles.statsGrid}>
      <Text style={styles.statText}>{coverage.selectedDayCount} selected</Text>
      <Text style={styles.statText}>{coverage.eligiblePairDayCount} lag-eligible</Text>
      <Text style={styles.statText}>{coverage.observedXDayCount} X observed</Text>
      <Text style={styles.statText}>{coverage.observedYDayCount} Y observed</Text>
      <Text style={styles.statText}>{coverage.pairedDayCount} paired</Text>
      <Text style={styles.statText}>{coverage.missingPairDayCount} missing pairs</Text>
    </View>
  );
}

function UncertaintySummary({
  uncertainty,
}: {
  uncertainty:
    | { availability: "available"; level: 0.95; lower: number; upper: number }
    | {
        availability: "unavailable";
        reason:
          | "empty_input"
          | "degenerate_input"
          | "insufficient_pairs"
          | "insufficient_valid_replicates";
      };
}) {
  if (uncertainty.availability === "available") {
    return (
      <Text style={styles.statText}>
        95% block-bootstrap interval: {formatSigned(uncertainty.lower, 2)} to{" "}
        {formatSigned(uncertainty.upper, 2)}
      </Text>
    );
  }
  return (
    <Text style={styles.statText}>
      95% block-bootstrap interval unavailable (
      {uncertainty.reason === "degenerate_input"
        ? "one metric did not vary"
        : uncertainty.reason === "insufficient_pairs"
          ? "fewer than five paired days"
          : uncertainty.reason === "empty_input"
            ? "no eligible calendar days"
            : "not enough valid resamples"}
      ).
    </Text>
  );
}

function ObservationContributors({
  contributors,
  onOpen,
}: {
  contributors: ObservationContributor[];
  onOpen: (contributor: ObservationContributor) => void;
}) {
  if (contributors.length === 0) {
    return <Text style={styles.observationSourceText}>No linked source</Text>;
  }

  return (
    <View style={styles.observationSources}>
      {contributors.map((contributor) => (
        <View
          key={`${contributor.kind}:${contributor.label}:${
            contributor.target.type === "activity"
              ? contributor.target.activityId
              : contributor.target.family
          }`}
          style={styles.observationSource}
        >
          <TouchableOpacity
            onPress={() => onOpen(contributor)}
            accessibilityRole="button"
            accessibilityLabel={`Open ${contributor.label}`}
            activeOpacity={0.7}
          >
            <Text style={styles.observationSourceLink}>{contributor.label}</Text>
          </TouchableOpacity>
          {contributor.kind === "aggregate_inputs" && (
            <Text style={styles.observationSourceText}>
              Aggregate inputs
              {contributor.providerIds.length > 0
                ? ` · ${contributor.providerIds.map(providerLabel).join(", ")}`
                : ""}
            </Text>
          )}
        </View>
      ))}
    </View>
  );
}

function PairedObservationsList({
  observations,
  totalCount,
  xMetric,
  yMetric,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  onOpenContributor,
}: {
  observations: PairedObservation[];
  totalCount: number;
  xMetric: MetricItem | undefined;
  yMetric: MetricItem | undefined;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onOpenContributor: (contributor: ObservationContributor) => void;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Paired Observations</Text>
      <Text style={styles.observationSummary}>
        {totalCount} complete paired {totalCount === 1 ? "day" : "days"} behind this result
      </Text>

      {observations.length === 0 ? (
        <Text style={styles.observationEmpty}>No complete paired observations in this range.</Text>
      ) : (
        observations.map((observation) => (
          <View
            key={`${observation.x.date}:${observation.y.date}`}
            style={styles.observationRow}
            accessible
            accessibilityLabel={`Paired observation ${observation.x.date} and ${observation.y.date}`}
          >
            <Text style={styles.observationDate}>
              {observation.x.date === observation.y.date
                ? observation.x.date
                : `${observation.x.date} → ${observation.y.date}`}
            </Text>
            <View style={styles.observationValueRow}>
              <View style={styles.observationValue}>
                <Text style={styles.observationValueText}>
                  {xMetric?.label ?? "X"}: {formatObservationValue(observation.x.value)}{" "}
                  {xMetric?.unit ?? ""}
                </Text>
                <ObservationContributors
                  contributors={observation.x.contributors}
                  onOpen={onOpenContributor}
                />
              </View>
              <View style={styles.observationValue}>
                <Text style={styles.observationValueText}>
                  {yMetric?.label ?? "Y"}: {formatObservationValue(observation.y.value)}{" "}
                  {yMetric?.unit ?? ""}
                </Text>
                <ObservationContributors
                  contributors={observation.y.contributors}
                  onOpen={onOpenContributor}
                />
              </View>
            </View>
          </View>
        ))
      )}

      <View style={styles.observationPagination}>
        <TouchableOpacity
          style={[
            styles.observationPageButton,
            !hasPrevious && styles.observationPageButtonDisabled,
          ]}
          disabled={!hasPrevious}
          onPress={onPrevious}
          accessibilityRole="button"
          accessibilityLabel="Previous observation page"
          accessibilityState={{ disabled: !hasPrevious }}
        >
          <Text style={styles.observationPageButtonText}>Previous</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.observationPageButton, !hasNext && styles.observationPageButtonDisabled]}
          disabled={!hasNext}
          onPress={onNext}
          accessibilityRole="button"
          accessibilityLabel="Next observation page"
          accessibilityState={{ disabled: !hasNext }}
        >
          <Text style={styles.observationPageButtonText}>Next</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Scatter Plot ──

function ScatterPlot({
  dataPoints,
  regression,
  xLabel,
  yLabel,
  width: chartWidth,
}: {
  dataPoints: Array<{ x: number; y: number; date: string }>;
  regression: {
    slope: number | null;
    intercept: number | null;
    rSquared: number | null;
  };
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

  const lineY1 =
    regression.slope === null || regression.intercept === null
      ? null
      : regression.slope * xMin + regression.intercept;
  const lineY2 =
    regression.slope === null || regression.intercept === null
      ? null
      : regression.slope * xMax + regression.intercept;

  const accessibleRows = dataPoints.map((point) => ({
    label: point.date,
    value: `${xLabel}: ${formatNumber(point.x)} · ${yLabel}: ${formatNumber(point.y)}`,
  }));

  return (
    <AccessibleChart
      title="Scatter plot"
      summary={`Scatter plot comparing ${xLabel} and ${yLabel}.`}
      rows={accessibleRows}
    >
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
          {lineY1 !== null && lineY2 !== null && (
            <Line
              testID="correlation-trend-line"
              x1={scaleX(xMin)}
              y1={scaleY(lineY1)}
              x2={scaleX(xMax)}
              y2={scaleY(lineY2)}
              stroke={chartColors.blue}
              strokeWidth={2}
              strokeDasharray="6,4"
              opacity={0.7}
            />
          )}

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
    </AccessibleChart>
  );
}

// ── Main Screen ──

export default function CorrelationScreen() {
  const { days, description, setDays } = useTimeRangePreference("correlation");
  const [metricX, setMetricX] = useState("protein");
  const [metricY, setMetricY] = useState("hrv");
  const [metricXSearch, setMetricXSearch] = useState("");
  const [metricYSearch, setMetricYSearch] = useState("");
  const [lag, setLag] = useState(0);
  const [observationCursors, setObservationCursors] = useState<Array<string | undefined>>([
    undefined,
  ]);
  const observationCursor = observationCursors.at(-1);
  const resetObservationCursor = () => setObservationCursors([undefined]);
  const { width } = useWindowDimensions();
  const isWide = width >= 600;

  const metricsQuery = trpc.correlation.metrics.useQuery({});
  const correlationQuery = trpc.correlation.computeV2.useQuery(
    { metricX, metricY, days, lag },
    { enabled: metricX !== metricY },
  );
  const observationsQuery = trpc.correlation.observations.useQuery(
    {
      metricX,
      metricY,
      days,
      lag,
      pageSize: 25,
      ...(observationCursor === undefined ? {} : { cursor: observationCursor }),
    },
    { enabled: metricX !== metricY },
  );

  const data = correlationQuery.data;
  const metrics = metricsQuery.data ?? [];
  const xMetric = metrics.find((m) => m.id === metricX);
  const yMetric = metrics.find((m) => m.id === metricY);
  const hasMetricMetadata = xMetric !== undefined && yMetric !== undefined;
  const router = useRouter();

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
      <DaySelector
        days={days}
        description={description}
        onChange={(nextDays) => {
          setDays(nextDays);
          resetObservationCursor();
        }}
        options={DAY_OPTIONS}
      />

      {/* Metric pickers */}
      {metrics.length > 0 && (
        <>
          <Text style={styles.availabilityHint}>{CORRELATION_AVAILABILITY_DESCRIPTION}</Text>
          <MetricPicker
            label="X Axis"
            selected={metricX}
            metrics={metrics}
            onSelect={(nextMetric) => {
              setMetricX(nextMetric);
              resetObservationCursor();
            }}
            unavailableMetricId={metricY}
            searchQuery={metricXSearch}
            onSearchChange={setMetricXSearch}
          />
          <MetricPicker
            label="Y Axis"
            selected={metricY}
            metrics={metrics}
            onSelect={(nextMetric) => {
              setMetricY(nextMetric);
              resetObservationCursor();
            }}
            unavailableMetricId={metricX}
            searchQuery={metricYSearch}
            onSearchChange={setMetricYSearch}
          />
        </>
      )}

      {/* Lag selector */}
      <Text style={styles.sectionLabel}>Lag</Text>
      <LagSelector
        lag={lag}
        onChange={(nextLag) => {
          setLag(nextLag);
          resetObservationCursor();
        }}
      />
      <Text style={styles.lagHint}>
        {formatCorrelationComparison({
          xLabel: xMetric?.label ?? "X",
          yLabel: yMetric?.label ?? "Y",
          lag,
        })}
      </Text>

      <TouchableOpacity
        style={styles.experimentButton}
        onPress={() =>
          router.push({
            pathname: "/experiments",
            params: { outcomeMetricId: metricY, lagDays: String(lag) },
          })
        }
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`Start experiment with ${yMetric?.label ?? "this outcome"}`}
      >
        <Text style={styles.experimentButtonText}>
          Start experiment with {yMetric?.label ?? "this outcome"}
        </Text>
      </TouchableOpacity>
      <Text style={styles.lagHint}>
        Prefills the outcome and lag. You still choose a controllable intervention.
      </Text>

      {/* Same metric warning */}
      {metricX === metricY && (
        <View style={styles.warningCard}>
          <Text style={styles.warningText}>Select two different metrics to compare.</Text>
        </View>
      )}

      {metricsQuery.isError && (
        <QueryStatePanel
          variant="error"
          message={getQueryErrorMessage(metricsQuery.error)}
          minHeight={72}
        />
      )}

      {correlationQuery.isError && metricX !== metricY && (
        <QueryStatePanel
          variant="error"
          message={getQueryErrorMessage(correlationQuery.error)}
          minHeight={72}
        />
      )}

      {/* Loading */}
      {correlationQuery.isLoading && metricX !== metricY && (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>Analyzing...</Text>
        </View>
      )}

      {observationsQuery.isError && metricX !== metricY && (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>{observationsQuery.error.message}</Text>
        </View>
      )}

      {/* Results */}
      {data && metricX !== metricY && (
        <>
          {/* Correlation evidence card */}
          <View style={styles.card}>
            <ChartTitleWithTooltip
              title="Correlation Evidence"
              description="The rank correlation, dependence-aware interval, and calendar-day coverage for the selected metrics."
              textStyle={styles.cardTitle}
            />
            <Text style={styles.statText}>{data.epistemicStatus.label}</Text>

            {data.availability === "available" ? (
              <>
                <Text style={styles.insightText}>
                  {data.spearmanRho === null
                    ? "Spearman rho not estimable"
                    : `Spearman rho = ${formatSigned(data.spearmanRho, 2)}`}
                </Text>
                <UncertaintySummary uncertainty={data.uncertainty} />

                <View style={styles.statsRow}>
                  {hasMetricMetadata && data.regression.slope !== null && (
                    <Text style={styles.statText}>
                      Slope = {formatNumber(data.regression.slope, 3)} {yMetric.unit} per{" "}
                      {xMetric.unit}
                    </Text>
                  )}
                  {data.regression.rSquared !== null && (
                    <Text style={styles.statText}>
                      R² = {formatNumber(data.regression.rSquared, 3)}
                    </Text>
                  )}
                </View>
              </>
            ) : (
              <View style={styles.statsRow}>
                <Text style={styles.statText}>n = {data.sampleCount}</Text>
                <Text style={styles.statText}>
                  {data.additionalSamplesRequired} more paired calendar{" "}
                  {data.additionalSamplesRequired === 1 ? "day" : "days"} needed
                </Text>
                <UncertaintySummary uncertainty={data.uncertainty} />
              </View>
            )}
            <CoverageSummary coverage={data.coverage} />
          </View>

          {/* Insight card */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Finding</Text>
            <Text style={styles.insightText}>{data.insight}</Text>
            <Text style={styles.interpretationWarning}>{data.interpretationWarning}</Text>

            {data.availability === "available" && hasMetricMetadata && (
              <View style={styles.statsGrid}>
                <View style={styles.statsGridItem}>
                  <Text style={styles.statsGridLabel}>{xMetric.label}</Text>
                  <Text style={styles.statsGridValue}>
                    {formatNumber(data.xStats.mean)} ± {formatNumber(data.xStats.stddev)}{" "}
                    {xMetric.unit}
                  </Text>
                </View>
                <View style={styles.statsGridItem}>
                  <Text style={styles.statsGridLabel}>{yMetric.label}</Text>
                  <Text style={styles.statsGridValue}>
                    {formatNumber(data.yStats.mean)} ± {formatNumber(data.yStats.stddev)}{" "}
                    {yMetric.unit}
                  </Text>
                </View>
              </View>
            )}
          </View>

          {/* Scatter plot */}
          {data.availability === "available" && data.dataPoints.length > 0 && hasMetricMetadata && (
            <View style={styles.card}>
              <ChartTitleWithTooltip
                title="Scatter Plot"
                description="This chart plots each data point and a trend line to visualize how the two metrics relate."
                textStyle={styles.cardTitle}
              />
              <ScatterPlot
                dataPoints={data.dataPoints}
                regression={data.regression}
                xLabel={`${xMetric.label} (${xMetric.unit})`}
                yLabel={`${yMetric.label} (${yMetric.unit})`}
                width={isWide ? 660 : width - 48}
              />
            </View>
          )}

          {observationsQuery.data && (
            <PairedObservationsList
              observations={observationsQuery.data.items}
              totalCount={observationsQuery.data.totalCount}
              xMetric={xMetric}
              yMetric={yMetric}
              hasPrevious={observationCursors.length > 1}
              hasNext={observationsQuery.data.nextCursor !== null}
              onPrevious={() =>
                setObservationCursors((cursors) =>
                  cursors.length > 1 ? cursors.slice(0, -1) : cursors,
                )
              }
              onNext={() => {
                const nextCursor = observationsQuery.data?.nextCursor;
                if (nextCursor !== null && nextCursor !== undefined) {
                  setObservationCursors((cursors) => [...cursors, nextCursor]);
                }
              }}
              onOpenContributor={(contributor) => {
                if (contributor.target.type === "activity") {
                  router.push(`/activity/${contributor.target.activityId}`);
                  return;
                }
                router.push(METRIC_FAMILY_ROUTES[contributor.target.family]);
              }}
            />
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
  metricSearch: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: 13,
    paddingHorizontal: 10,
    paddingVertical: 8,
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
  chipUnavailable: {
    opacity: 0.45,
  },
  chipText: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  chipTextActive: {
    color: colors.text,
    fontWeight: "600",
  },
  chipTextUnavailable: {
    color: colors.textSecondary,
  },
  noMatchingMetrics: {
    fontSize: 12,
    color: colors.textTertiary,
  },
  metricDetails: {
    gap: 3,
  },
  metricDescription: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  metricAvailability: {
    fontSize: 11,
    color: colors.textTertiary,
  },
  availabilityHint: {
    fontSize: 11,
    color: colors.textTertiary,
    lineHeight: 16,
  },

  lagHint: {
    fontSize: 11,
    color: colors.textTertiary,
  },
  experimentButton: {
    alignSelf: "flex-start",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: colors.surfaceSecondary,
  },
  experimentButtonText: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.text,
  },

  // Cards
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 16,
    gap: 10,
  },
  cardTitle: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },

  // Stats
  statsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
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
  interpretationWarning: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },

  statsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
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

  observationSummary: {
    fontSize: 11,
    color: colors.textTertiary,
  },
  observationEmpty: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  observationRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: 12,
    gap: 8,
  },
  observationDate: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  observationValueRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  observationValue: {
    flex: 1,
    minWidth: 220,
    gap: 5,
  },
  observationValueText: {
    fontSize: 13,
    color: colors.text,
  },
  observationSources: {
    gap: 4,
  },
  observationSource: {
    gap: 2,
  },
  observationSourceLink: {
    fontSize: 12,
    color: colors.accent,
  },
  observationSourceText: {
    fontSize: 10,
    color: colors.textTertiary,
  },
  observationPagination: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
  },
  observationPageButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  observationPageButtonDisabled: {
    opacity: 0.4,
  },
  observationPageButtonText: {
    fontSize: 12,
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
