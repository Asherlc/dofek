import type { AerobicEfficiencyActivity } from "dofek-server/types";
import {
  chartColors,
  chartThemeColors,
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
} from "../lib/chartTheme.ts";
import { formatNumber } from "../lib/format.ts";
import { DofekChart } from "./DofekChart.tsx";

const ACTIVITY_COLORS: Record<string, string> = {
  cycling: chartColors.orange,
  running: chartColors.green,
  walking: chartColors.purple,
  swimming: chartColors.blue,
  hiking: "#a3e635",
  yoga: "#c084fc",
  strength_training: "#ef4444",
};

function getActivityColor(type: string): string {
  return ACTIVITY_COLORS[type.toLowerCase()] ?? chartThemeColors.axisLabel;
}

interface AerobicEfficiencyChartProps {
  activities: AerobicEfficiencyActivity[];
  maxHr: number | null;
  loading?: boolean;
}

/** Simple linear regression returning slope and intercept. */
function linearRegression(points: [number, number][]): { slope: number; intercept: number } {
  const count = points.length;
  if (count < 2) return { slope: 0, intercept: 0 };

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

  const denom = count * sumXX - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / count };

  const slope = (count * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / count;
  return { slope, intercept };
}

export function AerobicEfficiencyChart({
  activities,
  maxHr,
  loading,
}: AerobicEfficiencyChartProps) {
  if (loading) {
    return (
      <DofekChart
        option={{}}
        loading={true}
        height={280}
        emptyMessage="No activities with sufficient Zone 2 power + heart rate data"
      />
    );
  }

  if (activities.length === 0) {
    return (
      <DofekChart
        option={{}}
        empty={true}
        height={280}
        emptyMessage="No activities with sufficient Zone 2 power + heart rate data"
      />
    );
  }

  // Group by activity type for coloring
  const typeSet = [...new Set(activities.map((a) => a.activityType))];

  const scatterSeries = typeSet.map((type) => ({
    ...dofekSeries.scatter(
      type,
      activities
        .filter((a) => a.activityType === type)
        .map((a) => ({
          value: [a.date, a.efficiencyFactor],
          name: a.name,
          avgPower: a.avgPowerZ2,
          avgHr: a.avgHrZ2,
          z2Samples: a.z2Samples,
        })),
      { color: getActivityColor(type), symbolSize: 10, itemStyle: { opacity: 1 } },
    ),
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
    grid: dofekGrid("single", { top: 40, left: 55 }),
    tooltip: dofekTooltip({
      trigger: "item",
      formatter: (params: Record<string, unknown>) => {
        const data = params.data;
        if (
          !data ||
          typeof data !== "object" ||
          !("name" in data) ||
          !("value" in data) ||
          !("avgPower" in data) ||
          !("avgHr" in data) ||
          !("z2Samples" in data)
        )
          return "";
        const value = Array.isArray(data.value) ? data.value : [];
        const date = String(value[0] ?? "");
        const ef = typeof value[1] === "number" ? value[1] : 0;
        const z2Samples = typeof data.z2Samples === "number" ? data.z2Samples : 0;
        const mins = Math.round(z2Samples / 60);
        return [
          `<strong>${String(data.name)}</strong>`,
          `Date: ${date}`,
          `Efficiency: ${formatNumber(ef, 3)} W/bpm`,
          `Avg Power (Zone 2): ${String(data.avgPower)}W`,
          `Avg Heart Rate (Zone 2): ${String(data.avgHr)} bpm`,
          `Zone 2 time: ${mins} min`,
        ].join("<br/>");
      },
    }),
    xAxis: dofekAxis.time(),
    yAxis: dofekAxis.value({ name: "Efficiency Factor (W/bpm)" }),
    legend: dofekLegend(true),
    series: [
      ...scatterSeries,
      {
        ...dofekSeries.line("Trend", trendData, {
          color: chartThemeColors.legendText,
          smooth: false,
          lineStyle: { type: "dashed" },
        }),
        tooltip: { show: false },
      },
    ],
  };

  return (
    <div>
      <h3 className="text-xs font-medium text-subtle mb-2">
        Aerobic Efficiency (Power / Heart Rate in Zone 2)
        {maxHr && <span className="text-dim ml-2">(max heart rate: {maxHr} bpm)</span>}
        <span
          className={`ml-2 ${trendDirection === "improving" ? "text-green-500" : trendDirection === "declining" ? "text-red-400" : "text-subtle"}`}
        >
          Trend: {trendDirection}
        </span>
      </h3>
      <DofekChart option={option} height={280} />
      <p className="text-xs text-dim mt-1">
        Higher efficiency = better aerobic fitness. Each dot is one activity with 5+ min of Zone 2
        data (60-70% max heart rate).
      </p>
    </div>
  );
}
