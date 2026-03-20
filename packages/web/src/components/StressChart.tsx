import { stressColor, stressLabel, trendColor } from "@dofek/scoring/scoring";
import type { StressResult } from "dofek-server/types";
import ReactECharts from "echarts-for-react";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

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
  if (loading) {
    return <ChartLoadingSkeleton height={350} />;
  }

  if (!data || data.daily.length === 0) {
    return (
      <div className="flex items-center justify-center h-[350px]">
        <span className="text-zinc-600 text-sm">No stress data</span>
      </div>
    );
  }

  const latest = data.latestScore ?? 0;
  const latestColor = stressColor(latest);

  const option = {
    backgroundColor: "transparent",
    grid: { top: 50, right: 60, bottom: 40, left: 50 },
    tooltip: {
      trigger: "axis" as const,
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
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
        html += `<div>Stress: <b style="color:${stressColor(day.stressScore)}">${day.stressScore.toFixed(1)} (${stressLabel(day.stressScore)})</b></div>`;
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
      textStyle: { color: "#a1a1aa", fontSize: 11 },
      top: 0,
    },
    graphic: [
      {
        type: "text" as const,
        right: 10,
        top: 5,
        style: {
          text: `Today: ${latest.toFixed(1)} ${stressLabel(latest)} ${trendIcon(data.trend)}`,
          fill: latestColor,
          fontSize: 13,
          fontWeight: "bold" as const,
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
  };

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
            This week: {data.weekly[data.weekly.length - 1]?.cumulativeStress.toFixed(1)} cumulative
          </span>
        )}
      </div>
      <ReactECharts option={option} style={{ height: 300 }} notMerge={true} />
    </div>
  );
}
