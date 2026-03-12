import type { WalkingBiomechanicsRow } from "dofek-server/types";
import ReactECharts from "echarts-for-react";

interface WalkingBiomechanicsChartProps {
  data: WalkingBiomechanicsRow[];
  loading?: boolean;
}

function buildLineOption(
  data: WalkingBiomechanicsRow[],
  valueAccessor: (d: WalkingBiomechanicsRow) => number | null,
  name: string,
  unit: string,
  color: string,
) {
  return {
    backgroundColor: "transparent",
    grid: { top: 30, right: 15, bottom: 25, left: 50 },
    tooltip: {
      trigger: "axis",
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
    },
    xAxis: {
      type: "time" as const,
      axisLabel: { color: "#71717a", fontSize: 10 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      name: `${name} (${unit})`,
      splitLine: { lineStyle: { color: "#27272a" } },
      axisLabel: { color: "#71717a", fontSize: 10 },
      axisLine: { show: true, lineStyle: { color: "#3f3f46" } },
      nameTextStyle: { color: "#71717a", fontSize: 10 },
    },
    series: [
      {
        type: "line",
        data: data.map((d) => [d.date, valueAccessor(d)]),
        smooth: true,
        symbol: "none",
        lineStyle: { color, width: 2 },
        itemStyle: { color },
        connectNulls: true,
      },
    ],
  };
}

export function WalkingBiomechanicsChart({ data, loading }: WalkingBiomechanicsChartProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[400px]">
        <span className="text-zinc-600 text-sm">Loading biomechanics data...</span>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[100px]">
        <span className="text-zinc-600 text-sm">No walking biomechanics data available</span>
      </div>
    );
  }

  const charts: {
    name: string;
    unit: string;
    color: string;
    accessor: (d: WalkingBiomechanicsRow) => number | null;
  }[] = [
    { name: "Walking Speed", unit: "km/h", color: "#22c55e", accessor: (d) => d.walkingSpeedKmh },
    { name: "Step Length", unit: "cm", color: "#3b82f6", accessor: (d) => d.stepLengthCm },
    {
      name: "Double Support",
      unit: "%",
      color: "#f59e0b",
      accessor: (d) => d.doubleSupportPct,
    },
    { name: "Asymmetry", unit: "%", color: "#ef4444", accessor: (d) => d.asymmetryPct },
  ];

  return (
    <div>
      <h3 className="text-xs font-medium text-zinc-500 mb-2">Walking Biomechanics</h3>
      <div className="grid grid-cols-2 gap-4">
        {charts.map((chart) => (
          <div key={chart.name} className="bg-zinc-900 rounded-lg p-2">
            <ReactECharts
              option={buildLineOption(data, chart.accessor, chart.name, chart.unit, chart.color)}
              style={{ height: 200 }}
              notMerge={true}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
