import ReactECharts from "echarts-for-react";

export interface StrengthVolumeData {
  week: string;
  totalVolumeKg: number;
  setCount: number;
}

interface StrengthVolumeChartProps {
  data: StrengthVolumeData[];
  loading?: boolean;
}

export function StrengthVolumeChart({ data, loading }: StrengthVolumeChartProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[280px]">
        <span className="text-zinc-600 text-sm">Loading...</span>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[280px]">
        <span className="text-zinc-600 text-sm">No strength volume data</span>
      </div>
    );
  }

  const weeks = data.map((d) =>
    new Date(d.week).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
  );

  const option = {
    backgroundColor: "transparent",
    grid: { top: 30, right: 20, bottom: 40, left: 60 },
    tooltip: {
      trigger: "axis",
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
      formatter(params: { dataIndex: number }[]) {
        const index = params[0].dataIndex;
        const d = data[index];
        return `<strong>${weeks[index]}</strong><br/>
          Volume: ${Math.round(d.totalVolumeKg).toLocaleString()} kg<br/>
          Sets: ${d.setCount}`;
      },
    },
    xAxis: {
      type: "category",
      data: weeks,
      axisLabel: { color: "#71717a", fontSize: 11, rotate: 45 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
    },
    yAxis: {
      type: "value",
      name: "Volume (kg)",
      nameTextStyle: { color: "#71717a", fontSize: 11 },
      axisLabel: {
        color: "#71717a",
        fontSize: 11,
        formatter(value: number) {
          return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
        },
      },
      splitLine: { lineStyle: { color: "#27272a" } },
    },
    series: [
      {
        name: "Volume",
        type: "bar",
        data: data.map((d) => d.totalVolumeKg),
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
