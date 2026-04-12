import { formatDateYmd } from "@dofek/format/format";
import { useMemo, useState } from "react";
import type { HeartRateSourceSeries } from "../../../server/src/routers/heart-rate.ts";
import { DofekChart } from "../components/DofekChart.tsx";
import {
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
  seriesColor,
} from "../lib/chartTheme.ts";
import { trpc } from "../lib/trpc.ts";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function DailyHeartRatePage() {
  const [date, setDate] = useState(() => formatDateYmd());

  const query = trpc.heartRate.dailyBySource.useQuery({ date });
  const sources = query.data ?? [];

  const option = useMemo(() => buildChartOption(sources), [sources]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Daily Heart Rate by Source</h1>
          <p className="text-xs text-dim">Compare heart rate readings across providers</p>
        </div>
        <input
          type="date"
          value={date}
          onChange={(event) => setDate(event.target.value)}
          className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
        />
      </div>

      <div className="card p-4">
        <DofekChart
          option={option}
          loading={query.isLoading}
          empty={sources.length === 0}
          height={400}
          emptyMessage="No heart rate data for this day"
        />
      </div>

      {sources.length > 0 && <SourceSummaryTable sources={sources} />}
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
        const time = new Date(firstParam.data[0]).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
        });
        let html = `<div style="font-weight:600;margin-bottom:4px">${escapeHtml(time)}</div>`;
        for (const param of params) {
          if (param.data[1] == null) continue;
          html += `<div style="display:flex;align-items:center;gap:6px">`;
          html += `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${escapeHtml(param.color)}"></span>`;
          html += `<span>${escapeHtml(param.seriesName)}: <b>${param.data[1]} bpm</b></span>`;
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
          {sources.map((source, index) => {
            const heartRates = source.samples.map((sample) => sample.heartRate);
            const min = Math.min(...heartRates);
            const avg = Math.round(
              heartRates.reduce((sum, value) => sum + value, 0) / heartRates.length,
            );
            const max = Math.max(...heartRates);

            return (
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
                <td className="px-4 py-2.5 tabular-nums">{source.samples.length}</td>
                <td className="px-4 py-2.5 tabular-nums">{min} bpm</td>
                <td className="px-4 py-2.5 tabular-nums">{avg} bpm</td>
                <td className="px-4 py-2.5 tabular-nums">{max} bpm</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
