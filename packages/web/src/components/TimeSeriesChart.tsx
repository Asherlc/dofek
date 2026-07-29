import { formatDateShort } from "@dofek/format/format";
import {
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
  escapeTooltipHtml,
} from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";

interface Series {
  name: string;
  data: [string, number | null][];
  accessibilityDescription?: string;
  color?: string;
  areaStyle?: boolean;
  yAxisIndex?: number;
  formatValue?: (value: number) => string;
  visualization?: "line" | "point";
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
  const accessibilityDescription = `Time series chart. ${series
    .map(
      (item) =>
        item.accessibilityDescription ??
        (item.visualization === "point"
          ? `${item.name} is shown as separate points.`
          : `${item.name} is shown as a numeric line.`),
    )
    .join(" ")}`;

  const option = {
    aria: {
      enabled: true,
      label: {
        description: accessibilityDescription,
      },
    },
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
        const date = escapeTooltipHtml(formatDateShort(point[0]));
        const lines = params.flatMap((param) => {
          const dataPoint = param.value ?? param.data;
          const value = dataPoint?.[1];
          if (value == null) return [];
          const formatter = seriesFormatters.get(param.seriesName);
          const displayValue = formatter ? formatter(value) : String(value);
          return `${escapeTooltipHtml(param.seriesName)}: <b>${escapeTooltipHtml(displayValue)}</b>`;
        });
        return `<div style="font-weight:600;margin-bottom:4px">${date}</div>${lines.join("<br/>")}`;
      },
    }),
    xAxis: dofekAxis.time(),
    yAxis: yAxisConfig,
    grid: dofekGrid(hasDualAxis ? "dualAxis" : "single"),
    legend: dofekLegend(series.length > 1),
    series: series.map((s) => {
      if (s.visualization === "point") {
        return dofekSeries.scatter(s.name, s.data, {
          color: s.color,
          symbolSize: 10,
          yAxisIndex: s.yAxisIndex,
        });
      }
      return dofekSeries.line(s.name, s.data, {
        color: s.color,
        areaStyle: s.areaStyle,
        yAxisIndex: s.yAxisIndex,
      });
    }),
  };

  return (
    <DofekChart option={option} loading={loading} empty={isSeriesEmpty(series)} height={height} />
  );
}
