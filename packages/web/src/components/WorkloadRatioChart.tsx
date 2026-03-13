import type { WorkloadRatioRow } from "dofek-server/types";
import ReactECharts from "echarts-for-react";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface WorkloadRatioChartProps {
  data: WorkloadRatioRow[];
  loading?: boolean;
}

export function WorkloadRatioChart({ data, loading }: WorkloadRatioChartProps) {
  if (loading) {
    return <ChartLoadingSkeleton height={400} />;
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[400px]">
        <span className="text-zinc-600 text-sm">No workload data</span>
      </div>
    );
  }

  const dates = data.map((d) => d.date);

  const option = {
    backgroundColor: "transparent",
    tooltip: {
      trigger: "axis" as const,
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
      formatter: (
        params: {
          seriesName: string;
          data: [string, number | null];
          color: string;
          axisIndex: number;
        }[],
      ) => {
        if (!params || params.length === 0) return "";
        const firstParam = params[0];
        if (!firstParam) return "";
        const date = new Date(firstParam.data[0]).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        });
        let html = `<div style="font-weight:600;margin-bottom:4px">${date}</div>`;
        for (const p of params) {
          if (p.seriesName.startsWith("_")) continue;
          if (p.data[1] == null) continue;
          html += `<div style="display:flex;align-items:center;gap:6px">`;
          html += `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color}"></span>`;
          html += `<span>${p.seriesName}: <b>${p.data[1].toFixed(2)}</b></span>`;
          html += `</div>`;
        }
        return html;
      },
    },
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    legend: {
      data: ["Workload Ratio", "Acute Load", "Chronic Load"],
      textStyle: { color: "#a1a1aa", fontSize: 11 },
      top: 0,
    },
    grid: [
      { top: 40, right: 20, bottom: "55%", left: 50 },
      { top: "55%", right: 20, bottom: 30, left: 50 },
    ],
    xAxis: [
      {
        type: "time" as const,
        gridIndex: 0,
        axisLabel: { show: false },
        axisLine: { lineStyle: { color: "#3f3f46" } },
        splitLine: { show: false },
      },
      {
        type: "time" as const,
        gridIndex: 1,
        axisLabel: { color: "#71717a", fontSize: 11 },
        axisLine: { lineStyle: { color: "#3f3f46" } },
        splitLine: { show: false },
      },
    ],
    yAxis: [
      {
        type: "value" as const,
        name: "Workload Ratio",
        gridIndex: 0,
        min: 0,
        splitLine: { lineStyle: { color: "#27272a" } },
        axisLabel: { color: "#71717a", fontSize: 11 },
        axisLine: { show: false },
        nameTextStyle: { color: "#71717a", fontSize: 11 },
      },
      {
        type: "value" as const,
        name: "Load",
        gridIndex: 1,
        splitLine: { lineStyle: { color: "#27272a" } },
        axisLabel: { color: "#71717a", fontSize: 11 },
        axisLine: { show: false },
        nameTextStyle: { color: "#71717a", fontSize: 11 },
      },
    ],
    series: [
      // Risk zones for Workload Ratio (top grid)
      // Green zone: 0.8-1.3
      {
        name: "_zoneGreen",
        type: "line",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: [
          [dates[0], 1.3],
          [dates[dates.length - 1], 1.3],
        ],
        symbol: "none",
        lineStyle: { width: 0 },
        areaStyle: { color: "#22c55e", opacity: 0.08, origin: "start" },
        z: 0,
        silent: true,
      },
      {
        name: "_zoneClear",
        type: "line",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: [
          [dates[0], 0.8],
          [dates[dates.length - 1], 0.8],
        ],
        symbol: "none",
        lineStyle: { width: 0 },
        areaStyle: { color: "#09090b", opacity: 1, origin: "start" },
        z: 0,
        silent: true,
      },
      // Yellow zones: 0.5-0.8 and 1.3-1.5
      {
        name: "_zoneYellowLow",
        type: "line",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: [
          [dates[0], 0.8],
          [dates[dates.length - 1], 0.8],
        ],
        symbol: "none",
        lineStyle: { width: 0 },
        areaStyle: { color: "#eab308", opacity: 0.06, origin: "start" },
        z: 0,
        silent: true,
      },
      {
        name: "_zoneYellowHigh",
        type: "line",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: [
          [dates[0], 1.5],
          [dates[dates.length - 1], 1.5],
        ],
        symbol: "none",
        lineStyle: { width: 0 },
        areaStyle: { color: "#eab308", opacity: 0.06, origin: "start" },
        z: 0,
        silent: true,
      },
      // Red zone: >1.5
      {
        name: "_zoneRed",
        type: "line",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: [
          [dates[0], 2.5],
          [dates[dates.length - 1], 2.5],
        ],
        symbol: "none",
        lineStyle: { width: 0 },
        areaStyle: { color: "#ef4444", opacity: 0.06, origin: "start" },
        z: 0,
        silent: true,
      },
      // Workload Ratio line (top grid)
      {
        name: "Workload Ratio",
        type: "line",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: data.map((d) => [d.date, d.workloadRatio]),
        smooth: true,
        symbol: "none",
        lineStyle: { color: "#f59e0b", width: 2.5 },
        itemStyle: { color: "#f59e0b" },
        z: 5,
      },
      // Optimal reference line at 1.0
      {
        name: "_optimal",
        type: "line",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: [
          [dates[0], 1.0],
          [dates[dates.length - 1], 1.0],
        ],
        symbol: "none",
        lineStyle: { color: "#71717a", width: 1, type: "dashed" as const },
        z: 1,
        silent: true,
      },
      // Acute load area (bottom grid)
      {
        name: "Acute Load",
        type: "line",
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: data.map((d) => [d.date, d.acuteLoad]),
        smooth: true,
        symbol: "none",
        lineStyle: { color: "#ec4899", width: 2 },
        areaStyle: { color: "#ec4899", opacity: 0.15 },
        itemStyle: { color: "#ec4899" },
        z: 3,
      },
      // Chronic load area (bottom grid)
      {
        name: "Chronic Load",
        type: "line",
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: data.map((d) => [d.date, d.chronicLoad]),
        smooth: true,
        symbol: "none",
        lineStyle: { color: "#3b82f6", width: 2 },
        areaStyle: { color: "#3b82f6", opacity: 0.1 },
        itemStyle: { color: "#3b82f6" },
        z: 2,
      },
    ],
  };

  return <ReactECharts option={option} style={{ height: 400 }} notMerge={true} />;
}
