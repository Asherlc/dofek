import { surfaceColors } from "@dofek/scoring/colors";
import type { WorkloadRatioRow } from "dofek-server/types";
import {
  chartColors,
  chartThemeColors,
  dofekAxis,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
} from "../lib/chartTheme.ts";
import { formatNumber } from "../lib/format.ts";
import { DofekChart } from "./DofekChart.tsx";

interface WorkloadRatioChartProps {
  data: WorkloadRatioRow[];
  loading?: boolean;
}

export function WorkloadRatioChart({ data, loading }: WorkloadRatioChartProps) {
  if (loading) {
    return <DofekChart option={{}} loading={true} height={400} />;
  }

  if (data.length === 0) {
    return <DofekChart option={{}} empty={true} height={400} emptyMessage="No workload data" />;
  }

  const dates = data.map((d) => d.date);

  const option = {
    tooltip: dofekTooltip({
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
          html += `<span>${p.seriesName}: <b>${formatNumber(p.data[1], 2)}</b></span>`;
          html += `</div>`;
        }
        return html;
      },
    }),
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    legend: dofekLegend(true, { data: ["Workload Ratio", "Acute Load", "Chronic Load"] }),
    grid: [
      { top: 40, right: 20, bottom: "55%", left: 50 },
      { top: "55%", right: 20, bottom: 30, left: 50 },
    ],
    xAxis: [
      {
        ...dofekAxis.time({ axisLabel: { show: false } }),
        gridIndex: 0,
      },
      {
        ...dofekAxis.time(),
        gridIndex: 1,
      },
    ],
    yAxis: [
      {
        ...dofekAxis.value({ name: "Workload Ratio", min: 0 }),
        gridIndex: 0,
      },
      {
        ...dofekAxis.value({ name: "Load" }),
        gridIndex: 1,
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
        areaStyle: { color: surfaceColors.background, opacity: 1, origin: "start" },
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
        ...dofekSeries.line(
          "Workload Ratio",
          data.map((d) => [d.date, d.workloadRatio]),
          {
            color: chartColors.amber,
            width: 2.5,
            z: 5,
          },
        ),
        xAxisIndex: 0,
        yAxisIndex: 0,
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
        lineStyle: { color: chartThemeColors.axisLabel, width: 1, type: "dashed" as const },
        z: 1,
        silent: true,
      },
      // Acute load area (bottom grid)
      {
        ...dofekSeries.line(
          "Acute Load",
          data.map((d) => [d.date, d.acuteLoad]),
          {
            color: chartColors.pink,
            areaStyle: { opacity: 0.15 },
            z: 3,
          },
        ),
        xAxisIndex: 1,
        yAxisIndex: 1,
      },
      // Chronic load area (bottom grid)
      {
        ...dofekSeries.line(
          "Chronic Load",
          data.map((d) => [d.date, d.chronicLoad]),
          {
            color: chartColors.blue,
            areaStyle: { opacity: 0.1 },
            z: 2,
          },
        ),
        xAxisIndex: 1,
        yAxisIndex: 1,
      },
    ],
  };

  return <DofekChart option={option} height={400} />;
}
