import type { AerobicEfficiencyActivity } from "dofek-server/types";
import ReactECharts from "echarts-for-react";

const ACTIVITY_COLORS: Record<string, string> = {
  cycling: "#f97316",
  running: "#22c55e",
  walking: "#8b5cf6",
  swimming: "#3b82f6",
  hiking: "#a3e635",
  yoga: "#c084fc",
  strength_training: "#ef4444",
};

function getActivityColor(type: string): string {
  return ACTIVITY_COLORS[type.toLowerCase()] ?? "#71717a";
}

interface AerobicEfficiencyChartProps {
  activities: AerobicEfficiencyActivity[];
  maxHr: number | null;
  loading?: boolean;
}

/** Simple linear regression returning slope and intercept. */
function linearRegression(points: [number, number][]): { slope: number; intercept: number } {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: 0 };

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;

  for (const [x, y] of points) {
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }

  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n };

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

export function AerobicEfficiencyChart({
  activities,
  maxHr,
  loading,
}: AerobicEfficiencyChartProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[280px]">
        <span className="text-zinc-600 text-sm">Loading efficiency data...</span>
      </div>
    );
  }

  if (activities.length === 0) {
    return (
      <div className="flex items-center justify-center h-[100px]">
        <span className="text-zinc-600 text-sm">
          No activities with sufficient Zone 2 power + heart rate data
        </span>
      </div>
    );
  }

  // Group by activity type for coloring
  const typeSet = [...new Set(activities.map((a) => a.activityType))];

  const scatterSeries = typeSet.map((type) => ({
    name: type,
    type: "scatter" as const,
    data: activities
      .filter((a) => a.activityType === type)
      .map((a) => ({
        value: [a.date, a.efficiencyFactor],
        name: a.name,
        avgPower: a.avgPowerZ2,
        avgHr: a.avgHrZ2,
        z2Samples: a.z2Samples,
      })),
    symbolSize: 10,
    itemStyle: { color: getActivityColor(type) },
  }));

  // Compute trend line across all activities
  const timestamps = activities.map((a) => new Date(a.date).getTime());
  const minTime = Math.min(...timestamps);
  const maxTime = Math.max(...timestamps);
  const points: [number, number][] = activities.map((a) => [
    new Date(a.date).getTime(),
    a.efficiencyFactor,
  ]);
  const { slope, intercept } = linearRegression(points);

  const trendData = [
    [new Date(minTime).toISOString().slice(0, 10), slope * minTime + intercept],
    [new Date(maxTime).toISOString().slice(0, 10), slope * maxTime + intercept],
  ];

  const trendDirection = slope > 0 ? "improving" : slope < 0 ? "declining" : "flat";

  const option = {
    backgroundColor: "transparent",
    grid: { top: 40, right: 20, bottom: 30, left: 55 },
    tooltip: {
      trigger: "item",
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
      formatter: (params: Record<string, unknown>) => {
        // @ts-expect-error ECharts params.data is typed as unknown
        const data:
          | {
              value: [string, number];
              name: string;
              avgPower: number;
              avgHr: number;
              z2Samples: number;
            }
          | undefined = params.data;
        if (!data?.name) return "";
        const [date, ef] = data.value;
        const mins = Math.round(data.z2Samples / 60);
        return [
          `<strong>${data.name}</strong>`,
          `Date: ${date}`,
          `Efficiency: ${ef.toFixed(3)} W/bpm`,
          `Avg Power (Zone 2): ${data.avgPower}W`,
          `Avg Heart Rate (Zone 2): ${data.avgHr} bpm`,
          `Zone 2 time: ${mins} min`,
        ].join("<br/>");
      },
    },
    xAxis: {
      type: "time",
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      name: "Efficiency Factor (W/bpm)",
      splitLine: { lineStyle: { color: "#27272a" } },
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { show: true, lineStyle: { color: "#3f3f46" } },
      nameTextStyle: { color: "#71717a", fontSize: 11 },
    },
    legend: {
      textStyle: { color: "#a1a1aa", fontSize: 11 },
      top: 0,
    },
    series: [
      ...scatterSeries,
      {
        name: "Trend",
        type: "line",
        data: trendData,
        symbol: "none",
        lineStyle: { color: "#a1a1aa", width: 2, type: "dashed" as const },
        itemStyle: { color: "#a1a1aa" },
        tooltip: { show: false },
      },
    ],
  };

  return (
    <div>
      <h3 className="text-xs font-medium text-zinc-500 mb-2">
        Aerobic Efficiency (Power / Heart Rate in Zone 2)
        {maxHr && <span className="text-zinc-700 ml-2">(max heart rate: {maxHr} bpm)</span>}
        <span
          className={`ml-2 ${trendDirection === "improving" ? "text-green-500" : trendDirection === "declining" ? "text-red-400" : "text-zinc-500"}`}
        >
          Trend: {trendDirection}
        </span>
      </h3>
      <ReactECharts option={option} style={{ height: 280 }} notMerge={true} />
      <p className="text-xs text-zinc-700 mt-1">
        Higher efficiency = better aerobic fitness. Each dot is one activity with 5+ min of Zone 2
        data (60-70% max heart rate).
      </p>
    </div>
  );
}
