import { formatDateShort } from "@dofek/format/format";
import { formatMeasurementText } from "@dofek/format/units";
import type { BodyRecompositionRow } from "../../../server/src/routers/body-analytics.ts";
import {
  chartColors,
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
  escapeTooltipHtml,
} from "../lib/chartTheme.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import { DofekChart } from "./DofekChart.tsx";

interface BodyRecompositionChartProps {
  data: BodyRecompositionRow[];
  loading?: boolean;
}

interface RecompositionDataPoint {
  value: [string, number];
  sourceWeightKg: number;
}

interface RecompositionTooltipParam {
  seriesName?: string;
  marker?: string;
  data?: unknown;
}

function isRecompositionDataPoint(value: unknown): value is RecompositionDataPoint {
  return (
    typeof value === "object" &&
    value !== null &&
    "value" in value &&
    Array.isArray(value.value) &&
    typeof value.value[0] === "string" &&
    typeof value.value[1] === "number" &&
    "sourceWeightKg" in value &&
    typeof value.sourceWeightKg === "number"
  );
}

export function BodyRecompositionChart({ data, loading }: BodyRecompositionChartProps) {
  const units = useUnitConverter();

  if (data.length < 2) {
    return (
      <DofekChart
        option={{}}
        loading={loading}
        empty={true}
        emptyMessage="Need at least two weight + body fat readings in this range to show a recomposition change"
      />
    );
  }

  // Compute change from first to last
  const first = data[0];
  const last = data[data.length - 1];
  if (!first || !last) {
    return null;
  }
  const fatChange = last.smoothedFatMass - first.smoothedFatMass;
  const leanChange = last.smoothedLeanMass - first.smoothedLeanMass;

  const option = {
    grid: dofekGrid("single", { left: 50 }),
    tooltip: dofekTooltip({
      formatter: (params: RecompositionTooltipParam[]) => {
        if (!params || params.length === 0) return "";
        const firstDataPoint = params.find((param) => isRecompositionDataPoint(param.data))?.data;
        if (!isRecompositionDataPoint(firstDataPoint)) return "";
        const date = escapeTooltipHtml(formatDateShort(firstDataPoint.value[0]));
        const lines = params.flatMap((param) => {
          if (!isRecompositionDataPoint(param.data)) return [];
          const marker = typeof param.marker === "string" ? param.marker : "";
          const seriesName = escapeTooltipHtml(param.seriesName ?? "");
          const displayValue = escapeTooltipHtml(
            formatMeasurementText(units.formatWeight(param.data.sourceWeightKg)),
          );
          return `${marker}${seriesName} <b>${displayValue}</b>`;
        });
        return `<div style="font-weight:600;margin-bottom:4px">${date}</div>${lines.join("<br/>")}`;
      },
    }),
    legend: dofekLegend(true),
    xAxis: dofekAxis.time(),
    yAxis: dofekAxis.value({ name: units.weightLabel }),
    series: [
      dofekSeries.line(
        "Fat Mass (smoothed)",
        data.map((row) => ({
          value: [row.date, units.convertWeight(row.smoothedFatMass)] satisfies [string, number],
          sourceWeightKg: row.smoothedFatMass,
        })),
        { color: chartColors.orange, areaStyle: { opacity: 0.1 } },
      ),
      dofekSeries.line(
        "Lean Mass (smoothed)",
        data.map((row) => ({
          value: [row.date, units.convertWeight(row.smoothedLeanMass)] satisfies [string, number],
          sourceWeightKg: row.smoothedLeanMass,
        })),
        { color: chartColors.blue, areaStyle: { opacity: 0.1 } },
      ),
    ],
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
        <span className="font-medium" style={{ color: chartColors.orange }}>
          Fat: {fatChange > 0 ? "+" : ""}
          {formatMeasurementText(units.formatWeight(fatChange))}
        </span>
        <span className="font-medium" style={{ color: chartColors.blue }}>
          Lean: {leanChange > 0 ? "+" : ""}
          {formatMeasurementText(units.formatWeight(leanChange))}
        </span>
        <span className="text-subtle text-xs">
          {formatDateShort(first.date)} – {formatDateShort(last.date)}
        </span>
      </div>
      <DofekChart option={option} loading={loading} />
    </div>
  );
}
