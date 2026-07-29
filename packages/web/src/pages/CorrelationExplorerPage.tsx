import { formatNumber } from "@dofek/format/format";
import { chartColors } from "@dofek/scoring/colors";
import {
  formatCorrelationComparison,
  formatCorrelationLagOption,
} from "@dofek/stats/correlation-lag";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ChartDescriptionTooltip } from "../components/ChartDescriptionTooltip.tsx";
import { ChartRangeProvider, DofekChart } from "../components/DofekChart.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { TimeRangeSelector } from "../components/TimeRangeSelector.tsx";
import {
  chartThemeColors,
  dofekAxis,
  dofekGrid,
  dofekTooltip,
  escapeTooltipHtml,
} from "../lib/chartTheme.ts";
import { selectedRangeQueryInput, type TimeRangeDays } from "../lib/timeRange.ts";
import { trpc } from "../lib/trpc.ts";

const LAG_OPTIONS = [0, 1, 2, 3].map((value) => ({
  label: formatCorrelationLagOption(value),
  value,
}));

type MetricsByDomain = Record<
  string,
  Array<{ id: string; label: string; unit: string; description: string }>
>;

function groupByDomain(
  metrics: Array<{ id: string; label: string; unit: string; domain: string; description: string }>,
): MetricsByDomain {
  const groups: MetricsByDomain = {};
  for (const m of metrics) {
    const domain = m.domain.charAt(0).toUpperCase() + m.domain.slice(1);
    if (!groups[domain]) groups[domain] = [];
    groups[domain].push(m);
  }
  return groups;
}

