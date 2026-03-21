import { sleepDebtColor } from "@dofek/scoring/scoring";
import type { SleepNeedResult } from "dofek-server/types";
import ReactECharts from "echarts-for-react";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface SleepNeedCardProps {
  data: SleepNeedResult | undefined;
  loading?: boolean;
}

function formatHoursMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h ${m}m`;
}

export function SleepNeedCard({ data, loading }: SleepNeedCardProps) {
  if (loading) {
    return <ChartLoadingSkeleton height={320} />;
  }

  if (!data) {
    return (
      <div className="card p-6 flex items-center justify-center h-[320px]">
        <span className="text-dim text-sm">No sleep data</span>
      </div>
    );
  }

  const needHours = Math.round((data.totalNeedMinutes / 60) * 10) / 10;
  const baselineHours = Math.round((data.baselineMinutes / 60) * 10) / 10;

  // Recent nights bar chart
  const chartOption = {
    backgroundColor: "transparent",
    grid: { top: 20, right: 10, bottom: 30, left: 40 },
    tooltip: {
      trigger: "axis" as const,
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
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
    },
    xAxis: {
      type: "category" as const,
      data: data.recentNights.map((n) =>
        new Date(n.date).toLocaleDateString("en-US", { weekday: "short" }),
      ),
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
    },
    yAxis: {
      type: "value" as const,
      name: "hours",
      axisLabel: {
        color: "#71717a",
        fontSize: 11,
        formatter: (v: number) => `${(v / 60).toFixed(0)}h`,
      },
      splitLine: { lineStyle: { color: "#27272a" } },
      axisLine: { show: false },
      nameTextStyle: { color: "#71717a", fontSize: 11 },
    },
    series: [
      {
        type: "bar",
        data: data.recentNights.map((n) => ({
          value: n.actualMinutes,
          itemStyle: {
            color: n.actualMinutes >= n.neededMinutes ? "#22c55e" : "#ef4444",
          },
        })),
        barMaxWidth: 30,
      },
      {
        type: "line",
        data: data.recentNights.map((n) => n.neededMinutes),
        symbol: "none",
        lineStyle: { color: "#71717a", width: 1.5, type: "dashed" as const },
        z: 5,
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
          <ReactECharts option={chartOption} style={{ height: 120 }} notMerge={true} />
        </div>
      )}
    </div>
  );
}
