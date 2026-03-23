import type { HrvVariabilityRow } from "dofek-server/types";
import {
  chartColors,
  dofekAxis,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
} from "../lib/chartTheme.ts";
import { formatNumber } from "../lib/format.ts";
import { DofekChart } from "./DofekChart.tsx";

interface HrvVariabilityChartProps {
  data: HrvVariabilityRow[];
  loading?: boolean;
}

const COLOR_HRV = chartColors.green;
const COLOR_ZONE_GREEN = "#22c55e";
const COLOR_ZONE_YELLOW = "#eab308";
const COLOR_ZONE_RED = "#ef4444";

export function HrvVariabilityChart({ data, loading }: HrvVariabilityChartProps) {
  const dates = data.map((d) => d.date);
  const hrvValues = data.map((d) => (d.hrv != null ? [d.date, d.hrv] : [d.date, null]));
  const cvValues = data.map((d) =>
    d.rollingCoefficientOfVariation != null
      ? [d.date, d.rollingCoefficientOfVariation]
      : [d.date, null],
  );

  // Find max CV for y-axis scaling
  const maxCv = Math.max(
    15,
    ...data
      .filter((d) => d.rollingCoefficientOfVariation != null)
      .map((d) => Number(d.rollingCoefficientOfVariation)),
  );

  const option = {
    grid: { top: 40, right: 60, bottom: 30, left: 50 },
    tooltip: dofekTooltip({
      formatter: (
        params: { seriesName: string; data: [string, number | null]; color: string }[],
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
          if (p.data[1] == null) continue;
          const unit = p.seriesName === "Rolling Variability" ? "%" : " ms";
          html += `<div style="display:flex;align-items:center;gap:6px">`;
          html += `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color}"></span>`;
          html += `<span>${p.seriesName}: <b>${formatNumber(p.data[1])}${unit}</b></span>`;
          html += `</div>`;
        }
        return html;
      },
    }),
    legend: dofekLegend(true, {
      data: ["Heart Rate Variability", "Rolling Variability"],
    }),
    xAxis: dofekAxis.time(),
    yAxis: [
      dofekAxis.value({
        name: "Heart Rate Variability (ms)",
        position: "left",
      }),
      dofekAxis.value({
        name: "Variability (%)",
        min: 0,
        max: Math.ceil(maxCv),
        position: "right",
        showSplitLine: false,
      }),
    ],
    visualMap: [
      {
        show: false,
        seriesIndex: 1,
        dimension: 1,
        pieces: [
          { lt: 5, color: COLOR_ZONE_GREEN },
          { gte: 5, lt: 10, color: COLOR_ZONE_YELLOW },
          { gte: 10, color: COLOR_ZONE_RED },
        ],
      },
    ],
    series: [
      // Shaded zone: green <5%
      {
        name: "_zoneGreen",
        type: "line",
        data: [
          [dates[0], 5],
          [dates[dates.length - 1], 5],
        ],
        symbol: "none",
        lineStyle: { width: 0 },
        areaStyle: { color: COLOR_ZONE_GREEN, opacity: 0.06, origin: "start" },
        yAxisIndex: 1,
        z: 0,
        silent: true,
      },
      // Shaded zone: yellow 5-10%
      {
        name: "_zoneYellow",
        type: "line",
        data: [
          [dates[0], 10],
          [dates[dates.length - 1], 10],
        ],
        symbol: "none",
        lineStyle: { width: 0 },
        areaStyle: { color: COLOR_ZONE_YELLOW, opacity: 0.06, origin: "start" },
        yAxisIndex: 1,
        z: 0,
        silent: true,
      },
      // Shaded zone: red >10%
      {
        name: "_zoneRed",
        type: "line",
        data: [
          [dates[0], Math.ceil(maxCv)],
          [dates[dates.length - 1], Math.ceil(maxCv)],
        ],
        symbol: "none",
        lineStyle: { width: 0 },
        areaStyle: { color: COLOR_ZONE_RED, opacity: 0.06, origin: "start" },
        yAxisIndex: 1,
        z: 0,
        silent: true,
      },
      // Daily HRV dots
      {
        ...dofekSeries.scatter("Heart Rate Variability", hrvValues, {
          color: COLOR_HRV,
          symbolSize: 5,
        }),
        z: 3,
      },
      // Rolling Variability line
      {
        name: "Rolling Variability",
        type: "line",
        data: cvValues,
        smooth: true,
        symbol: "none",
        lineStyle: { width: 2.5 },
        yAxisIndex: 1,
        z: 4,
      },
    ],
  };

  return (
    <DofekChart
      option={option}
      loading={loading}
      empty={data.length === 0}
      emptyMessage="No heart rate variability data"
      height={300}
    />
  );
}
