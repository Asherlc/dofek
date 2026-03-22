import { chartThemeColors, dofekAxis, dofekGrid, dofekTooltip } from "../lib/chartTheme.ts";
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
  awake: "#f87171",
  rem: "#8b5cf6",
  light: "#a78bfa",
  deep: "#6366f1",
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
        const p = params[0];
        if (!p) return "";
        const time = new Date(p.value[0]).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
        });
        const label = STAGE_LABELS[p.value[1]] ?? "Unknown";
        return `${time}<br/><strong>${label}</strong>`;
      },
    }),
    xAxis: {
      ...dofekAxis.time(),
      axisLabel: {
        color: chartThemeColors.axisLabel,
        fontSize: 11,
        formatter: (value: string) =>
          new Date(value).toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
          }),
      },
    },
    yAxis: {
      type: "value" as const,
      min: 0.5,
      max: 4.5,
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
      pieces: [
        { value: 1, color: STAGE_COLOR.deep },
        { value: 2, color: STAGE_COLOR.light },
        { value: 3, color: STAGE_COLOR.rem },
        { value: 4, color: STAGE_COLOR.awake },
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
    />
  );
}
