import ReactECharts from "echarts-for-react";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface SleepData {
  started_at: string;
  duration_minutes: number | null;
  deep_minutes: number | null;
  rem_minutes: number | null;
  light_minutes: number | null;
  awake_minutes: number | null;
}

interface SleepChartProps {
  data: SleepData[];
  loading?: boolean;
}

export function SleepChart({ data, loading }: SleepChartProps) {
  if (loading) {
    return <ChartLoadingSkeleton height={250} />;
  }

  const option = {
    backgroundColor: "transparent",
    grid: { top: 30, right: 20, bottom: 40, left: 50 },
    tooltip: {
      trigger: "axis",
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
      formatter: (
        params: { seriesName: string; value: [string, number | null]; color: string }[],
      ) => {
        if (!params.length) return "";
        const firstParam = params[0];
        if (!firstParam) return "";
        const date = new Date(firstParam.value[0]).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        let total = 0;
        const lines = params.map((p) => {
          const val = p.value[1] ?? 0;
          total += val;
          return `<span style="color:${p.color}">\u25CF</span> ${p.seriesName}: ${val}m`;
        });
        return `<strong>${date}</strong> (${Math.floor(total / 60)}h ${total % 60}m)<br/>${lines.join("<br/>")}`;
      },
    },
    xAxis: {
      type: "time" as const,
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
    },
    yAxis: {
      type: "value",
      name: "minutes",
      splitLine: { lineStyle: { color: "#27272a" } },
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { show: false },
      nameTextStyle: { color: "#71717a", fontSize: 11 },
    },
    legend: {
      textStyle: { color: "#a1a1aa", fontSize: 11 },
      top: 0,
    },
    series: [
      {
        name: "Deep",
        type: "bar",
        stack: "sleep",
        data: data.map((d) => [d.started_at, d.deep_minutes]),
        itemStyle: { color: "#6366f1" },
      },
      {
        name: "REM",
        type: "bar",
        stack: "sleep",
        data: data.map((d) => [d.started_at, d.rem_minutes]),
        itemStyle: { color: "#8b5cf6" },
      },
      {
        name: "Light",
        type: "bar",
        stack: "sleep",
        data: data.map((d) => [d.started_at, d.light_minutes]),
        itemStyle: { color: "#a78bfa" },
      },
      {
        name: "Awake",
        type: "bar",
        stack: "sleep",
        data: data.map((d) => [d.started_at, d.awake_minutes]),
        itemStyle: { color: "#f87171" },
      },
    ],
  };

  return <ReactECharts option={option} style={{ height: 250 }} notMerge={true} />;
}
