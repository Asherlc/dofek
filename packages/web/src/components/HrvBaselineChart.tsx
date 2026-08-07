import { formatDateShort, formatHRV, formatNumber } from "@dofek/format/format";
import {
  chartColors,
  dofekAxis,
  dofekLegend,
  dofekTooltip,
  escapeTooltipHtml,
} from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";

interface HrvBaselineRow {
  date: string;
  hrv: number | null;
  resting_hr: number | null;
  mean_60d: number | null;
  sd_60d: number | null;
  mean_7d: number | null;
  resting_hr_mean_7d: number | null;
}

interface HrvBaselineChartProps {
  data: HrvBaselineRow[];
  loading?: boolean;
}

const COLOR_HRV = chartColors.green;
const COLOR_RESTING_HEART_RATE = chartColors.amber;

export function HrvBaselineChart({ data, loading }: HrvBaselineChartProps) {
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
  const restingHeartRateData = data
    .filter((d) => d.resting_hr != null)
    .map((d) => [d.date, d.resting_hr]);
  const restingHeartRateRolling7dData = data
    .filter((d) => d.resting_hr_mean_7d != null)
    .map((d) => [d.date, +(d.resting_hr_mean_7d ?? 0).toFixed(1)]);

  const option = {
    grid: { top: 30, right: 60, bottom: 30, left: 50 },
    tooltip: dofekTooltip({
      formatter: (params: { seriesName: string; data: [string, number]; color: string }[]) => {
        if (!params || params.length === 0) return "";
        const firstParam = params[0];
        if (!firstParam) return "";
        const date = formatDateShort(firstParam.data[0]);
        let html = `<div style="font-weight:600;margin-bottom:4px">${escapeTooltipHtml(date)}</div>`;
        for (const p of params) {
          // Skip the lower band from tooltip
          if (p.seriesName === "_lowerBand") continue;
          const label = p.seriesName === "_upperBand" ? "60d Baseline" : p.seriesName;
          const formattedValue = p.seriesName.includes("Resting Heart Rate")
            ? `${formatNumber(p.data[1], 0)} bpm`
            : formatHRV(p.data[1]);
          html += `<div style="display:flex;align-items:center;gap:6px">`;
          html += `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${escapeTooltipHtml(p.color)}"></span>`;
          html += `<span>${escapeTooltipHtml(label)}: <b>${escapeTooltipHtml(formattedValue)}</b></span>`;
          html += `</div>`;
        }
        return html;
      },
    }),
    legend: {
      ...dofekLegend(true),
      data: [
        { name: "Heart Rate Variability", icon: "circle" },
        { name: "7d Avg", icon: "roundRect" },
        { name: "Resting Heart Rate", icon: "circle" },
        { name: "Resting Heart Rate 7d Avg", icon: "roundRect" },
      ],
    },
    xAxis: dofekAxis.time(),
    yAxis: [
      dofekAxis.value({
        name: "Heart Rate Variability (ms)",
        min: "dataMin",
        position: "left",
        axisLabel: { formatter: (value: number) => formatHRV(value) },
      }),
      dofekAxis.value({
        name: "Resting Heart Rate (bpm)",
        min: "dataMin",
        position: "right",
        showSplitLine: false,
        axisLabel: { formatter: (value: number) => formatNumber(value, 0) },
      }),
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
        areaStyle: { opacity: 0.12, color: COLOR_HRV },
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
        lineStyle: { width: 1, color: COLOR_HRV, opacity: 0.6 },
        itemStyle: { color: COLOR_HRV },
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
        lineStyle: { width: 3, color: COLOR_HRV },
        itemStyle: { color: COLOR_HRV },
        yAxisIndex: 0,
        z: 4,
      },
      {
        name: "Resting Heart Rate",
        type: "line",
        data: restingHeartRateData,
        smooth: false,
        symbol: "circle",
        symbolSize: 4,
        lineStyle: { width: 1, color: COLOR_RESTING_HEART_RATE, opacity: 0.6 },
        itemStyle: { color: COLOR_RESTING_HEART_RATE },
        yAxisIndex: 1,
        z: 3,
      },
      {
        name: "Resting Heart Rate 7d Avg",
        type: "line",
        data: restingHeartRateRolling7dData,
        smooth: true,
        symbol: "none",
        lineStyle: { width: 3, color: COLOR_RESTING_HEART_RATE },
        itemStyle: { color: COLOR_RESTING_HEART_RATE },
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
      emptyMessage="No heart rate variability or resting heart rate data"
      height={280}
    />
  );
}
