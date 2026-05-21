import { dofekAxis, dofekGrid, dofekLegend, dofekSeries, dofekTooltip } from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";

interface Series {
  name: string;
  data: [string, number | null][];
  color?: string;
  areaStyle?: boolean;
  yAxisIndex?: number;
  formatValue?: (value: number) => string;
}

/** Returns true when every value across all series is null or data is empty. */
export function isSeriesEmpty(series: Pick<Series, "data">[]): boolean {
  return series.every((s) => s.data.every(([, value]) => value == null));
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

  const seriesFormatters = new Map(series.map((item) => [item.name, item.formatValue]));

  const option = {
    tooltip: dofekTooltip({
      formatter: (
        params: {
          seriesName: string;
          value?: [string, number | null];
          data?: [string, number | null];
        }[],
      ) => {
        if (!params || params.length === 0) return "";
        const firstParam = params[0];
        const point = firstParam?.value ?? firstParam?.data;
        if (!point) return "";
        const date = new Date(point[0]).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        });
        const lines = params.flatMap((param) => {
          const dataPoint = param.value ?? param.data;
          const value = dataPoint?.[1];
          if (value == null) return [];
          const formatter = seriesFormatters.get(param.seriesName);
          const displayValue = formatter ? formatter(value) : String(value);
          return `${param.seriesName}: <b>${displayValue}</b>`;
        });
        return `<div style="font-weight:600;margin-bottom:4px">${date}</div>${lines.join("<br/>")}`;
      },
    }),
    xAxis: dofekAxis.time(),
    yAxis: yAxisConfig,
    grid: dofekGrid(hasDualAxis ? "dualAxis" : "single"),
    legend: dofekLegend(series.length > 1),
    series: series.map((s) =>
      dofekSeries.line(s.name, s.data, {
        color: s.color,
        areaStyle: s.areaStyle,
        yAxisIndex: s.yAxisIndex,
      }),
    ),
  };

  return (
    <DofekChart option={option} loading={loading} empty={isSeriesEmpty(series)} height={height} />
  );
}
