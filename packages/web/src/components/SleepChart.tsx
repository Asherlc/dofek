import { formatDateMedium } from "@dofek/format/format";
import { sleepStageColors } from "@dofek/scoring/colors";
import {
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
  escapeTooltipHtml,
} from "../lib/chartTheme.ts";
import { formatSleepProvenance } from "../lib/sleepSource.ts";
import { DofekChart } from "./DofekChart.tsx";

interface SleepData {
  date?: string;
  started_at: string;
  duration_minutes: number | null;
  deep_minutes: number | null;
  rem_minutes: number | null;
  light_minutes: number | null;
  awake_minutes: number | null;
  provider_id?: string | null;
  source_name?: string | null;
  source_providers?: string[];
}

interface SleepChartProps {
  data: SleepData[];
  loading?: boolean;
}

export function SleepChart({ data, loading }: SleepChartProps) {
  const sourceByStartedAt = new Map(data.map((row) => [row.started_at, row] as const));

  const option = {
    grid: dofekGrid("single", { top: 30, bottom: 40, left: 50 }),
    tooltip: dofekTooltip({
      formatter: (
        params: { seriesName: string; value: [string, number | null]; color: string }[],
      ) => {
        if (!params.length) return "";
        const firstParam = params[0];
        if (!firstParam) return "";
        const date = formatDateMedium(firstParam.value[0]);
        let total = 0;
        const lines = params.map((p) => {
          const val = p.value[1] ?? 0;
          total += val;
          return `<span style="color:${escapeTooltipHtml(p.color)}">\u25CF</span> ${escapeTooltipHtml(p.seriesName)}: ${val}m`;
        });
        const sourceRow = sourceByStartedAt.get(String(firstParam.value[0]));
        const sourceLine = sourceRow
          ? (() => {
              const { primary, alsoFrom } = formatSleepProvenance({
                provider_id: sourceRow.provider_id ?? null,
                source_name: sourceRow.source_name ?? null,
                source_providers: sourceRow.source_providers ?? [],
              });
              return `<br/><span style="color:#9ca3af">Source: ${escapeTooltipHtml(primary)}${
                alsoFrom ? ` · also ${escapeTooltipHtml(alsoFrom)}` : ""
              }</span>`;
            })()
          : "";
        return `<strong>${escapeTooltipHtml(date)}</strong> (${Math.floor(total / 60)}h ${total % 60}m)<br/>${lines.join("<br/>")}${sourceLine}`;
      },
    }),
    xAxis: dofekAxis.time(),
    yAxis: dofekAxis.value({ name: "minutes" }),
    legend: dofekLegend(true),
    series: [
      dofekSeries.bar(
        "Deep",
        data.map((d) => [d.started_at, d.deep_minutes]),
        {
          stack: "sleep",
          color: sleepStageColors.deep,
        },
      ),
      dofekSeries.bar(
        "REM",
        data.map((d) => [d.started_at, d.rem_minutes]),
        {
          stack: "sleep",
          color: sleepStageColors.rem,
        },
      ),
      dofekSeries.bar(
        "Light",
        data.map((d) => [d.started_at, d.light_minutes]),
        {
          stack: "sleep",
          color: sleepStageColors.light,
        },
      ),
      dofekSeries.bar(
        "Awake",
        data.map((d) => [d.started_at, d.awake_minutes]),
        {
          stack: "sleep",
          color: sleepStageColors.awake,
        },
      ),
    ],
  };

  return <DofekChart option={option} loading={loading} empty={data.length === 0} />;
}
