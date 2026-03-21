import ReactECharts from "echarts-for-react";
import type { AdaptiveTdeeResult } from "../../../server/src/routers/nutrition-analytics.ts";
import { useUnitSystem } from "../lib/unitContext.ts";
import { convertWeight, weightLabel } from "../lib/units.ts";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface AdaptiveTdeeChartProps {
  data: AdaptiveTdeeResult | undefined;
  loading?: boolean;
}

export function AdaptiveTdeeChart({ data, loading }: AdaptiveTdeeChartProps) {
  const { unitSystem } = useUnitSystem();
  if (loading) {
    return <ChartLoadingSkeleton height={250} />;
  }

  if (!data || data.dailyData.length === 0) {
    return (
      <div className="flex items-center justify-center h-[250px]">
        <span className="text-dim text-sm">
          Need calorie tracking + weight measurements for TDEE estimation
        </span>
      </div>
    );
  }

  const tdeePoints = data.dailyData.filter((d) => d.estimatedTdee != null);

  const weightValues = data.dailyData
    .filter((d) => d.smoothedWeight != null)
    .map((d) => Number(d.smoothedWeight));
  const weightMin = Math.min(...weightValues);
  const weightMax = Math.max(...weightValues);
  const weightPadding = Math.max((weightMax - weightMin) * 0.3, 1);
  const weightAxisMin = Math.floor(weightMin - weightPadding);
  const weightAxisMax = Math.ceil(weightMax + weightPadding);

  return (
    <div className="space-y-3">
      {/* Summary stat */}
      {data.estimatedTdee != null && (
        <div className="flex items-baseline gap-3">
          <span className="text-2xl font-bold text-foreground">{data.estimatedTdee}</span>
          <span className="text-sm text-muted">kcal/day estimated TDEE</span>
          <span className="text-xs text-dim">
            ({Math.round(data.confidence * 100)}% confidence, {data.dataPoints} data points)
          </span>
        </div>
      )}

      <ReactECharts
        option={{
          backgroundColor: "transparent",
          grid: { top: 30, right: 50, bottom: 30, left: 50 },
          tooltip: {
            trigger: "axis",
            backgroundColor: "#ffffff",
            borderColor: "rgba(74, 158, 122, 0.2)",
            textStyle: { color: "#1a2e1a", fontSize: 12 },
          },
          legend: {
            top: 0,
            textStyle: { color: "#6b8a6b", fontSize: 11 },
          },
          xAxis: {
            type: "time",
            axisLabel: { color: "#6b8a6b", fontSize: 11 },
            axisLine: { lineStyle: { color: "rgba(74, 158, 122, 0.2)" } },
            splitLine: { show: false },
          },
          yAxis: [
            {
              type: "value",
              name: "kcal",
              axisLabel: { color: "#6b8a6b", fontSize: 11 },
              splitLine: { lineStyle: { color: "rgba(74, 158, 122, 0.12)" } },
              nameTextStyle: { color: "#6b8a6b", fontSize: 11 },
            },
            {
              type: "value",
              name: weightLabel(unitSystem),
              position: "right",
              min: weightValues.length > 0 ? weightAxisMin : undefined,
              max: weightValues.length > 0 ? weightAxisMax : undefined,
              axisLabel: { color: "#6b8a6b", fontSize: 11 },
              splitLine: { show: false },
              nameTextStyle: { color: "#6b8a6b", fontSize: 11 },
            },
          ],
          series: [
            {
              name: "Calories In",
              type: "line",
              data: data.dailyData
                .filter((d) => d.caloriesIn > 0)
                .map((d) => [d.date, d.caloriesIn]),
              smooth: true,
              symbol: "none",
              lineStyle: { color: "#3b82f6", width: 1, opacity: 0.5 },
              itemStyle: { color: "#3b82f6" },
            },
            {
              name: "Estimated TDEE",
              type: "line",
              data: tdeePoints.map((d) => [d.date, d.estimatedTdee]),
              smooth: true,
              symbol: "none",
              lineStyle: { color: "#f59e0b", width: 3 },
              itemStyle: { color: "#f59e0b" },
            },
            {
              name: "Smoothed Weight",
              type: "line",
              yAxisIndex: 1,
              data: data.dailyData
                .filter((d) => d.smoothedWeight != null)
                .map((d) => [
                  d.date,
                  d.smoothedWeight != null ? convertWeight(d.smoothedWeight, unitSystem) : null,
                ]),
              smooth: true,
              symbol: "none",
              lineStyle: { color: "#06b6d4", width: 2 },
              itemStyle: { color: "#06b6d4" },
            },
          ],
        }}
        style={{ height: 250 }}
      />
    </div>
  );
}
