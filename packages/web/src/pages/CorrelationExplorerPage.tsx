import type { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { useState } from "react";
import { AppHeader } from "../components/AppHeader.tsx";
import { ChartDescriptionTooltip } from "../components/ChartDescriptionTooltip.tsx";
import { CorrelationStrengthBar } from "../components/CorrelationStrengthBar.tsx";
import { TimeRangeSelector } from "../components/TimeRangeSelector.tsx";
import { formatNumber } from "../lib/format.ts";
import { trpc } from "../lib/trpc.ts";

const LAG_OPTIONS = [
  { label: "Same day", value: 0 },
  { label: "+1 day", value: 1 },
  { label: "+2 days", value: 2 },
  { label: "+3 days", value: 3 },
];

const confidenceBadge = {
  strong: {
    label: "Strong",
    className: "bg-emerald-900/50 text-emerald-400 border-emerald-800",
  },
  emerging: {
    label: "Emerging",
    className: "bg-amber-900/50 text-amber-400 border-amber-800",
  },
  early: {
    label: "Early signal",
    className: "bg-accent/10 text-muted border-border-strong",
  },
  insufficient: {
    label: "Insufficient data",
    className: "bg-accent/10 text-dim border-border-strong",
  },
};

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
}: {
  value: string;
  onChange: (v: string) => void;
  grouped: MetricsByDomain;
  label: string;
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
              <option key={m.id} value={m.id}>
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
  const [days, setDays] = useState(365);
  const [metricX, setMetricX] = useState("protein");
  const [metricY, setMetricY] = useState("hrv");
  const [lag, setLag] = useState(0);

  const metricsQuery = trpc.correlation.metrics.useQuery({});
  const correlationQuery = trpc.correlation.compute.useQuery(
    { metricX, metricY, days, lag },
    { enabled: metricX !== metricY },
  );

  const grouped = metricsQuery.data ? groupByDomain(metricsQuery.data) : {};
  const data = correlationQuery.data;

  const xMetric = metricsQuery.data?.find((m) => m.id === metricX);
  const yMetric = metricsQuery.data?.find((m) => m.id === metricY);

  return (
    <div className="min-h-screen bg-page text-foreground overflow-x-hidden">
      <AppHeader>
        <TimeRangeSelector days={days} onChange={setDays} />
      </AppHeader>
      <main className="mx-auto max-w-7xl px-3 sm:px-6 py-4 sm:py-6 space-y-6">
        {/* Title */}
        <div>
          <h2 className="text-sm font-medium text-muted uppercase tracking-wider">
            Correlation Explorer
          </h2>
          <p className="text-xs text-dim mt-0.5">
            Pick any two metrics to see how they relate. Correlation does not imply causation.
          </p>
        </div>

        {/* Controls */}
        {metricsQuery.data && (
          <div className="space-y-3">
            <div className="flex gap-3 items-end">
              <MetricSelect
                value={metricX}
                onChange={setMetricX}
                grouped={grouped}
                label="X axis"
              />
              <span className="text-dim text-sm pb-2">vs</span>
              <MetricSelect
                value={metricY}
                onChange={setMetricY}
                grouped={grouped}
                label="Y axis"
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
                {lag > 0
                  ? `How ${xMetric?.label ?? "X"} today relates to ${yMetric?.label ?? "Y"} ${lag === 1 ? "tomorrow" : `${lag} days later`}`
                  : "Same-day comparison"}
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
              {/* Correlation stats card */}
              <div className="card p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs text-subtle uppercase tracking-wider">
                    Correlation Strength
                  </h3>
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded-full border ${confidenceBadge[data.confidenceLevel].className}`}
                  >
                    {confidenceBadge[data.confidenceLevel].label}
                  </span>
                </div>

                <div className="space-y-2">
                  <div>
                    <p className="text-[10px] text-dim mb-0.5">Spearman (rank)</p>
                    <CorrelationStrengthBar rho={data.spearmanRho} />
                  </div>
                  <div>
                    <p className="text-[10px] text-dim mb-0.5">Pearson (linear)</p>
                    <CorrelationStrengthBar rho={data.pearsonR} />
                  </div>
                </div>

                <div className="flex gap-4 text-[11px] text-dim pt-1">
                  <span>R² = {formatNumber(data.regression.rSquared, 3)}</span>
                  <span>n = {data.sampleCount}</span>
                  <span>
                    p ={" "}
                    {data.spearmanPValue < 0.001 ? "< 0.001" : formatNumber(data.spearmanPValue, 3)}
                  </span>
                </div>
              </div>

              {/* Insight card */}
              <div className="card p-4 space-y-3">
                <h3 className="text-xs text-subtle uppercase tracking-wider">Finding</h3>
                <p className="text-sm text-foreground leading-relaxed">{data.insight}</p>

                {data.sampleCount > 0 && (
                  <div className="grid grid-cols-2 gap-3 pt-1">
                    <div>
                      <p className="text-[10px] text-dim">{xMetric?.label ?? metricX}</p>
                      <p className="text-sm text-foreground">
                        {formatValue(data.xStats.mean)} ± {formatValue(data.xStats.stddev)}{" "}
                        <span className="text-dim">{xMetric?.unit}</span>
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-dim">{yMetric?.label ?? metricY}</p>
                      <p className="text-sm text-foreground">
                        {formatValue(data.yStats.mean)} ± {formatValue(data.yStats.stddev)}{" "}
                        <span className="text-dim">{yMetric?.unit}</span>
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Scatter plot */}
            {data.dataPoints.length > 0 && (
              <div
                className="card p-4"
                title="This chart plots each data point and overlays a trend line so you can see whether two metrics move together."
              >
                <div className="mb-2 flex items-center gap-2">
                  <h3 className="text-xs text-subtle uppercase tracking-wider">Scatter Plot</h3>
                  <ChartDescriptionTooltip description="This chart plots each data point and overlays a trend line so you can see whether two metrics move together." />
                </div>
                <ScatterPlot
                  dataPoints={data.dataPoints}
                  regression={data.regression}
                  rho={data.spearmanRho}
                  xLabel={`${xMetric?.label ?? metricX} (${xMetric?.unit ?? ""})`}
                  yLabel={`${yMetric?.label ?? metricY} (${yMetric?.unit ?? ""})`}
                />
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function ScatterPlot({
  dataPoints,
  regression,
  rho,
  xLabel,
  yLabel,
}: {
  dataPoints: Array<{ x: number; y: number; date: string }>;
  regression: { slope: number; intercept: number; rSquared: number };
  rho: number;
  xLabel: string;
  yLabel: string;
}) {
  const xs = dataPoints.map((p) => p.x);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const trendColor = rho >= 0 ? "#34d399" : "#fb7185";

  const option: EChartsOption = {
    grid: { left: 8, right: 16, top: 16, bottom: 32, containLabel: true },
    xAxis: {
      type: "value",
      name: xLabel,
      nameLocation: "middle",
      nameGap: 24,
      nameTextStyle: { color: "#6b8a6b", fontSize: 10 },
      axisLabel: { color: "#6b8a6b", fontSize: 9 },
      axisLine: { lineStyle: { color: "rgba(74, 158, 122, 0.2)" } },
      splitLine: { lineStyle: { color: "rgba(74, 158, 122, 0.12)" } },
    },
    yAxis: {
      type: "value",
      name: yLabel,
      nameTextStyle: { color: "#6b8a6b", fontSize: 10 },
      axisLabel: { color: "#6b8a6b", fontSize: 9 },
      axisLine: { lineStyle: { color: "rgba(74, 158, 122, 0.2)" } },
      splitLine: { lineStyle: { color: "rgba(74, 158, 122, 0.12)" } },
    },
    series: [
      {
        type: "scatter",
        data: dataPoints.map((p) => [p.x, p.y]),
        symbolSize: 5,
        itemStyle: { color: "#4a6a4a", opacity: 0.5 },
      },
      {
        type: "line",
        data: [
          [xMin, regression.slope * xMin + regression.intercept],
          [xMax, regression.slope * xMax + regression.intercept],
        ],
        lineStyle: { color: trendColor, width: 2, type: "dashed" },
        symbol: "none",
        silent: true,
      },
    ],
    tooltip: {
      trigger: "item",
      backgroundColor: "#ffffff",
      borderColor: "rgba(74, 158, 122, 0.2)",
      textStyle: { color: "#1a2e1a", fontSize: 11 },
      formatter: (params: unknown) => {
        if (!params || typeof params !== "object" || !("value" in params)) return "";
        const rawValue = Array.isArray(params.value) ? params.value : [0, 0];
        const v0 = Number(rawValue[0] ?? 0);
        const v1 = Number(rawValue[1] ?? 0);
        return `${xLabel}: ${formatValue(v0)}<br/>${yLabel}: ${formatValue(v1)}`;
      },
    },
  };

  return <ReactECharts option={option} style={{ height: 340 }} opts={{ renderer: "svg" }} />;
}
