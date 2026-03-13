import ReactECharts from "echarts-for-react";
import type { MicronutrientAdequacyRow } from "../../../server/src/routers/nutrition-analytics.ts";

interface MicronutrientChartProps {
  data: MicronutrientAdequacyRow[];
  loading?: boolean;
}

export function MicronutrientChart({ data, loading }: MicronutrientChartProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[300px]">
        <span className="text-zinc-600 text-sm">Loading...</span>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[300px]">
        <span className="text-zinc-600 text-sm">No micronutrient data available</span>
      </div>
    );
  }

  const sorted = [...data].sort((a, b) => a.percentRda - b.percentRda);

  const option = {
    backgroundColor: "transparent",
    grid: { top: 10, right: 60, bottom: 30, left: 120 },
    tooltip: {
      trigger: "axis" as const,
      axisPointer: { type: "shadow" as const },
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
      formatter: (params: Array<{ name: string; value: number; dataIndex: number }>) => {
        const p = params[0];
        if (!p) return "";
        const row = sorted[p.dataIndex];
        if (!row) return "";
        return `<b>${row.nutrient}</b><br/>
          ${row.avgIntake} ${row.unit} / ${row.rda} ${row.unit}<br/>
          <b>${row.percentRda}% of RDA</b><br/>
          <span style="color:#71717a">(${row.daysTracked} days tracked)</span>`;
      },
    },
    xAxis: {
      type: "value" as const,
      max: (value: { max: number }) => Math.max(value.max, 150),
      axisLabel: {
        color: "#71717a",
        fontSize: 11,
        formatter: (v: number) => `${v}%`,
      },
      splitLine: { lineStyle: { color: "#27272a" } },
    },
    yAxis: {
      type: "category" as const,
      data: sorted.map((d) => d.nutrient),
      axisLabel: { color: "#a1a1aa", fontSize: 11 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
    },
    series: [
      {
        type: "bar",
        data: sorted.map((d) => ({
          value: d.percentRda,
          itemStyle: {
            color:
              d.percentRda >= 100
                ? "#22c55e"
                : d.percentRda >= 75
                  ? "#eab308"
                  : d.percentRda >= 50
                    ? "#f97316"
                    : "#ef4444",
          },
        })),
        barWidth: "60%",
        label: {
          show: true,
          position: "right" as const,
          color: "#a1a1aa",
          fontSize: 11,
          formatter: (p: { value: number }) => `${p.value}%`,
        },
        markLine: {
          silent: true,
          symbol: "none",
          lineStyle: { color: "#3f3f46", type: "dashed" as const },
          data: [{ xAxis: 100 }],
          label: { show: true, position: "end" as const, formatter: "100% RDA", color: "#71717a" },
          tooltip: { show: false },
        },
      },
    ],
  };

  return <ReactECharts option={option} style={{ height: Math.max(300, sorted.length * 28) }} />;
}