function MetricSelect({
  value,
  onChange,
  grouped,
  label,
  unavailableValue,
}: {
  value: string;
  onChange: (v: string) => void;
  grouped: MetricsByDomain;
  label: string;
  unavailableValue: string;
}) {
  return (
    <label className="flex-1 min-w-0 block">
      <span className="block text-[10px] text-subtle uppercase tracking-wider mb-1">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-accent/10 border border-border-strong rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-border-strong"
      >
        {Object.entries(grouped).map(([domain, metrics]) => (
          <optgroup key={domain} label={domain}>
            {metrics.map((m) => (
              <option key={m.id} value={m.id} disabled={m.id === unavailableValue}>
                {m.label} ({m.unit})
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

function formatValue(v: number): string {
  if (Number.isInteger(v)) return v.toLocaleString();
  return formatNumber(v);
}

export function CorrelationExplorerPage() {
  const [days, setDays] = useState<TimeRangeDays>(365);
  const [metricX, setMetricX] = useState("protein");
  const [metricY, setMetricY] = useState("hrv");
  const [lag, setLag] = useState(0);

  const metricsQuery = trpc.correlation.metrics.useQuery({});
  const correlationQuery = trpc.correlation.computeV2.useQuery(
    { metricX, metricY, ...selectedRangeQueryInput(days), lag },
    { enabled: metricX !== metricY },
  );

  const grouped = metricsQuery.data ? groupByDomain(metricsQuery.data) : {};
  const data = correlationQuery.data;
  const dataPoints = Array.isArray(data?.dataPoints) ? data.dataPoints : [];

  const xMetric = metricsQuery.data?.find((m) => m.id === metricX);
  const yMetric = metricsQuery.data?.find((m) => m.id === metricY);
  const hasMetricMetadata = xMetric !== undefined && yMetric !== undefined;

  return (
    <ChartRangeProvider days={days}>
      <PageLayout
        headerChildren={<TimeRangeSelector days={days} onChange={setDays} />}
        title="Correlation Explorer"
        subtitle="Pick any two metrics to see how they relate. Correlation does not imply causation."
      >
        {/* Controls */}
        {metricsQuery.data && (
          <div className="space-y-3">
            <div className="flex gap-3 items-end">
              <MetricSelect
                value={metricX}
                onChange={setMetricX}
                grouped={grouped}
                label="X axis"
                unavailableValue={metricY}
              />
              <span className="text-dim text-sm pb-2">vs</span>
              <MetricSelect
                value={metricY}
                onChange={setMetricY}
                grouped={grouped}
                label="Y axis"
                unavailableValue={metricX}
              />
            </div>

            {/* Lag selector */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-subtle uppercase tracking-wider">Lag:</span>
              <div className="flex gap-1">
                {LAG_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setLag(opt.value)}
                    className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                      lag === opt.value
                        ? "bg-accent/15 text-foreground"
                        : "text-subtle hover:text-foreground"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <span className="text-[10px] text-dim ml-1">
                {formatCorrelationComparison({
                  xLabel: xMetric?.label ?? "X",
                  yLabel: yMetric?.label ?? "Y",
                  lag,
                })}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Link
                to="/experiments"
                search={{ outcomeMetricId: metricY, lagDays: lag }}
                className="inline-flex px-3 py-1.5 text-xs rounded-md bg-accent/15 text-foreground hover:bg-accent/25 transition-colors"
              >
                Start experiment with {yMetric?.label ?? "this outcome"}
              </Link>
              <span className="text-[10px] text-dim">
                Prefills the outcome and lag. You still choose a controllable intervention — the
                correlated X metric is not assumed to be one.
              </span>
            </div>
          </div>
        )}

        {/* Same metric warning */}
        {metricX === metricY && (
          <div className="rounded-lg border border-amber-900/30 bg-amber-950/20 p-4 text-sm text-amber-400">
            Select two different metrics to compare.
          </div>
        )}

        {metricsQuery.isError && <QueryStatePanel error={metricsQuery.error} height={72} />}

        {correlationQuery.isError && metricX !== metricY && (
          <QueryStatePanel error={correlationQuery.error} height={72} />
        )}

        {/* Loading */}
        {correlationQuery.isLoading && metricX !== metricY && (
          <div className="space-y-4">
            <div className="h-48 rounded-lg bg-skeleton animate-pulse" />
            <div className="h-64 rounded-lg bg-skeleton animate-pulse" />
          </div>
        )}

        {/* Results */}
        {data && metricX !== metricY && (
          <div className="space-y-4">
            {/* Summary row */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Correlation evidence card */}
              <div className="card p-4 space-y-3">
                <h3 className="text-xs text-subtle uppercase tracking-wider">
                  Correlation Evidence
                </h3>

                {data.availability === "available" ? (
                  <>
                    <p className="text-lg text-foreground">
                      {data.spearmanRho === null
                        ? "Spearman rho not estimable"
                        : `Spearman rho = ${formatNumber(data.spearmanRho, 2)}`}
                    </p>
                    <UncertaintySummary uncertainty={data.uncertainty} />
                    <div className="flex flex-wrap gap-4 text-[11px] text-dim pt-1">
                      {hasMetricMetadata && data.regression.slope !== null && (
                        <span>
                          Slope = {formatNumber(data.regression.slope, 3)} {yMetric.unit} per{" "}
                          {xMetric.unit}
                        </span>
                      )}
                      {data.regression.rSquared !== null && (
                        <span>R² = {formatNumber(data.regression.rSquared, 3)}</span>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="flex flex-wrap gap-4 text-[11px] text-dim pt-1">
                    <span>n = {data.sampleCount}</span>
                    <span>
                      {data.additionalSamplesRequired} more paired calendar{" "}
                      {data.additionalSamplesRequired === 1 ? "day" : "days"} needed
                    </span>
                    <UncertaintySummary uncertainty={data.uncertainty} />
                  </div>
                )}

                <CoverageSummary coverage={data.coverage} />
              </div>

              {/* Insight card */}
              <div className="card p-4 space-y-3">
                <h3 className="text-xs text-subtle uppercase tracking-wider">Finding</h3>
                <p className="text-sm text-foreground leading-relaxed">{data.insight}</p>
                <p className="text-[11px] text-dim leading-relaxed">{data.interpretationWarning}</p>

                {data.availability === "available" && hasMetricMetadata && (
                  <div className="grid grid-cols-2 gap-3 pt-1">
                    <div>
                      <p className="text-[10px] text-dim">{xMetric.label}</p>
                      <p className="text-sm text-foreground">
                        {formatValue(data.xStats.mean)} ± {formatValue(data.xStats.stddev)}{" "}
                        <span className="text-dim">{xMetric.unit}</span>
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-dim">{yMetric.label}</p>
                      <p className="text-sm text-foreground">
                        {formatValue(data.yStats.mean)} ± {formatValue(data.yStats.stddev)}{" "}
                        <span className="text-dim">{yMetric.unit}</span>
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Scatter plot */}
            {data.availability === "available" && dataPoints.length > 0 && hasMetricMetadata && (
              <div
                className="card p-4"
                title="This chart plots each data point and overlays a trend line so you can see whether two metrics move together."
              >
                <div className="mb-2 flex items-center gap-2">
                  <h3 className="text-xs text-subtle uppercase tracking-wider">Scatter Plot</h3>
                  <ChartDescriptionTooltip description="This chart plots each data point and overlays a trend line so you can see whether two metrics move together." />
                </div>
                <ScatterPlot
                  dataPoints={dataPoints}
                  regression={data.regression}
                  xLabel={`${xMetric.label} (${xMetric.unit})`}
                  yLabel={`${yMetric.label} (${yMetric.unit})`}
                />
              </div>
            )}
          </div>
        )}
      </PageLayout>
    </ChartRangeProvider>
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
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 border-t border-border pt-3 text-[11px] text-dim">
      <span>{coverage.selectedDayCount} selected</span>
      <span>{coverage.eligiblePairDayCount} lag-eligible</span>
      <span>{coverage.observedXDayCount} X observed</span>
      <span>{coverage.observedYDayCount} Y observed</span>
      <span>{coverage.pairedDayCount} paired</span>
      <span>{coverage.missingPairDayCount} missing pairs</span>
    </div>
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
      <p className="text-[11px] text-dim">
        95% block-bootstrap interval: {formatNumber(uncertainty.lower, 2)} to{" "}
        {formatNumber(uncertainty.upper, 2)}
      </p>
    );
  }
  return (
    <p className="text-[11px] text-dim">
      95% block-bootstrap interval unavailable (
      {uncertainty.reason === "degenerate_input"
        ? "one metric did not vary"
        : uncertainty.reason === "insufficient_pairs"
          ? "fewer than five paired days"
          : uncertainty.reason === "empty_input"
            ? "no eligible calendar days"
            : "not enough valid resamples"}
      ).
    </p>
  );
}

function ScatterPlot({
  dataPoints,
  regression,
  xLabel,
  yLabel,
}: {
  dataPoints: Array<{ x: number; y: number; date: string }>;
  regression: {
    slope: number | null;
    intercept: number | null;
    rSquared: number | null;
  };
  xLabel: string;
  yLabel: string;
}) {
  const xs = dataPoints.map((p) => p.x);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const trendSeries =
    regression.slope === null || regression.intercept === null
      ? []
      : [
          {
            type: "line",
            data: [
              [xMin, regression.slope * xMin + regression.intercept],
              [xMax, regression.slope * xMax + regression.intercept],
            ],
            lineStyle: { color: chartColors.blue, width: 2, type: "dashed" },
            symbol: "none",
            silent: true,
          },
        ];
  const option = {
    grid: dofekGrid("single", { left: 8, right: 16, top: 16, bottom: 32, containLabel: true }),
    xAxis: dofekAxis.value({
      name: xLabel,
      axisLabel: {
        color: chartThemeColors.axisLabel,
        fontSize: 9,
        nameLocation: "middle",
        nameGap: 24,
        nameTextStyle: { color: chartThemeColors.axisLabel, fontSize: 10 },
      },
    }),
    yAxis: dofekAxis.value({
      name: yLabel,
      axisLabel: { color: chartThemeColors.axisLabel, fontSize: 9 },
    }),
    series: [
      {
        type: "scatter",
        data: dataPoints.map((p) => [p.x, p.y]),
        symbolSize: 5,
        itemStyle: { color: chartThemeColors.legendText, opacity: 0.5 },
      },
      ...trendSeries,
    ],
    tooltip: dofekTooltip({
      trigger: "item",
      formatter: (params: unknown) => {
        if (!params || typeof params !== "object" || !("value" in params)) return "";
        const rawValue = Array.isArray(params.value) ? params.value : [0, 0];
        const v0 = Number(rawValue[0] ?? 0);
        const v1 = Number(rawValue[1] ?? 0);
        return `${escapeTooltipHtml(xLabel)}: ${formatValue(v0)}<br/>${escapeTooltipHtml(yLabel)}: ${formatValue(v1)}`;
      },
    }),
  };

  return <DofekChart option={option} height={340} opts={{ renderer: "svg" }} />;
}
