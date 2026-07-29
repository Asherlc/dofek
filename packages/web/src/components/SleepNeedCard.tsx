import {
  formatDateLong,
  formatDurationMinutes,
  formatNumber,
  formatWeekdayShort,
} from "@dofek/format/format";
import { statusColors } from "@dofek/scoring/colors";
import { sleepDebtColor } from "@dofek/scoring/scoring";
import type { SleepNeedV2 } from "dofek-server/sleep-need-contract";
import {
  chartThemeColors,
  dofekAxis,
  dofekGrid,
  dofekSeries,
  dofekTooltip,
  escapeTooltipHtml,
} from "../lib/chartTheme.ts";
import { formatSleepProvenance } from "../lib/sleepSource.ts";
import { DofekChart } from "./DofekChart.tsx";

interface SleepNeedCardProps {
  data: SleepNeedV2 | undefined;
  loading?: boolean;
}

export function SleepNeedCard({ data, loading }: SleepNeedCardProps) {
  if (loading || !data) {
    return (
      <DofekChart
        option={{}}
        loading={loading}
        empty={!data}
        height={320}
        emptyMessage="No sleep data"
      />
    );
  }

  if (data.availability === "missing_previous_night") {
    return (
      <div className="card p-6">
        <h3 className="text-muted text-sm font-medium mb-2">Sleep Need Tonight</h3>
        <p className="text-lg text-dim">{data.message}</p>
      </div>
    );
  }

  // Recent nights bar chart
  const chartOption = {
    grid: dofekGrid("single", { top: 20, right: 10, bottom: 30, left: 40 }),
    tooltip: dofekTooltip({
      formatter: (
        params: {
          dataIndex: number;
          marker: string;
          seriesName: string;
          value: [string, number];
        }[],
      ) => {
        if (!params?.[0]) return "";
        const night = data.recentNights[params[0].dataIndex];
        if (!night) return "";
        const date = escapeTooltipHtml(formatDateLong(night.date));
        if (night.actualMinutes == null) {
          return `<div style="font-weight:600;margin-bottom:4px">${date}</div><div style="color:#6b7280">No data</div>`;
        }
        let html = `<div style="font-weight:600;margin-bottom:4px">${date}</div>`;
        html += `<div>Slept: <b>${formatDurationMinutes(night.actualMinutes)}</b></div>`;
        html += `<div>Needed: <b>${formatDurationMinutes(night.neededMinutes)}</b></div>`;
        if (night.debtMinutes != null && night.debtMinutes > 0) {
          html += `<div style="color:${statusColors.danger}">Debt: ${formatDurationMinutes(night.debtMinutes)}</div>`;
        }
        if (night.providerId) {
          const { primary, alsoFrom } = formatSleepProvenance(night);
          html += `<div style="color:#9ca3af;margin-top:4px">Source: ${escapeTooltipHtml(primary)}${
            alsoFrom ? ` · also ${escapeTooltipHtml(alsoFrom)}` : ""
          }</div>`;
        }
        return html;
      },
    }),
    xAxis: dofekAxis.category({
      data: data.recentNights.map((n) => formatWeekdayShort(n.date)),
    }),
    yAxis: dofekAxis.value({
      name: "hours",
      axisLabel: { formatter: (v: number) => `${formatNumber(v / 60, 0)}h` },
    }),
    series: [
      {
        ...dofekSeries.bar(
          "Actual",
          data.recentNights.map((n) => ({
            value: n.actualMinutes ?? 0,
            itemStyle: {
              color:
                n.actualMinutes == null
                  ? "#3a3a3e"
                  : n.actualMinutes >= n.neededMinutes
                    ? statusColors.positive
                    : statusColors.danger,
            },
          })),
        ),
        barMaxWidth: 30,
      },
      {
        ...dofekSeries.line(
          "Need",
          data.recentNights.map((n) => n.neededMinutes),
          {
            color: chartThemeColors.axisLabel,
            lineStyle: { type: "dashed" },
            width: 1.5,
            z: 5,
            connectNulls: true,
          },
        ),
      },
    ],
  };

  return (
    <div className="card p-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-muted text-sm font-medium mb-1">Sleep Need Tonight</h3>
          <div className="flex items-baseline gap-2">
            <span className="text-4xl font-bold text-blue-400">
              {formatDurationMinutes(data.totalNeedMinutes)}
            </span>
            <span className="text-subtle text-sm">recommended</span>
          </div>
        </div>
      </div>

      {/* Breakdown */}
      <div className="flex gap-4 mb-4 text-xs">
        <div className="flex-1 bg-surface-solid rounded-lg p-2">
          <p className="text-subtle">Baseline</p>
          <p className="text-foreground font-medium">
            {formatDurationMinutes(data.baselineMinutes)}
          </p>
        </div>
        <div className="flex-1 bg-surface-solid rounded-lg p-2">
          <p className="text-subtle">Strain Debt</p>
          <p className="text-foreground font-medium">
            +{formatDurationMinutes(data.strainDebtMinutes)}
          </p>
        </div>
        <div className="flex-1 bg-surface-solid rounded-lg p-2">
          <p className="text-subtle">Sleep Debt</p>
          <p className="font-medium" style={{ color: sleepDebtColor(data.accumulatedDebtMinutes) }}>
            {formatDurationMinutes(data.accumulatedDebtMinutes)}
          </p>
        </div>
      </div>

      {/* Recent nights chart */}
      {data.recentNights.length > 0 && (
        <div>
          <p className="text-subtle text-xs mb-1">Last 7 nights (dashed = need)</p>
          <DofekChart option={chartOption} height={120} />
        </div>
      )}
    </div>
  );
}
