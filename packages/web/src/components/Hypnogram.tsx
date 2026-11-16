import { formatTimeOnly } from "@dofek/format/format";
import { sleepStageColors } from "@dofek/scoring/colors";
import {
  chartThemeColors,
  dofekAxis,
  dofekGrid,
  dofekTooltip,
  escapeTooltipHtml,
} from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";

interface SleepStage {
  stage: string;
  started_at: string;
  ended_at: string;
}

interface HypnogramProps {
  data: SleepStage[];
  loading?: boolean;
}

const STAGE_VALUE: Record<string, number> = {
  awake: 4,
  rem: 3,
  light: 2,
  deep: 1,
};

const STAGE_COLOR: Record<string, string> = {
  awake: sleepStageColors.awake,
  rem: sleepStageColors.rem,
  light: sleepStageColors.light,
  deep: sleepStageColors.deep,
};

const STAGE_LABELS = ["", "Deep", "Light", "REM", "Awake"];

function buildHypnogramData(stages: SleepStage[]) {
  const points: [string, number][] = [];

  for (const stage of stages) {
    const value = STAGE_VALUE[stage.stage];
    if (value == null) continue;
    // Step-chart: add a point at start and end of each stage
    points.push([stage.started_at, value]);
    points.push([stage.ended_at, value]);
  }

  return points;
}

export function Hypnogram({ data, loading }: HypnogramProps) {
  const points = buildHypnogramData(data);

  const option = {
    grid: dofekGrid("single", { top: 15, bottom: 35, left: 55, right: 15 }),
    tooltip: dofekTooltip({
      trigger: "axis",
      formatter: (params: { value: [string, number] }[]) => {
        const point = params[0];
        if (!point) return "";
        const time = formatTimeOnly(point.value[0]);
        const label = STAGE_LABELS[point.value[1]] ?? "Unknown";
        return `${escapeTooltipHtml(time)}<br/><strong>${escapeTooltipHtml(label)}</strong>`;
      },
    }),
    xAxis: {
      ...dofekAxis.time({ show: true }),
      axisLabel: {
        color: chartThemeColors.axisLabel,
        fontSize: 11,
        formatter: (value: string) => formatTimeOnly(value),
      },
    },
    yAxis: {
      type: "value" as const,
      min: 1,
      max: 4,
      interval: 1,
      axisLabel: {
        color: chartThemeColors.axisLabel,
        fontSize: 11,
        formatter: (value: number) => STAGE_LABELS[value] ?? "",
      },
      splitLine: { lineStyle: { color: chartThemeColors.gridLine } },
      axisLine: { show: true, lineStyle: { color: chartThemeColors.axisLine } },
    },
    visualMap: {
      show: false,
      dimension: 1,
      // Ranges keep the line's color bands visible; exact values collapse to zero width.
      pieces: [
        { min: 0.5, max: 1.5, color: STAGE_COLOR.deep },
        { min: 1.5, max: 2.5, color: STAGE_COLOR.light },
        { min: 2.5, max: 3.5, color: STAGE_COLOR.rem },
        { min: 3.5, max: 4.5, color: STAGE_COLOR.awake },
      ],
    },
    series: [
      {
        type: "line" as const,
        data: points,
        step: "end" as const,
        symbol: "none",
        lineStyle: { width: 2 },
        areaStyle: { opacity: 0.15 },
      },
    ],
  };

  return (
    <DofekChart
      option={option}
      loading={loading}
      empty={data.length === 0}
      height={200}
      emptyMessage="No sleep stage data available"
      timeRangeMode="data"
    />
  );
}
