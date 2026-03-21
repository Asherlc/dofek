import type { VolumeOverTimeRow } from "dofek-server/types";
import ReactECharts from "echarts-for-react";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface StrengthVolumeChartProps {
  data: VolumeOverTimeRow[];
  loading?: boolean;
}

export function StrengthVolumeChart({ data, loading }: StrengthVolumeChartProps) {
  if (loading) {
    return <ChartLoadingSkeleton height={280} />;
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[280px]">
        <span className="text-dim text-sm">No strength volume data</span>
      </div>
    );
  }

  const option = {
    backgroundColor: "transparent",
    grid: { top: 30, right: 20, bottom: 40, left: 60 },
    tooltip: {
      trigger: "axis",
      backgroundColor: "#ffffff",
      borderColor: "rgba(74, 158, 122, 0.2)",
      textStyle: { color: "#1a2e1a", fontSize: 12 },
      formatter(params: { dataIndex: number }[]) {
        const first = params[0];
        if (!first) return "";
        const index = first.dataIndex;
        const d = data[index];
        if (!d) return "";
        const dateLabel = new Date(d.week).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        return `<strong>${dateLabel ?? ""}</strong><br/>
          Volume: ${Math.round(d.totalVolumeKg).toLocaleString()} kg<br/>
          Sets: ${d.setCount}`;
      },
    },
    xAxis: {
      type: "time" as const,
      axisLabel: { color: "#6b8a6b", fontSize: 11 },
      axisLine: { lineStyle: { color: "rgba(74, 158, 122, 0.2)" } },
    },
    yAxis: {
      type: "value",
      name: "Volume (kg)",
      nameTextStyle: { color: "#6b8a6b", fontSize: 11 },
      axisLabel: {
        color: "#6b8a6b",
        fontSize: 11,
        formatter(value: number) {
          return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
        },
      },
      splitLine: { lineStyle: { color: "rgba(74, 158, 122, 0.12)" } },
    },
    series: [
      {
        name: "Volume",
        type: "bar",
        data: data.map((d) => [d.week, d.totalVolumeKg]),
        itemStyle: {
          color: "#10b981",
          borderRadius: [4, 4, 0, 0],
        },
        emphasis: {
          itemStyle: { color: "#34d399" },
        },
      },
    ],
  };

  return <ReactECharts option={option} style={{ height: 280 }} />;
}
