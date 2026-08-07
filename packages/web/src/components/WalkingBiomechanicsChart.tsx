import { chartColors, statusColors } from "@dofek/scoring/colors";
import type { WalkingBiomechanicsRow } from "dofek-server/types";
import { dofekAxis, dofekGrid, dofekSeries, dofekTooltip } from "../lib/chartTheme.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
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
  const signalPointCount = data.filter((row) => valueAccessor(row) != null).length;

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
            const value = valueAccessor(d);
            return [d.date, value != null && convert ? convert(value) : value];
          }),
          {
            color,
            symbol: signalPointCount === 1 ? "circle" : undefined,
            symbolSize: signalPointCount === 1 ? 6 : undefined,
          },
        ),
        connectNulls: true,
      },
    ],
  };
}

export function WalkingBiomechanicsChart({ data, loading }: WalkingBiomechanicsChartProps) {
  const units = useUnitConverter();

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
    emptyMessage: string;
    accessor: (d: WalkingBiomechanicsRow) => number | null;
    convert?: (v: number) => number;
  }[] = [
    {
      name: "Walking Speed",
      unit: units.speedLabel,
      color: statusColors.positive,
      emptyMessage: "No walking speed data available",
      accessor: (d) => d.walkingSpeedKmh,
      convert: (v) => units.convertSpeed(v),
    },
    {
      name: "Step Length",
      unit: units.heightLabel,
      color: chartColors.blue,
      emptyMessage: "No step length data available",
      accessor: (d) => d.stepLengthCm,
      convert: (v) => units.convertHeight(v),
    },
    {
      name: "Double Support",
      unit: units.percentageLabel,
      color: chartColors.amber,
      emptyMessage: "No double support data available",
      accessor: (d) => d.doubleSupportPct,
    },
    {
      name: "Asymmetry",
      unit: units.percentageLabel,
      color: statusColors.danger,
      emptyMessage: "No asymmetry data available",
      accessor: (d) => d.asymmetryPct,
    },
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
              empty={!data.some((row) => chart.accessor(row) != null)}
              emptyMessage={chart.emptyMessage}
              height={200}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
