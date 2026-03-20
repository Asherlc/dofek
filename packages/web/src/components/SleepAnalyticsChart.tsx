import type { SleepNightlyRow } from "dofek-server/types";
import ReactECharts from "echarts-for-react";
import { formatNumber } from "../lib/format.ts";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface SleepAnalyticsChartProps {
  nightly: SleepNightlyRow[];
  sleepDebt: number;
  loading?: boolean;
}

export function buildSleepAnalyticsOption(nightly: SleepNightlyRow[], sleepDebt: number) {
  const debtHours = Math.round((sleepDebt / 60) * 10) / 10;
  const debtLabel = sleepDebt > 0 ? `${debtHours}h deficit` : `${Math.abs(debtHours)}h surplus`;
  const debtColor = sleepDebt > 120 ? "#ef4444" : sleepDebt > 0 ? "#eab308" : "#22c55e";

  return {
    backgroundColor: "transparent",
    // Reserve vertical space for both the legend row and sleep debt status row.
    grid: { top: 82, right: 60, bottom: 40, left: 50 },
    tooltip: {
      trigger: "axis" as const,
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
      formatter: (
        params: {
          seriesName: string;
          value: [string, number | null];
          color: string;
          marker: string;
          dataIndex: number;
        }[],
      ) => {
        if (!params || params.length === 0) return "";
        const firstParam = params[0];
        if (!firstParam) return "";
        const idx = firstParam.dataIndex;
        const night = nightly[idx];
        if (!night) return "";
        const totalHr = Math.floor(night.durationMinutes / 60);
        const totalMin = night.durationMinutes % 60;
        const dateLabel = new Date(night.date).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        let html = `<div style="font-weight:600;margin-bottom:4px">${dateLabel} (${totalHr}h ${totalMin}m)</div>`;
        for (const p of params) {
          if (p.seriesName === "7d Avg") {
            if (p.value[1] != null) {
              const avgHr = Math.floor(p.value[1] / 60);
              const avgMin = Math.round(p.value[1] % 60);
              html += `<div>${p.marker} ${p.seriesName}: <b>${avgHr}h ${avgMin}m</b></div>`;
            }
            continue;
          }
          if (p.value[1] == null) continue;
          const mins = Math.round((p.value[1] / 100) * night.durationMinutes);
          html += `<div>${p.marker} ${p.seriesName}: <b>${formatNumber(p.value[1])}%</b> (${mins}m)</div>`;
        }
        return html;
      },
    },
    legend: {
      data: ["Deep", "REM", "Light", "Awake", "7d Avg"],
      textStyle: { color: "#a1a1aa", fontSize: 11 },
      top: 0,
      left: 0,
      right: 0,
      itemGap: 14,
    },
    graphic: [
      {
        type: "text" as const,
        right: 10,
        top: 28,
        silent: true,
        style: {
          text: `14d Sleep Debt: ${debtLabel}`,
          fill: debtColor,
          fontSize: 13,
          fontWeight: "bold" as const,
          align: "right" as const,
        },
      },
    ],
    xAxis: {
      type: "time" as const,
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
    },
    yAxis: [
      {
        type: "value" as const,
        name: "Stage %",
        max: 100,
        splitLine: { lineStyle: { color: "#27272a" } },
        axisLabel: {
          color: "#71717a",
          fontSize: 11,
          formatter: "{value}%",
        },
        axisLine: { show: false },
        nameTextStyle: { color: "#71717a", fontSize: 11 },
      },
      {
        type: "value" as const,
        name: "Duration (min)",
        splitLine: { show: false },
        axisLabel: { color: "#71717a", fontSize: 11 },
        axisLine: { show: true, lineStyle: { color: "#3f3f46" } },
        nameTextStyle: { color: "#71717a", fontSize: 11 },
        position: "right" as const,
      },
    ],
    series: [
      {
        name: "Deep",
        type: "bar",
        stack: "sleep",
        data: nightly.map((d) => [d.date, d.deepPct]),
        itemStyle: { color: "#4f46e5" },
        yAxisIndex: 0,
      },
      {
        name: "REM",
        type: "bar",
        stack: "sleep",
        data: nightly.map((d) => [d.date, d.remPct]),
        itemStyle: { color: "#7c3aed" },
        yAxisIndex: 0,
      },
      {
        name: "Light",
        type: "bar",
        stack: "sleep",
        data: nightly.map((d) => [d.date, d.lightPct]),
        itemStyle: { color: "#3b82f6" },
        yAxisIndex: 0,
      },
      {
        name: "Awake",
        type: "bar",
        stack: "sleep",
        data: nightly.map((d) => [d.date, d.awakePct]),
        itemStyle: { color: "#ef4444" },
        yAxisIndex: 0,
      },
      {
        name: "7d Avg",
        type: "line",
        data: nightly.map((d) => [d.date, d.rollingAvgDuration]),
        smooth: true,
        symbol: "none",
        lineStyle: { color: "#22c55e", width: 2.5 },
        itemStyle: { color: "#22c55e" },
        yAxisIndex: 1,
        z: 5,
      },
    ],
  };
}

export function SleepAnalyticsChart({ nightly, sleepDebt, loading }: SleepAnalyticsChartProps) {
  if (loading) {
    return <ChartLoadingSkeleton height={350} />;
  }

  if (nightly.length === 0) {
    return (
      <div className="flex items-center justify-center h-[350px]">
        <span className="text-zinc-600 text-sm">No sleep data</span>
      </div>
    );
  }

  const option = buildSleepAnalyticsOption(nightly, sleepDebt);

  return <ReactECharts option={option} style={{ height: 350 }} notMerge={true} />;
}
