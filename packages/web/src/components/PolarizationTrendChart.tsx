import { formatDateMedium, formatDateYmd, formatNumber } from "@dofek/format/format";
import type { PolarizationTrendResult, PolarizationWeek } from "dofek-server/types";
import {
  chartColors,
  chartThemeColors,
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekTooltip,
  escapeTooltipHtml,
} from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";
import { MethodExplanation } from "./MethodExplanation.tsx";

interface PolarizationTrendChartProps {
  weeks: PolarizationWeek[];
  maxHr: number | null;
  threshold?: PolarizationTrendResult["threshold"];
  method: PolarizationTrendResult["method"] | null;
  loading?: boolean;
}

const DEFAULT_POLARIZATION_THRESHOLD = 2;

function normalizePolarizationThreshold(threshold: number | null | undefined): number {
  return typeof threshold === "number" && Number.isFinite(threshold)
    ? threshold
    : DEFAULT_POLARIZATION_THRESHOLD;
}

function formatMinutes(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.round((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function findWeekForAxisValue(
  weeks: PolarizationWeek[],
  axisValue: string,
): PolarizationWeek | null {
  const axisDate = new Date(axisValue);
  if (Number.isNaN(axisDate.getTime())) return null;
  const axisDateOnly = formatDateYmd(axisDate);
  for (const week of weeks) {
    const weekDate = new Date(week.week);
    if (Number.isNaN(weekDate.getTime())) continue;
    if (formatDateYmd(weekDate) === axisDateOnly) return week;
  }
  return null;
}

export function buildPolarizationTrendOption(weeks: PolarizationWeek[], threshold?: number | null) {
  const effectiveThreshold = normalizePolarizationThreshold(threshold);
  const piValues = weeks
    .map((w) => w.polarizationIndex)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const piMin = piValues.length > 0 ? Math.min(...piValues) : 0;
  const piMax = piValues.length > 0 ? Math.max(...piValues) : 2.5;
  const yMin = Math.floor(Math.min(piMin, 0) * 10) / 10;
  const yMax = Math.ceil(Math.max(piMax, effectiveThreshold) * 10) / 10;

  const firstDate = weeks[0]?.week ?? "";
  const lastDate = weeks[weeks.length - 1]?.week ?? "";

  const incompleteWeeks = weeks.filter((w) => w.polarizationIndex === null);

  return {
    grid: dofekGrid("single", { top: 40, bottom: 40, left: 55 }),
    tooltip: dofekTooltip({
      formatter: (
        params: Array<{
          axisValue: string;
          value: [string, number | null];
          dataIndex?: number;
          color: string;
          seriesName?: string;
        }>,
      ) => {
        if (!params.length) return "";
        const piParam = params.find((param) => param.seriesName === "Polarization Index");
        const param = piParam ?? params[0];
        if (!param || typeof param.axisValue !== "string") return "";

        const weekByIndex =
          typeof piParam?.dataIndex === "number" && piParam.dataIndex >= 0
            ? weeks[piParam.dataIndex]
            : undefined;
        const weekData = weekByIndex ?? findWeekForAxisValue(weeks, param.axisValue);
        if (!weekData) return "";

        const pi = weekData.polarizationIndex;
        const piStr = pi !== null ? formatNumber(pi, 3) : "N/A";
        const dateLabel = formatDateMedium(weekData.week);
        const status = `<span style="color:${chartColors.blue}">${escapeTooltipHtml(weekData.statusLabel)}</span>`;
        return [
          `<strong>Week of ${escapeTooltipHtml(dateLabel)}</strong>`,
          `Polarization Index: ${piStr} ${status}`,
          `Zone 1 (easy, <80% max HR): ${formatMinutes(weekData.z1Seconds)}`,
          `Zone 2 (threshold, 80-90% max HR): ${formatMinutes(weekData.z2Seconds)}`,
          `Zone 3 (high, ≥90% max HR): ${formatMinutes(weekData.z3Seconds)}`,
          escapeTooltipHtml(weekData.explanation),
        ]
          .filter((line): line is string => typeof line === "string")
          .join("<br/>");
      },
    }),
    xAxis: dofekAxis.time(),
    yAxis: dofekAxis.value({ name: "Polarization Index", min: yMin, max: yMax }),
    series: [
      {
        name: "Treff heuristic",
        type: "line",
        data: [
          [firstDate, effectiveThreshold],
          [lastDate, effectiveThreshold],
        ],
        symbol: "none",
        lineStyle: { color: chartThemeColors.legendText, type: "dashed", width: 1 },
        silent: true,
        tooltip: { show: false },
        z: 1,
      },
      {
        name: "Polarization Index",
        type: "line",
        data: weeks.map((w) => ({
          value: [w.week, w.polarizationIndex],
          itemStyle: w.polarizationIndex !== null ? { color: chartColors.blue } : undefined,
        })),
        connectNulls: false,
        smooth: true,
        symbol: "circle",
        symbolSize: 6,
        lineStyle: { width: 2.5, color: chartThemeColors.legendText },
        itemStyle: { borderWidth: 2 },
        z: 10,
      },
      // Weeks where PI couldn't be computed (missing zone coverage)
      ...(incompleteWeeks.length > 0
        ? [
            {
              name: "Incomplete weeks",
              type: "scatter" as const,
              data: incompleteWeeks.map((w) => ({
                value: [w.week, yMin],
              })),
              symbol: "diamond",
              symbolSize: 8,
              itemStyle: { color: chartColors.amber, opacity: 0.6 },
              z: 5,
            },
          ]
        : []),
    ],
    legend: dofekLegend(false),
  };
}

export function PolarizationTrendChart({
  weeks,
  maxHr,
  threshold = 2,
  method,
  loading,
}: PolarizationTrendChartProps) {
  const effectiveThreshold = normalizePolarizationThreshold(threshold);
  const option = weeks.length > 0 ? buildPolarizationTrendOption(weeks, effectiveThreshold) : {};

  return (
    <div>
      <h3 className="text-xs font-medium text-subtle mb-2">
        Polarization Index (3-Zone Model)
        {maxHr && <span className="text-dim ml-2">(max heart rate: {maxHr} bpm)</span>}
      </h3>
      <DofekChart
        option={option}
        loading={loading}
        empty={weeks.length === 0}
        height={280}
        emptyMessage="Not enough HR data to compute polarization index"
      />
      {method ? (
        <MethodExplanation
          className="mt-2"
          lines={[
            method.formula,
            method.zoneBasis,
            method.calculationChoice,
            method.interpretation,
          ]}
          source={method.source}
        />
      ) : null}
    </div>
  );
}
