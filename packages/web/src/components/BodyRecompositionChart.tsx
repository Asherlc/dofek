import ReactECharts from "echarts-for-react";
import type { BodyRecompositionRow } from "../../../server/src/routers/body-analytics.ts";
import { useUnitSystem } from "../lib/unitContext.ts";
import { convertWeight, weightLabel } from "../lib/units.ts";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface BodyRecompositionChartProps {
  data: BodyRecompositionRow[];
  loading?: boolean;
}

export function BodyRecompositionChart({ data, loading }: BodyRecompositionChartProps) {
  const { unitSystem } = useUnitSystem();
  if (loading) {
    return <ChartLoadingSkeleton height={250} />;
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[250px]">
        <span className="text-dim text-sm">
          Need weight + body fat data for recomposition tracking
        </span>
      </div>
    );
  }

  // Compute change from first to last
  const first = data[0];
  const last = data[data.length - 1];
  if (!first || !last) {
    return null;
  }
  const fatChange = last.smoothedFatMass - first.smoothedFatMass;
  const leanChange = last.smoothedLeanMass - first.smoothedLeanMass;

  const option = {
    backgroundColor: "transparent",
    grid: { top: 30, right: 12, bottom: 30, left: 50 },
    tooltip: {
      trigger: "axis" as const,
      backgroundColor: "#ffffff",
      borderColor: "rgba(74, 158, 122, 0.2)",
      textStyle: { color: "#1a2e1a", fontSize: 12 },
    },
    legend: {
      top: 0,
      textStyle: { color: "#6b8a6b", fontSize: 11 },
    },
    xAxis: {
      type: "time" as const,
      axisLabel: { color: "#6b8a6b", fontSize: 11 },
      axisLine: { lineStyle: { color: "rgba(74, 158, 122, 0.25)" } },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value" as const,
      name: weightLabel(unitSystem),
      axisLabel: { color: "#6b8a6b", fontSize: 11 },
      splitLine: { lineStyle: { color: "rgba(74, 158, 122, 0.12)" } },
      nameTextStyle: { color: "#6b8a6b", fontSize: 11 },
    },
    series: [
      {
        name: "Fat Mass (smoothed)",
        type: "line",
        data: data.map((d) => [d.date, convertWeight(d.smoothedFatMass, unitSystem)]),
        smooth: true,
        symbol: "none",
        lineStyle: { color: "#f97316", width: 2 },
        itemStyle: { color: "#f97316" },
        areaStyle: { color: "rgba(249,115,22,0.1)" },
      },
      {
        name: "Lean Mass (smoothed)",
        type: "line",
        data: data.map((d) => [d.date, convertWeight(d.smoothedLeanMass, unitSystem)]),
        smooth: true,
        symbol: "none",
        lineStyle: { color: "#3b82f6", width: 2 },
        itemStyle: { color: "#3b82f6" },
        areaStyle: { color: "rgba(59,130,246,0.1)" },
      },
    ],
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-4 text-sm">
        <span className={`font-medium ${fatChange <= 0 ? "text-green-400" : "text-red-400"}`}>
          Fat: {fatChange > 0 ? "+" : ""}
          {convertWeight(fatChange, unitSystem).toFixed(1)} {weightLabel(unitSystem)}
        </span>
        <span className={`font-medium ${leanChange >= 0 ? "text-green-400" : "text-red-400"}`}>
          Lean: {leanChange > 0 ? "+" : ""}
          {convertWeight(leanChange, unitSystem).toFixed(1)} {weightLabel(unitSystem)}
        </span>
      </div>
      <ReactECharts option={option} style={{ height: 250 }} />
    </div>
  );
}
