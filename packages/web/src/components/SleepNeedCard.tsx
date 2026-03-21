import { sleepDebtColor } from "@dofek/scoring/scoring";
import type { SleepNeedResult } from "dofek-server/types";
import {
  chartThemeColors,
  dofekAxis,
  dofekGrid,
  dofekSeries,
  dofekTooltip,
} from "../lib/chartTheme.ts";
import { formatNumber } from "../lib/format.ts";
import { DofekChart } from "./DofekChart.tsx";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface SleepNeedCardProps {
  data: SleepNeedResult | undefined;
  loading?: boolean;
}

function formatHoursMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = Math.round(minutes % 60);
  return `${hours}h ${remainingMinutes}m`;
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

  const needHours = Math.round((data.totalNeedMinutes / 60) * 10) / 10;
  const baselineHours = Math.round((data.baselineMinutes / 60) * 10) / 10;

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
        const date = new Date(night.date).toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
        });
        let html = `<div style="font-weight:600;margin-bottom:4px">${date}</div>`;
        html += `<div>Slept: <b>${formatHoursMinutes(night.actualMinutes)}</b></div>`;
        html += `<div>Needed: <b>${formatHoursMinutes(night.neededMinutes)}</b></div>`;
        if (night.debtMinutes > 0) {
          html += `<div style="color:#ef4444">Debt: ${night.debtMinutes}m</div>`;
        }
        return html;
      },
    }),
    xAxis: dofekAxis.category({
      data: data.recentNights.map((n) =>
        new Date(n.date).toLocaleDateString("en-US", { weekday: "short" }),
      ),
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
            value: n.actualMinutes,
            itemStyle: {
              color: n.actualMinutes >= n.neededMinutes ? "#22c55e" : "#ef4444",
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
            <span className="text-4xl font-bold text-blue-400">{needHours}h</span>
            <span className="text-subtle text-sm">recommended</span>
          </div>
        </div>
      </div>

      {/* Breakdown */}
      <div className="flex gap-4 mb-4 text-xs">
        <div className="flex-1 bg-surface-solid rounded-lg p-2">
          <p className="text-subtle">Baseline</p>
          <p className="text-foreground font-medium">{baselineHours}h</p>
        </div>
        <div className="flex-1 bg-surface-solid rounded-lg p-2">
          <p className="text-subtle">Strain Debt</p>
          <p className="text-foreground font-medium">+{data.strainDebtMinutes}m</p>
        </div>
        <div className="flex-1 bg-surface-solid rounded-lg p-2">
          <p className="text-subtle">Sleep Debt</p>
          <p className="font-medium" style={{ color: sleepDebtColor(data.accumulatedDebtMinutes) }}>
            {formatHoursMinutes(data.accumulatedDebtMinutes)}
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
