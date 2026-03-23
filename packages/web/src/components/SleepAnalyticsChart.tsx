import type { SleepNightlyRow } from "dofek-server/types";
import { dofekAxis, dofekGrid, dofekLegend, dofekSeries, dofekTooltip } from "../lib/chartTheme.ts";
import { formatNumber } from "../lib/format.ts";
import { DofekChart } from "./DofekChart.tsx";

interface SleepAnalyticsChartProps {
  nightly: SleepNightlyRow[];
  sleepDebt: number;
  loading?: boolean;
}

export function buildSleepAnalyticsOption(nightly: SleepNightlyRow[], sleepDebt: number) {
  const debtHours = Math.round((sleepDebt / 60) * 10) / 10;
  const debtLabel = sleepDebt > 0 ? `${debtHours}h deficit` : `${Math.abs(debtHours)}h surplus`;
  const debtColor = sleepDebt > 120 ? "#ef4444" : sleepDebt > 0 ? "#eab308" : "#22c55e";

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
        const totalHr = Math.floor(night.durationMinutes / 60);
        const totalMin = Math.round(night.durationMinutes % 60);
        const dateLabel = new Date(night.date).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        let html = `<div style="font-weight:600;margin-bottom:4px">${dateLabel} (${totalHr}h ${totalMin}m)</div>`;
        for (const p of params) {
          if (p.seriesName === "7d Avg") {
            if (p.value[1] != null) {
              const avgHr = Math.floor(p.value[1] / 60);
              const avgMin = Math.round(p.value[1] % 60);
              html += `<div>${p.marker} ${p.seriesName}: <b>${avgHr}h ${avgMin}m</b></div>`;
            }
            continue;
          }
          if (p.value[1] == null) continue;
          const mins = Math.round((p.value[1] / 100) * night.durationMinutes);
          html += `<div>${p.marker} ${p.seriesName}: <b>${formatNumber(p.value[1])}%</b> (${mins}m)</div>`;
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
          color: "#4f46e5",
        },
      ),
      dofekSeries.bar(
        "REM",
        nightly.map((d) => [d.date, d.remPct]),
        {
          stack: "sleep",
          color: "#7c3aed",
        },
      ),
      dofekSeries.bar(
        "Light",
        nightly.map((d) => [d.date, d.lightPct]),
        {
          stack: "sleep",
          color: "#3b82f6",
        },
      ),
      dofekSeries.bar(
        "Awake",
        nightly.map((d) => [d.date, d.awakePct]),
        {
          stack: "sleep",
          color: "#ef4444",
        },
      ),
      dofekSeries.line(
        "7d Avg",
        nightly.map((d) => [d.date, d.rollingAvgDuration]),
        {
          color: "#22c55e",
          width: 2.5,
          yAxisIndex: 1,
          z: 5,
        },
      ),
    ],
  };
}

export function SleepAnalyticsChart({ nightly, sleepDebt, loading }: SleepAnalyticsChartProps) {
  const option = nightly.length > 0 ? buildSleepAnalyticsOption(nightly, sleepDebt) : {};

  return (
    <DofekChart
      option={option}
      loading={loading}
      empty={nightly.length === 0}
      height={350}
      emptyMessage="No sleep data"
    />
  );
}
