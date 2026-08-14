import { formatBodyCompositionNumber, formatDateShort } from "@dofek/format/format";
import type {
  BodyFatPrediction,
  SmoothedBodyFatRow,
} from "../../../server/src/routers/body-analytics.ts";
import {
  chartColors,
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
  escapeTooltipHtml,
} from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";

interface BodyFatPercentageChartProps {
  data: SmoothedBodyFatRow[];
  prediction?: BodyFatPrediction | null;
  loading?: boolean;
}

interface BodyFatTooltipParam {
  seriesName?: string;
  marker?: string;
  data?: unknown;
}

function isBodyFatDataPoint(value: unknown): value is [string, number] {
  return Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "number";
}

export function BodyFatPercentageChart({ data, prediction, loading }: BodyFatPercentageChartProps) {
  if (data.length < 2) {
    return (
      <DofekChart
        option={{}}
        loading={loading}
        empty={true}
        emptyMessage="Need at least two body-fat readings in this range to show a body-fat trend"
      />
    );
  }

  const option = {
    grid: dofekGrid("single", { left: 50 }),
    tooltip: dofekTooltip({
      formatter: (params: BodyFatTooltipParam[]) => {
        if (!params || params.length === 0) return "";
        const firstDataPoint = params.find((param) => isBodyFatDataPoint(param.data))?.data;
        if (!isBodyFatDataPoint(firstDataPoint)) return "";

        const date = escapeTooltipHtml(formatDateShort(firstDataPoint[0]));
        const lines = params.flatMap((param) => {
          if (!isBodyFatDataPoint(param.data)) return [];
          const marker = typeof param.marker === "string" ? param.marker : "";
          const seriesName = escapeTooltipHtml(param.seriesName ?? "");
          const displayValue = escapeTooltipHtml(`${formatBodyCompositionNumber(param.data[1])}%`);
          return `${marker}${seriesName} <b>${displayValue}</b>`;
        });
        return `<div style="font-weight:600;margin-bottom:4px">${date}</div>${lines.join("<br/>")}`;
      },
    }),
    legend: dofekLegend(true),
    xAxis: dofekAxis.time(),
    yAxis: dofekAxis.value({ name: "%" }),
    series: [
      dofekSeries.scatter(
        "Raw Body Fat",
        data.flatMap((row) =>
          row.rawBodyFatPct == null
            ? []
            : [[row.date, row.rawBodyFatPct] satisfies [string, number]],
        ),
        { color: chartColors.purple, symbolSize: 4, itemStyle: { opacity: 0.5 } },
      ),
      dofekSeries.line(
        "Trend Body Fat",
        data.map((row) => [row.date, row.smoothedBodyFatPct] satisfies [string, number]),
        { color: chartColors.purple },
      ),
      ...(prediction?.projectionLine.length
        ? [
            {
              ...dofekSeries.line(
                "Projection",
                [
                  [data.at(-1)?.date ?? "", data.at(-1)?.smoothedBodyFatPct ?? 0],
                  ...prediction.projectionLine.map(
                    (point) => [point.date, point.projectedBodyFatPct] satisfies [string, number],
                  ),
                ],
                { color: chartColors.purple, width: 2 },
              ),
              lineStyle: { type: "dashed" as const, opacity: 0.5 },
            },
          ]
        : []),
    ],
  };

  return <DofekChart option={option} loading={loading} />;
}
