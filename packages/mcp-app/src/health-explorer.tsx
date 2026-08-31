import type { HealthExplorerSnapshot, HealthMetric } from "@dofek/mcp-contracts/health-explorer";
import * as echarts from "echarts";
import { useEffect, useRef } from "react";

export interface HealthExplorerProps {
  snapshot: HealthExplorerSnapshot;
  onMetricChange(metric: HealthMetric): void;
}

export function HealthExplorer({ snapshot, onMetricChange }: HealthExplorerProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  const primarySeries = snapshot.series[0];

  useEffect(() => {
    if (!chartRef.current || !primarySeries) return;
    const chart = echarts.init(chartRef.current);
    chart.setOption({
      grid: { left: 44, right: 20, top: 24, bottom: 34 },
      tooltip: { trigger: "axis" },
      xAxis: { type: "category", data: primarySeries.points.map((point) => point.key) },
      yAxis: { type: "value", name: primarySeries.unit },
      series: [{ type: "line", connectNulls: false, data: primarySeries.points.map((point) => point.value) }],
    });
    return () => chart.dispose();
  }, [primarySeries]);

  return (
    <main>
      <header>
        <h1>Dofek Analytics Explorer</h1>
        <p>{snapshot.range.start_date} to {snapshot.range.end_date}</p>
      </header>
      <label>
        Metric
        <select aria-label="Metric" value={primarySeries?.metric} onChange={(event) => onMetricChange(event.target.value as HealthMetric)}>
          {snapshot.series.map((series) => <option key={series.metric} value={series.metric}>{series.label}</option>)}
        </select>
      </label>
      <section aria-label="Summary">
        {snapshot.summary.map((summary) => <article key={summary.metric}><strong>{summary.metric}</strong><span>{summary.average ?? "No data"}</span></article>)}
        <p>{snapshot.coverage.observed_days} of {snapshot.coverage.requested_days} days observed</p>
      </section>
      <div ref={chartRef} aria-label="Health trend chart" style={{ height: 300, width: "100%" }} />
    </main>
  );
}
