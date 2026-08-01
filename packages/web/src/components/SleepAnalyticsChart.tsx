import { formatDateMedium, formatDurationMinutes, formatNumber } from "@dofek/format/format";
import { sleepStageColors, statusColors } from "@dofek/scoring/colors";
import { sleepDebtColor } from "@dofek/scoring/scoring";
import type { SleepAnalyticsDataState, SleepNightlyRow } from "dofek-server/types";
import {
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
  escapeTooltipHtml,
} from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";

interface SleepAnalyticsChartProps {
  nightly: SleepNightlyRow[];
  sleepDebt: number | null;
  loading?: boolean;
}

type MissingSleepState = Extract<SleepAnalyticsDataState, { status: "missing" }>;

function getMissingSleepStates(night: SleepNightlyRow): MissingSleepState[] {
  const states = [night.durationState, night.sleepState, night.stageState].filter(
    (state): state is MissingSleepState => state.status === "missing",
  );
  return states.filter(
    (state, index) =>
      states.findIndex(
        (candidate) =>
          candidate.reason === state.reason && candidate.nextAction === state.nextAction,
      ) === index,
  );
}

function getFirstMissingSleepState(nightly: SleepNightlyRow[]): MissingSleepState | null {
  for (const night of nightly) {
    const state = getMissingSleepStates(night)[0];
    if (state) return state;
  }
  return null;
}

export function buildSleepAnalyticsOption(nightly: SleepNightlyRow[], sleepDebt: number) {
  const debtLabel =
    sleepDebt > 0
      ? `${formatDurationMinutes(sleepDebt)} deficit`
      : `${formatDurationMinutes(Math.abs(sleepDebt))} surplus`;
  const debtColor = sleepDebtColor(sleepDebt);

  return {
    // Reserve vertical space for both the legend row and sleep debt status row.
    grid: dofekGrid("dualAxis", { top: 82, bottom: 40, left: 50 }),
    tooltip: dofekTooltip({
      formatter: (
        params: {
          seriesName: string;
          value: [string, number | null];
          color: string;
          marker: string;
          dataIndex: number;
        }[],
      ) => {
        if (!params || params.length === 0) return "";
        const firstParam = params[0];
        if (!firstParam) return "";
        const idx = firstParam.dataIndex;
        const night = nightly[idx];
        if (!night) return "";
        const dateLabel = formatDateMedium(night.date);
        const durationLabel =
          night.durationMinutes == null
            ? "Duration unavailable"
            : formatDurationMinutes(night.durationMinutes);
        let html = `<div style="font-weight:600;margin-bottom:4px">${escapeTooltipHtml(dateLabel)} (${durationLabel})</div>`;
        for (const state of getMissingSleepStates(night)) {
          html += `<div style="color:#d97706">${escapeTooltipHtml(state.reason)}</div>`;
          html += `<div style="color:#6b7280">${escapeTooltipHtml(state.nextAction)}</div>`;
        }
        for (const p of params) {
          if (p.seriesName === "7d Avg") {
            if (p.value[1] != null) {
              html += `<div>${p.marker} ${escapeTooltipHtml(p.seriesName)}: <b>${formatDurationMinutes(p.value[1])}</b></div>`;
            }
            continue;
          }
          if (p.value[1] == null) continue;
          if (night.durationMinutes == null) continue;
          const mins = Math.round((p.value[1] / 100) * night.durationMinutes);
          html += `<div>${p.marker} ${escapeTooltipHtml(p.seriesName)}: <b>${formatNumber(p.value[1])}%</b> (${formatDurationMinutes(mins)})</div>`;
        }
        return html;
      },
    }),
    legend: dofekLegend(true, {
      data: ["Deep", "REM", "Light", "Awake", "7d Avg"],
      top: 0,
    }),
    graphic: [
      {
        type: "text" as const,
        right: 10,
        top: 28,
        silent: true,
        style: {
          text: `14d Sleep Debt: ${debtLabel}`,
          fill: debtColor,
          fontSize: 13,
          fontWeight: "bold" as const,
          align: "right" as const,
        },
      },
    ],
    xAxis: dofekAxis.time(),
    yAxis: [
      dofekAxis.value({
        name: "Stage %",
        max: 100,
        axisLabel: { formatter: "{value}%" },
      }),
      dofekAxis.value({
        name: "Duration (min)",
        position: "right",
        showSplitLine: false,
      }),
    ],
    series: [
      dofekSeries.bar(
        "Deep",
        nightly.map((d) => [d.date, d.deepPct]),
        {
          stack: "sleep",
          color: sleepStageColors.deep,
        },
      ),
      dofekSeries.bar(
        "REM",
        nightly.map((d) => [d.date, d.remPct]),
        {
          stack: "sleep",
          color: sleepStageColors.rem,
        },
      ),
      dofekSeries.bar(
        "Light",
        nightly.map((d) => [d.date, d.lightPct]),
        {
          stack: "sleep",
          color: sleepStageColors.light,
        },
      ),
      dofekSeries.bar(
        "Awake",
        nightly.map((d) => [d.date, d.awakePct]),
        {
          stack: "sleep",
          color: sleepStageColors.awake,
        },
      ),
      dofekSeries.line(
        "7d Avg",
        nightly.map((d) => [d.date, d.rollingAvgDuration]),
        {
          color: statusColors.positive,
          width: 2.5,
          yAxisIndex: 1,
          z: 5,
        },
      ),
    ],
  };
}

export function SleepAnalyticsChart({ nightly, sleepDebt, loading }: SleepAnalyticsChartProps) {
  const hasMeasuredSleepValues = nightly.some(
    (night) =>
      night.durationMinutes != null ||
      night.sleepMinutes != null ||
      night.deepPct != null ||
      night.remPct != null ||
      night.lightPct != null ||
      night.awakePct != null ||
      night.rollingAvgDuration != null,
  );
  const hasSleepSummary = nightly.length > 0 && sleepDebt != null && hasMeasuredSleepValues;
  const option = hasSleepSummary ? buildSleepAnalyticsOption(nightly, sleepDebt) : {};
  const missingState = getFirstMissingSleepState(nightly);
  const emptyMessage = missingState
    ? `${missingState.reason} ${missingState.nextAction}`
    : "No sleep data";

  return (
    <DofekChart
      option={option}
      loading={loading}
      empty={!hasSleepSummary}
      height={350}
      emptyMessage={emptyMessage}
    />
  );
}
