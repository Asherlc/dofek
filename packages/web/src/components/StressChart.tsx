import { StressScore, trendColor } from "@dofek/scoring/scoring";
import type { StressResult } from "dofek-server/types";
import ReactECharts from "echarts-for-react";
import { createChartOptions } from "../lib/chart-theme.ts";
import { formatNumber } from "../lib/format.ts";
import { ChartContainer } from "./ChartContainer.tsx";

interface StressChartProps {
  data: StressResult | undefined;
  loading?: boolean;
}

function trendIcon(trend: StressResult["trend"]): string {
  if (trend === "improving") return "↓";
  if (trend === "worsening") return "↑";
  return "→";
}

export function StressChart({ data, loading }: StressChartProps) {
  if (loading || !data || data.daily.length === 0) {
    return (
      <ChartContainer
        loading={!!loading}
        data={data?.daily ?? []}
        height={350}
        emptyMessage="No stress data"
      >
        <div />
      </ChartContainer>
    );
  }

  const latest = data.latestScore ?? 0;
  const latestStress = new StressScore(latest);
  const latestColor = latestStress.color;

  const option = createChartOptions({
    grid: { top: 50, right: 60, bottom: 40, left: 50 },
    tooltip: {
      trigger: "axis" as const,
      formatter: (
        params: {
          dataIndex: number;
          marker: string;
          seriesName: string;
          value: [string, number];
        }[],
      ) => {
        if (!params?.[0]) return "";
        const idx = params[0].dataIndex;
        const day = data.daily[idx];
        if (!day) return "";
        const date = new Date(day.date).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        });
        let html = `<div style="font-weight:600;margin-bottom:4px">${date}</div>`;
        const dayStress = new StressScore(day.stressScore);
        html += `<div>Stress: <b style="color:${dayStress.color}">${formatNumber(day.stressScore)} (${dayStress.label})</b></div>`;
        if (day.hrvDeviation != null)
          html += `<div>Heart rate variability deviation: <b>${day.hrvDeviation > 0 ? "+" : ""}${day.hrvDeviation}</b>σ</div>`;
        if (day.restingHrDeviation != null)
          html += `<div>Resting heart rate deviation: <b>${day.restingHrDeviation > 0 ? "+" : ""}${day.restingHrDeviation}</b>σ</div>`;
        if (day.sleepEfficiency != null)
          html += `<div>Sleep efficiency: <b>${day.sleepEfficiency}%</b></div>`;
        return html;
      },
    },
    legend: {
      data: ["Daily Stress", "Weekly Avg"],
      top: 0,
    },
    graphic: [
      {
        type: "text" as const,
        right: 10,
        top: 5,
        style: {
          text: `Today: ${formatNumber(latest)} ${latestStress.label} ${trendIcon(data.trend)}`,
          fill: latestColor,
          fontSize: 13,
          fontWeight: "bold" as const,
        },
      },
    ],
    xAxis: {
      type: "time" as const,
    },
    yAxis: [
      {
        type: "value" as const,
        name: "Stress (0-3)",
        min: 0,
        max: 3,
        interval: 1,
        splitLine: { lineStyle: { color: "#27272a" } },
        axisLabel: { color: "#71717a", fontSize: 11 },
        axisLine: { show: false },
        nameTextStyle: { color: "#71717a", fontSize: 11 },
      },
      {
        type: "value" as const,
        name: "Weekly",
        splitLine: { show: false },
        axisLabel: { color: "#71717a", fontSize: 11 },
        axisLine: { show: true, lineStyle: { color: "#3f3f46" } },
        nameTextStyle: { color: "#71717a", fontSize: 11 },
        position: "right" as const,
      },
    ],
    visualMap: {
      show: false,
      pieces: [
        { lte: 0.5, color: "#22c55e" },
        { gt: 0.5, lte: 1.5, color: "#eab308" },
        { gt: 1.5, lte: 2.5, color: "#f97316" },
        { gt: 2.5, color: "#ef4444" },
      ],
      seriesIndex: 0,
    },
    series: [
      {
        name: "Daily Stress",
        type: "bar",
        data: data.daily.map((d) => [d.date, d.stressScore]),
        barMaxWidth: 8,
        yAxisIndex: 0,
      },
      {
        name: "Weekly Avg",
        type: "line",
        data: data.weekly.map((w) => [w.weekStart, w.avgDailyStress]),
        smooth: true,
        symbol: "circle",
        symbolSize: 6,
        lineStyle: { color: "#a78bfa", width: 2 },
        itemStyle: { color: "#a78bfa" },
        yAxisIndex: 0,
      },
    ],
  });

  return (
    <div>
      {/* Trend badge */}
      <div className="flex items-center gap-2 mb-2">
        <span
          className="text-xs font-medium px-2 py-0.5 rounded"
          style={{ color: trendColor(data.trend), backgroundColor: `${trendColor(data.trend)}15` }}
        >
          {trendIcon(data.trend)}{" "}
          {data.trend === "improving"
            ? "Improving"
            : data.trend === "worsening"
              ? "Worsening"
              : "Stable"}
        </span>
        {data.weekly.length > 0 && (
          <span className="text-zinc-600 text-xs">
            This week: {formatNumber(data.weekly[data.weekly.length - 1]?.cumulativeStress ?? 0)}{" "}
            cumulative
          </span>
        )}
      </div>
      <ReactECharts option={option} style={{ height: 300 }} notMerge={true} />
    </div>
  );
}
