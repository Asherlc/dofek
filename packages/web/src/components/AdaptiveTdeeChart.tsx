import ReactECharts from "echarts-for-react";
import type { AdaptiveTdeeResult } from "../../../server/src/routers/nutrition-analytics.ts";

interface AdaptiveTdeeChartProps {
  data: AdaptiveTdeeResult | undefined;
  loading?: boolean;
}

export function AdaptiveTdeeChart({ data, loading }: AdaptiveTdeeChartProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[250px]">
        <span className="text-zinc-600 text-sm">Loading...</span>
      </div>
    );
  }

  if (!data || data.dailyData.length === 0) {
    return (
      <div className="flex items-center justify-center h-[250px]">
        <span className="text-zinc-600 text-sm">
          Need calorie tracking + weight measurements for TDEE estimation
        </span>
      </div>
    );
  }

  const tdeePoints = data.dailyData.filter((d) => d.estimatedTdee != null);

  return (
    <div className="space-y-3">
      {/* Summary stat */}
      {data.estimatedTdee != null && (
        <div className="flex items-baseline gap-3">
          <span className="text-2xl font-bold text-zinc-100">{data.estimatedTdee}</span>
          <span className="text-sm text-zinc-400">kcal/day estimated TDEE</span>
          <span className="text-xs text-zinc-600">
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
            backgroundColor: "#18181b",
            borderColor: "#3f3f46",
            textStyle: { color: "#e4e4e7", fontSize: 12 },
          },
          legend: {
            top: 0,
            textStyle: { color: "#71717a", fontSize: 11 },
          },
          xAxis: {
            type: "time",
            axisLabel: { color: "#71717a", fontSize: 11 },
            axisLine: { lineStyle: { color: "#3f3f46" } },
            splitLine: { show: false },
          },
          yAxis: [
            {
              type: "value",
              name: "kcal",
              axisLabel: { color: "#71717a", fontSize: 11 },
              splitLine: { lineStyle: { color: "#27272a" } },
              nameTextStyle: { color: "#71717a", fontSize: 11 },
            },
            {
              type: "value",
              name: "kg",
              position: "right",
              axisLabel: { color: "#71717a", fontSize: 11 },
              splitLine: { show: false },
              nameTextStyle: { color: "#71717a", fontSize: 11 },
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
                .map((d) => [d.date, d.smoothedWeight]),
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
