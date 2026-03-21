import ReactECharts from "echarts-for-react";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface HrvBaselineRow {
  date: string;
  hrv: number | null;
  resting_hr: number | null;
  mean_60d: number | null;
  sd_60d: number | null;
  mean_7d: number | null;
}

interface HrvBaselineChartProps {
  data: HrvBaselineRow[];
  loading?: boolean;
}

export function HrvBaselineChart({ data, loading }: HrvBaselineChartProps) {
  if (loading) {
    return <ChartLoadingSkeleton height={280} />;
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center" style={{ height: 280 }}>
        <span className="text-dim text-sm">No heart rate variability data</span>
      </div>
    );
  }

  // Upper band: mean + SD (capped, used as the visible top)
  const upperBandData = data
    .filter((d) => d.mean_60d != null && d.sd_60d != null)
    .map((d) => [d.date, +((d.mean_60d ?? 0) + (d.sd_60d ?? 0)).toFixed(1)]);

  // Lower band: mean - SD (this is the base)
  const lowerBandData = data
    .filter((d) => d.mean_60d != null && d.sd_60d != null)
    .map((d) => [d.date, +Math.max(0, (d.mean_60d ?? 0) - (d.sd_60d ?? 0)).toFixed(1)]);

  // 7-day rolling average
  const rolling7dData = data
    .filter((d) => d.mean_7d != null)
    .map((d) => [d.date, +(d.mean_7d ?? 0).toFixed(1)]);

  // Daily HRV values
  const dailyHrvData = data.filter((d) => d.hrv != null).map((d) => [d.date, d.hrv]);

  // Resting HR
  const restingHrData = data.filter((d) => d.resting_hr != null).map((d) => [d.date, d.resting_hr]);

  const option = {
    backgroundColor: "transparent",
    grid: { top: 30, right: 60, bottom: 30, left: 50 },
    tooltip: {
      trigger: "axis" as const,
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
      formatter: (params: { seriesName: string; data: [string, number]; color: string }[]) => {
        if (!params || params.length === 0) return "";
        const firstParam = params[0];
        if (!firstParam) return "";
        const date = new Date(firstParam.data[0]).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        });
        let html = `<div style="font-weight:600;margin-bottom:4px">${date}</div>`;
        for (const p of params) {
          // Skip the lower band from tooltip
          if (p.seriesName === "_lowerBand") continue;
          const label = p.seriesName === "_upperBand" ? "60d Baseline" : p.seriesName;
          html += `<div style="display:flex;align-items:center;gap:6px">`;
          html += `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color}"></span>`;
          html += `<span>${label}: <b>${p.data[1]}</b></span>`;
          html += `</div>`;
        }
        return html;
      },
    },
    legend: {
      show: true,
      textStyle: { color: "#a1a1aa", fontSize: 11 },
      top: 0,
      data: [
        { name: "Heart Rate Variability", icon: "circle" },
        { name: "7d Avg", icon: "roundRect" },
        { name: "Resting Heart Rate", icon: "roundRect" },
      ],
    },
    xAxis: {
      type: "time" as const,
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
      splitLine: { show: false },
    },
    yAxis: [
      {
        type: "value" as const,
        name: "Heart Rate Variability (ms)",
        min: "dataMin",
        splitLine: { lineStyle: { color: "#27272a" } },
        axisLabel: { color: "#71717a", fontSize: 11 },
        axisLine: { show: true, lineStyle: { color: "#3f3f46" } },
        nameTextStyle: { color: "#71717a", fontSize: 11 },
        position: "left" as const,
      },
      {
        type: "value" as const,
        name: "Resting Heart Rate (bpm)",
        min: "dataMin",
        splitLine: { show: false },
        axisLabel: { color: "#71717a", fontSize: 11 },
        axisLine: { show: true, lineStyle: { color: "#3f3f46" } },
        nameTextStyle: { color: "#71717a", fontSize: 11 },
        position: "right" as const,
      },
    ],
    series: [
      // Lower band (invisible base for the stacked area)
      {
        name: "_lowerBand",
        type: "line",
        data: lowerBandData,
        smooth: true,
        symbol: "none",
        lineStyle: { width: 0 },
        areaStyle: { opacity: 0 },
        stack: "baseline",
        yAxisIndex: 0,
        z: 1,
      },
      // Upper band (stacked on lower, the difference creates the visible band)
      {
        name: "_upperBand",
        type: "line",
        data: upperBandData.map((d, i) => {
          const lower = lowerBandData[i];
          if (!lower) return d;
          return [d[0], +(Number(d[1]) - Number(lower[1])).toFixed(1)];
        }),
        smooth: true,
        symbol: "none",
        lineStyle: { width: 0 },
        areaStyle: { opacity: 0.12, color: "#22c55e" },
        stack: "baseline",
        yAxisIndex: 0,
        z: 1,
      },
      // Daily HRV (dots + thin line)
      {
        name: "Heart Rate Variability",
        type: "line",
        data: dailyHrvData,
        smooth: false,
        symbol: "circle",
        symbolSize: 4,
        lineStyle: { width: 1, color: "#22c55e", opacity: 0.6 },
        itemStyle: { color: "#22c55e" },
        yAxisIndex: 0,
        z: 3,
      },
      // 7-day rolling average (thick smooth line)
      {
        name: "7d Avg",
        type: "line",
        data: rolling7dData,
        smooth: true,
        symbol: "none",
        lineStyle: { width: 3, color: "#22c55e" },
        itemStyle: { color: "#22c55e" },
        yAxisIndex: 0,
        z: 4,
      },
      // Resting HR on second y-axis
      {
        name: "Resting Heart Rate",
        type: "line",
        data: restingHrData,
        smooth: true,
        symbol: "none",
        lineStyle: { width: 2, color: "#ef4444" },
        itemStyle: { color: "#ef4444" },
        yAxisIndex: 1,
        z: 2,
      },
    ],
  };

  return <ReactECharts option={option} style={{ height: 280 }} notMerge={true} />;
}
