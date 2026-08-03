import { formatDateMedium } from "@dofek/format/format";
import {
  formatRecordLocalTime,
  type RecordLocalTimeContext,
} from "@dofek/format/record-local-time";
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
  ended_at: string | null;
  timezone: string | null;
  start_utc_offset_minutes: number | null;
  end_utc_offset_minutes: number | null;
  local_time_source: RecordLocalTimeContext["source"];
  duration_minutes: number | null;
  deep_minutes: number | null;
  rem_minutes: number | null;
  light_minutes: number | null;
  awake_minutes: number | null;
  provider_id?: string | null;
  source_name?: string | null;
  source_providers?: string[];
  staging_available: boolean;
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
        const lines = params.flatMap((p) => {
          const val = p.value[1];
          if (val == null) return [];
          total += val;
          return [
            `<span style="color:${escapeTooltipHtml(p.color)}">\u25CF</span> ${escapeTooltipHtml(p.seriesName)}: ${val}m`,
          ];
        });
        const sourceRow = sourceByStartedAt.get(String(firstParam.value[0]));
        const displayedDuration =
          sourceRow?.staging_available === false ? (sourceRow.duration_minutes ?? 0) : total;
        const timingLine = sourceRow
          ? (() => {
              const context = {
                timezone: sourceRow.timezone,
                startUtcOffsetMinutes: sourceRow.start_utc_offset_minutes,
                endUtcOffsetMinutes: sourceRow.end_utc_offset_minutes,
                source: sourceRow.local_time_source,
              };
              const bedtime = formatRecordLocalTime(sourceRow.started_at, context, "start");
              const wake =
                sourceRow.ended_at == null
                  ? "--"
                  : formatRecordLocalTime(sourceRow.ended_at, context, "end");
              return bedtime === "--" || wake === "--"
                ? '<br/><span style="color:#9ca3af">Local sleep time unavailable</span>'
                : `<br/><span style="color:#9ca3af">${escapeTooltipHtml(bedtime)} – ${escapeTooltipHtml(wake)}</span>`;
            })()
          : "";
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
        const qualityLine =
          sourceRow?.staging_available === false
            ? '<br/><span style="color:#d97706">Partial record: sleep stages were not reported</span>'
            : "";
        const stageLines = lines.length > 0 ? `<br/>${lines.join("<br/>")}` : "";
        return `<strong>${escapeTooltipHtml(date)}</strong> (${Math.floor(displayedDuration / 60)}h ${displayedDuration % 60}m)${stageLines}${timingLine}${sourceLine}${qualityLine}`;
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
