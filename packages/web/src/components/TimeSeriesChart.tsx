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

const MAX_MISSING_DAY_MARKERS = 60;

interface Series {
  name: string;
  data: [string, number | null][];
  accessibilityDescription?: string;
  color?: string;
  areaStyle?: boolean;
  missingDates?: string[];
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
  accessibilityDescription?: string;
  height?: number;
  yAxis?: { name?: string; min?: number | "dataMin"; max?: number | "dataMax" }[];
  loading?: boolean;
}

export function TimeSeriesChart({
  series,
  accessibilityDescription,
  height = 200,
  yAxis,
  loading,
}: TimeSeriesChartProps) {
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
  const seriesDescription = series
    .map(
      (item) =>
        item.accessibilityDescription ??
        (item.visualization === "point"
          ? `${item.name} is shown as separate points.`
          : `${item.name} is shown as a numeric line.`),
    )
    .join(" ");
  const chartAccessibilityDescription = `Time series chart. ${accessibilityDescription ? `${accessibilityDescription} ` : ""}${seriesDescription}`;

  const option = {
    aria: {
      enabled: true,
      label: {
        description: chartAccessibilityDescription,
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
      const missingDayMarkers =
        s.missingDates &&
        s.missingDates.length > 0 &&
        s.missingDates.length <= MAX_MISSING_DAY_MARKERS
          ? {
              markLine: {
                symbol: ["none", "none"],
                silent: true,
                label: { show: false },
                lineStyle: { type: "dotted", opacity: 0.35 },
                data: s.missingDates.map((date) => ({ xAxis: date })),
              },
            }
          : {};
      if (s.visualization === "point") {
        return {
          ...dofekSeries.scatter(s.name, s.data, {
            color: s.color,
            symbolSize: 10,
            yAxisIndex: s.yAxisIndex,
          }),
          ...missingDayMarkers,
        };
      }
      return {
        ...dofekSeries.line(s.name, s.data, {
          color: s.color,
          areaStyle: s.areaStyle,
          yAxisIndex: s.yAxisIndex,
        }),
        ...missingDayMarkers,
      };
    }),
  };

  return (
    <DofekChart option={option} loading={loading} empty={isSeriesEmpty(series)} height={height} />
  );
}
