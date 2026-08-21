import { formatDateYmd, formatTimeOnly, shiftDateYmd } from "@dofek/format/format";
import { useMemo, useState } from "react";
import type { HeartRateSourceSeries } from "../../../server/src/routers/heart-rate.ts";
import { DofekChart } from "../components/DofekChart.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { useTodayQueryDate } from "../hooks/useTodayQueryDate.ts";
import {
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
  escapeTooltipHtml,
  seriesColor,
} from "../lib/chartTheme.ts";
import { trpc } from "../lib/trpc.ts";

export function DailyHeartRatePage() {
  const [date, setDate] = useState(() => formatDateYmd());
  const today = useTodayQueryDate();
  const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const isToday = date === today;
  const canGoForward = date < today;

  const query = trpc.heartRate.dailyBySource.useQuery({ date });
  const sources = query.data;
  const option = useMemo(
    () => (sources !== undefined && sources.length > 0 ? buildChartOption(sources) : undefined),
    [sources],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Daily Heart Rate by Source</h2>
          <p className="text-xs text-dim">Compare heart rate readings across providers</p>
          <p className="text-xs text-dim">Local day in {localTimezone}</p>
        </div>
        <fieldset className="m-0 flex flex-wrap items-center gap-2 border-0 p-0">
          <legend className="sr-only">Day navigation</legend>
          <button
            type="button"
            onClick={() => setDate(shiftDateYmd(date, -1))}
            aria-label="Previous day"
            className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-foreground hover:bg-surface-secondary"
          >
            Previous
          </button>
          <label>
            <span className="sr-only">Date</span>
            <input
              type="date"
              value={date}
              max={today}
              onChange={(event) => {
                if (event.target.value && event.target.value <= today) setDate(event.target.value);
              }}
              className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
            />
          </label>
          <button
            type="button"
            onClick={() => {
              const nextDate = shiftDateYmd(date, 1);
              if (nextDate <= today) setDate(nextDate);
            }}
            disabled={!canGoForward}
            aria-label="Next day"
            className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-foreground hover:bg-surface-secondary disabled:cursor-not-allowed disabled:opacity-50"
          >
            Next
          </button>
          <button
            type="button"
            onClick={() => setDate(today)}
            disabled={isToday}
            aria-label="Today"
            className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-foreground hover:bg-surface-secondary disabled:cursor-not-allowed disabled:opacity-50"
          >
            Today
          </button>
        </fieldset>
      </div>

      <div className="card p-4">
        {!option && query.isLoading ? (
          <QueryStatePanel variant="loading" height={400} />
        ) : !option && query.error ? (
          <QueryStatePanel error={query.error} height={400} />
        ) : !option ? (
          <QueryStatePanel variant="empty" message="No heart rate data for this day" height={400} />
        ) : (
          <DofekChart option={option} height={400} timeRangeMode="data" />
        )}
      </div>

      {option && query.error ? <QueryStatePanel error={query.error} height={72} /> : null}
      {sources !== undefined && sources.length > 0 ? (
        <SourceSummaryTable sources={sources} />
      ) : null}
    </div>
  );
}

function buildChartOption(sources: HeartRateSourceSeries[]) {
  const series = sources.map((source, index) => {
    const data = source.samples.map((sample) => [sample.time, sample.heartRate]);
    return dofekSeries.line(source.providerLabel, data, {
      color: seriesColor(index),
      smooth: 0.3,
      width: 1.5,
    });
  });

  return {
    tooltip: dofekTooltip({
      formatter: (params: { seriesName: string; data: [string, number]; color: string }[]) => {
        if (!params?.length) return "";
        const firstParam = params[0];
        if (!firstParam) return "";
        const time = formatTimeOnly(firstParam.data[0]);
        let html = `<div style="font-weight:600;margin-bottom:4px">${escapeTooltipHtml(time)}</div>`;
        for (const param of params) {
          if (param.data[1] == null) continue;
          html += `<div style="display:flex;align-items:center;gap:6px">`;
          html += `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${escapeTooltipHtml(param.color)}"></span>`;
          html += `<span>${escapeTooltipHtml(param.seriesName)}: <b>${param.data[1]} bpm</b></span>`;
          html += `</div>`;
        }
        return html;
      },
    }),
    legend: dofekLegend(sources.length > 1),
    grid: dofekGrid("single", { top: sources.length > 1 ? 35 : 15 }),
    xAxis: dofekAxis.time(),
    yAxis: dofekAxis.value({ name: "bpm", min: "dataMin", max: "dataMax" }),
    series,
  };
}

function SourceSummaryTable({ sources }: { sources: HeartRateSourceSeries[] }) {
  return (
    <div className="card overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted uppercase tracking-wider">
            <th className="px-4 py-2.5">Source</th>
            <th className="px-4 py-2.5">Samples</th>
            <th className="px-4 py-2.5">Min</th>
            <th className="px-4 py-2.5">Avg</th>
            <th className="px-4 py-2.5">Max</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((source, index) => (
            <tr key={source.providerId} className="border-b border-border last:border-0">
              <td className="px-4 py-2.5 font-medium">
                <span className="flex items-center gap-2">
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-full"
                    style={{ backgroundColor: seriesColor(index) }}
                  />
                  {source.providerLabel}
                </span>
              </td>
              <td className="px-4 py-2.5 tabular-nums">{source.sampleCount}</td>
              <td className="px-4 py-2.5 tabular-nums">{source.minHeartRate} bpm</td>
              <td className="px-4 py-2.5 tabular-nums">{source.avgHeartRate} bpm</td>
              <td className="px-4 py-2.5 tabular-nums">{source.maxHeartRate} bpm</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
