import ReactECharts from "echarts-for-react";
import type { MicronutrientAdequacyRow } from "../../../server/src/routers/nutrition-analytics.ts";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface MicronutrientChartProps {
  data: MicronutrientAdequacyRow[];
  loading?: boolean;
}

export function MicronutrientChart({ data, loading }: MicronutrientChartProps) {
  if (loading) {
    return <ChartLoadingSkeleton height={300} />;
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[300px]">
        <span className="text-dim text-sm">No micronutrient data available</span>
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
      backgroundColor: "#ffffff",
      borderColor: "rgba(74, 158, 122, 0.2)",
      textStyle: { color: "#1a2e1a", fontSize: 12 },
      formatter: (params: Array<{ name: string; value: number; dataIndex: number }>) => {
        const p = params[0];
        if (!p) return "";
        const row = sorted[p.dataIndex];
        if (!row) return "";
        return `<b>${row.nutrient}</b><br/>
          ${row.avgIntake} ${row.unit} / ${row.rda} ${row.unit}<br/>
          <b>${row.percentRda}% of RDA</b><br/>
          <span style="color:#6b8a6b">(${row.daysTracked} days tracked)</span>`;
      },
    },
    xAxis: {
      type: "value" as const,
      max: (value: { max: number }) => Math.max(value.max, 150),
      axisLabel: {
        color: "#6b8a6b",
        fontSize: 11,
        formatter: (v: number) => `${v}%`,
      },
      splitLine: { lineStyle: { color: "rgba(74, 158, 122, 0.12)" } },
    },
    yAxis: {
      type: "category" as const,
      data: sorted.map((d) => d.nutrient),
      axisLabel: { color: "#4a6a4a", fontSize: 11 },
      axisLine: { lineStyle: { color: "rgba(74, 158, 122, 0.2)" } },
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
          color: "#4a6a4a",
          fontSize: 11,
          formatter: (p: { value: number }) => `${p.value}%`,
        },
        markLine: {
          silent: true,
          symbol: "none",
          lineStyle: { color: "rgba(74, 158, 122, 0.2)", type: "dashed" as const },
          data: [{ xAxis: 100 }],
          label: { show: true, position: "end" as const, formatter: "100% RDA", color: "#6b8a6b" },
          tooltip: { show: false },
        },
      },
    ],
  };

  return <ReactECharts option={option} style={{ height: Math.max(300, sorted.length * 28) }} />;
}
