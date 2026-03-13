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

export function PolarizationTrendChart({ weeks, maxHr, loading }: PolarizationTrendChartProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[280px]">
        <span className="text-zinc-600 text-sm">Loading polarization data...</span>
      </div>
    );
  }

  const validWeeks = weeks.filter((w) => w.polarizationIndex !== null);

  if (validWeeks.length === 0) {
    return (
      <div className="flex items-center justify-center h-[100px]">
        <span className="text-zinc-600 text-sm">
          Not enough HR data to compute polarization index
        </span>
      </div>
    );
  }

  const piValues = validWeeks.map((w) => w.polarizationIndex as number);
  const piMin = Math.min(...piValues);
  const piMax = Math.max(...piValues);
  const yMin = Math.floor(Math.min(piMin, 0) * 10) / 10;
  const yMax = Math.ceil(Math.max(piMax, 2.5) * 10) / 10;

  const firstDate = validWeeks[0]?.week ?? "";
  const lastDate = validWeeks[validWeeks.length - 1]?.week ?? "";

  const option = {
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
          value: [string, number];
          dataIndex: number;
          color: string;
        }>,
      ) => {
        const param = params[0];
        if (!param) return "";
        const w = validWeeks[param.dataIndex];
        if (!w) return "";
        const pi = w.polarizationIndex;
        const piStr = pi !== null ? pi.toFixed(3) : "N/A";
        const dateLabel = new Date(w.week).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        const status =
          pi !== null && pi >= 2.0
            ? '<span style="color:#22c55e">Polarized</span>'
            : '<span style="color:#ef4444">Not polarized</span>';
        return [
          `<strong>Week of ${dateLabel}</strong>`,
          `Polarization Index: ${piStr} ${status}`,
          `Zone 1 (easy, <80%): ${formatMinutes(w.z1Seconds)}`,
          `Zone 2 (threshold, 80-87.5%): ${formatMinutes(w.z2Seconds)}`,
          `Zone 3 (high, >87.5%): ${formatMinutes(w.z3Seconds)}`,
        ].join("<br/>");
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
      show: false,
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
        z: 0,
      },
      // Reference line at Threshold = 2.0
      {
        name: "Threshold = 2.0",
        type: "line",
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
        data: [],
      },
      // Actual PI line
      {
        name: "Polarization Index",
        type: "line",
        data: validWeeks.map((w) => [w.week, w.polarizationIndex]),
        smooth: true,
        symbol: "circle",
        symbolSize: 6,
        lineStyle: { width: 2.5 },
        itemStyle: { borderWidth: 2 },
        z: 10,
      },
    ],
    legend: {
      show: false,
    },
  };

  return (
    <div>
      <h3 className="text-xs font-medium text-zinc-500 mb-2">
        Polarization Index (3-Zone Model)
        {maxHr && <span className="text-zinc-700 ml-2">(max heart rate: {maxHr} bpm)</span>}
      </h3>
      <ReactECharts option={option} style={{ height: 280 }} notMerge={true} />
      <p className="text-xs text-zinc-700 mt-1">
        Index above 2.0 = well-polarized training. Zone 1 = easy (&lt;80% max heart rate), Zone 2 =
        threshold (80-87.5%), Zone 3 = high intensity (&gt;87.5%).
      </p>
    </div>
  );
}
