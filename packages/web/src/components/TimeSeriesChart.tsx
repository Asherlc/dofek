import { dofekAxis, dofekGrid, dofekLegend, dofekSeries, dofekTooltip } from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";

interface Series {
  name: string;
  data: [string, number | null][];
  color?: string;
  areaStyle?: boolean;
  yAxisIndex?: number;
}

interface TimeSeriesChartProps {
  series: Series[];
  height?: number;
  yAxis?: { name?: string; min?: number | "dataMin"; max?: number | "dataMax" }[];
  loading?: boolean;
}

export function TimeSeriesChart({ series, height = 200, yAxis, loading }: TimeSeriesChartProps) {
  const yAxisConfig = (yAxis ?? [{}]).map((axis, i) =>
    dofekAxis.value({
      name: axis.name,
      min: axis.min,
      max: axis.max,
      position: i === 0 ? "left" : "right",
      showSplitLine: i === 0,
    }),
  );

  const hasDualAxis = yAxisConfig.length > 1;

  const option = {
    tooltip: dofekTooltip(),
    xAxis: dofekAxis.time(),
    yAxis: yAxisConfig,
    grid: dofekGrid(hasDualAxis ? "dualAxis" : "single"),
    legend: dofekLegend(series.length > 1),
    series: series.map((s) =>
      dofekSeries.line(
        s.name,
        s.data.filter(([, v]) => v != null),
        { color: s.color, areaStyle: s.areaStyle, yAxisIndex: s.yAxisIndex },
      ),
    ),
  };

  return <DofekChart option={option} loading={loading} height={height} />;
}
