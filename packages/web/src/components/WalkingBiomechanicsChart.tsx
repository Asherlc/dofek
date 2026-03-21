import type { WalkingBiomechanicsRow } from "dofek-server/types";
import { dofekAxis, dofekGrid, dofekSeries, dofekTooltip } from "../lib/chartTheme.ts";
import { useUnitSystem } from "../lib/unitContext.ts";
import { convertHeight, convertSpeed, heightLabel, speedLabel } from "../lib/units.ts";
import { DofekChart } from "./DofekChart.tsx";

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
  convert?: (v: number) => number,
) {
  return {
    grid: dofekGrid("single", { top: 30, right: 15, bottom: 25 }),
    tooltip: dofekTooltip(),
    xAxis: dofekAxis.time({ axisLabel: { fontSize: 10 } }),
    yAxis: dofekAxis.value({ name: `${name} (${unit})`, axisLabel: { fontSize: 10 } }),
    series: [
      {
        ...dofekSeries.line(
          name,
          data.map((d) => {
            const v = valueAccessor(d);
            return [d.date, v != null && convert ? convert(v) : v];
          }),
          { color },
        ),
        connectNulls: true,
      },
    ],
  };
}

export function WalkingBiomechanicsChart({ data, loading }: WalkingBiomechanicsChartProps) {
  const { unitSystem } = useUnitSystem();

  if (loading) {
    return <DofekChart option={{}} loading={true} height={400} />;
  }

  if (data.length === 0) {
    return (
      <DofekChart
        option={{}}
        empty={true}
        height={100}
        emptyMessage="No walking biomechanics data available"
      />
    );
  }

  const charts: {
    name: string;
    unit: string;
    color: string;
    accessor: (d: WalkingBiomechanicsRow) => number | null;
    convert?: (v: number) => number;
  }[] = [
    {
      name: "Walking Speed",
      unit: speedLabel(unitSystem),
      color: "#22c55e",
      accessor: (d) => d.walkingSpeedKmh,
      convert: (v) => convertSpeed(v, unitSystem),
    },
    {
      name: "Step Length",
      unit: heightLabel(unitSystem),
      color: "#3b82f6",
      accessor: (d) => d.stepLengthCm,
      convert: (v) => convertHeight(v, unitSystem),
    },
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
      <h3 className="text-xs font-medium text-subtle mb-2">Walking Biomechanics</h3>
      <div className="grid grid-cols-2 gap-4">
        {charts.map((chart) => (
          <div key={chart.name} className="bg-surface-solid rounded-lg p-2">
            <DofekChart
              option={buildLineOption(
                data,
                chart.accessor,
                chart.name,
                chart.unit,
                chart.color,
                chart.convert,
              )}
              height={200}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
