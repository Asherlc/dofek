import { formatDateShort } from "@dofek/format/format";
import { formatMeasurementText } from "@dofek/format/units";
import DOMPurify from "dompurify";
import type { BodyRecompositionRow } from "../../../server/src/routers/body-analytics.ts";
import {
  chartColors,
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
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

function escapeHtml(value: string): string {
  const textContainer = document.createElement("span");
  textContainer.textContent = value;
  return DOMPurify.sanitize(textContainer.innerHTML, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
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

  if (data.length === 0) {
    return (
      <DofekChart
        option={{}}
        loading={loading}
        empty={true}
        emptyMessage="Need weight + body fat data for recomposition tracking"
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
        const date = escapeHtml(formatDateShort(firstDataPoint.value[0]));
        const lines = params.flatMap((param) => {
          if (!isRecompositionDataPoint(param.data)) return [];
          const marker = typeof param.marker === "string" ? param.marker : "";
          const seriesName = escapeHtml(param.seriesName ?? "");
          const displayValue = escapeHtml(
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
      <div className="flex gap-4 text-sm">
        <span className={`font-medium ${fatChange <= 0 ? "text-green-400" : "text-red-400"}`}>
          Fat: {fatChange > 0 ? "+" : ""}
          {formatMeasurementText(units.formatWeight(fatChange))}
        </span>
        <span className={`font-medium ${leanChange >= 0 ? "text-green-400" : "text-red-400"}`}>
          Lean: {leanChange > 0 ? "+" : ""}
          {formatMeasurementText(units.formatWeight(leanChange))}
        </span>
      </div>
      <DofekChart option={option} loading={loading} />
    </div>
  );
}
