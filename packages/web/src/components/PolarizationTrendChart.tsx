import type { PolarizationWeek } from "dofek-server/types";
import ReactECharts from "echarts-for-react";

interface PolarizationTrendChartProps {
  weeks: PolarizationWeek[];
  maxHr: number | null;
  loading?: boolean;
}

function formatMinutes(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.round((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

interface PolarizationWeekData {
  week: string;
  polarizationIndex: number | null;
  z1Seconds: number;
  z2Seconds: number;
  z3Seconds: number;
}

function missingZonesForWeek(week: PolarizationWeekData): string[] {
  const missing: string[] = [];
  if (week.z1Seconds <= 0) missing.push("Zone 1");
  if (week.z2Seconds <= 0) missing.push("Zone 2");
  if (week.z3Seconds <= 0) missing.push("Zone 3");
  return missing;
}

function findWeekForAxisValue(
  weeks: PolarizationWeekData[],
  axisValue: string,
): PolarizationWeekData | null {
  const axisDate = new Date(axisValue);
  if (Number.isNaN(axisDate.getTime())) return null;
  const axisDateOnly = axisDate.toISOString().slice(0, 10);
  for (const week of weeks) {
    const weekDate = new Date(week.week);
    if (Number.isNaN(weekDate.getTime())) continue;
    if (weekDate.toISOString().slice(0, 10) === axisDateOnly) return week;
  }
  return null;
}

export function buildPolarizationTrendOption(weeks: PolarizationWeekData[]) {
  const piValues = weeks
    .map((w) => w.polarizationIndex)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const piMin = piValues.length > 0 ? Math.min(...piValues) : 0;
  const piMax = piValues.length > 0 ? Math.max(...piValues) : 2.5;
  const yMin = Math.floor(Math.min(piMin, 0) * 10) / 10;
  const yMax = Math.ceil(Math.max(piMax, 2.5) * 10) / 10;

  const firstDate = weeks[0]?.week ?? "";
  const lastDate = weeks[weeks.length - 1]?.week ?? "";

  return {
    backgroundColor: "transparent",
    grid: { top: 40, right: 20, bottom: 40, left: 55 },
    tooltip: {
      trigger: "axis",
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
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
        const w = weekByIndex ?? findWeekForAxisValue(weeks, param.axisValue);
        if (!w) return "";

        const pi = w.polarizationIndex;
        const piStr = pi !== null ? pi.toFixed(3) : "N/A";
        const dateLabel = new Date(w.week).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        const missingZones = missingZonesForWeek(w);
        const status =
          pi === null
            ? '<span style="color:#f59e0b">Insufficient zone coverage</span>'
            : pi >= 2.0
              ? '<span style="color:#22c55e">Polarized</span>'
              : '<span style="color:#ef4444">Not polarized</span>';
        const missingZonesText =
          pi === null && missingZones.length > 0
            ? `Missing zones this week: ${missingZones.join(", ")}`
            : null;
        return [
          `<strong>Week of ${dateLabel}</strong>`,
          `Polarization Index: ${piStr} ${status}`,
          `Zone 1 (easy, <80% max HR): ${formatMinutes(w.z1Seconds)}`,
          `Zone 2 (threshold, 80-90% max HR): ${formatMinutes(w.z2Seconds)}`,
          `Zone 3 (high, ≥90% max HR): ${formatMinutes(w.z3Seconds)}`,
          missingZonesText,
        ]
          .filter((line): line is string => typeof line === "string")
          .join("<br/>");
      },
    },
    xAxis: {
      type: "time" as const,
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
    },
    yAxis: {
      type: "value",
      name: "Polarization Index",
      min: yMin,
      max: yMax,
      splitLine: { lineStyle: { color: "#27272a" } },
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { show: true, lineStyle: { color: "#3f3f46" } },
      nameTextStyle: { color: "#71717a", fontSize: 11 },
    },
    visualMap: {
      type: "piecewise",
      show: false,
      seriesIndex: 2,
      pieces: [
        { lte: 2.0, color: "#ef4444" },
        { gt: 2.0, color: "#22c55e" },
      ],
    },
    series: [
      // Shaded green area above Threshold = 2.0
      {
        name: "Polarized zone",
        type: "line",
        data: [
          [firstDate, yMax],
          [lastDate, yMax],
        ],
        symbol: "none",
        lineStyle: { width: 0 },
        areaStyle: { color: "#22c55e", opacity: 0.05, origin: 2.0 },
        silent: true,
        tooltip: { show: false },
        z: 0,
      },
      // Shaded red area below Threshold = 2.0
      {
        name: "Non-polarized zone",
        type: "line",
        data: [
          [firstDate, yMin],
          [lastDate, yMin],
        ],
        symbol: "none",
        lineStyle: { width: 0 },
        areaStyle: { color: "#ef4444", opacity: 0.05, origin: 2.0 },
        silent: true,
        tooltip: { show: false },
        z: 0,
      },
      // Actual PI line with threshold reference line
      {
        name: "Polarization Index",
        type: "line",
        data: weeks.map((w) => [w.week, w.polarizationIndex]),
        connectNulls: false,
        smooth: true,
        symbol: "circle",
        symbolSize: 6,
        lineStyle: { width: 2.5 },
        itemStyle: { borderWidth: 2 },
        z: 10,
        markLine: {
          silent: true,
          symbol: "none",
          lineStyle: { color: "#a1a1aa", type: "dashed", width: 1 },
          data: [{ yAxis: 2.0 }],
          label: {
            formatter: "Threshold = 2.0",
            color: "#a1a1aa",
            fontSize: 10,
          },
          tooltip: { show: false },
        },
      },
    ],
    legend: {
      show: false,
    },
  };
}

export function PolarizationTrendChart({ weeks, maxHr, loading }: PolarizationTrendChartProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[280px]">
        <span className="text-zinc-600 text-sm">Loading polarization data...</span>
      </div>
    );
  }

  if (weeks.length === 0) {
    return (
      <div className="flex items-center justify-center h-[100px]">
        <span className="text-zinc-600 text-sm">
          Not enough HR data to compute polarization index
        </span>
      </div>
    );
  }

  const option = buildPolarizationTrendOption(weeks);

  return (
    <div>
      <h3 className="text-xs font-medium text-zinc-500 mb-2">
        Polarization Index (3-Zone Model)
        {maxHr && <span className="text-zinc-700 ml-2">(max heart rate: {maxHr} bpm)</span>}
      </h3>
      <ReactECharts option={option} style={{ height: 280 }} notMerge={true} />
      <p className="text-xs text-zinc-700 mt-1">
        Index above 2.0 = well-polarized training. Zone 1 = easy (&lt;80% max HR), Zone 2 =
        threshold (80-90% max HR), Zone 3 = high intensity (&ge;90% max HR).
      </p>
    </div>
  );
}
