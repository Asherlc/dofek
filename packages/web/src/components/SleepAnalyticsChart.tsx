import type { SleepNightlyRow } from "dofek-server/types";
import ReactECharts from "echarts-for-react";

interface SleepAnalyticsChartProps {
  nightly: SleepNightlyRow[];
  sleepDebt: number;
  loading?: boolean;
}

export function SleepAnalyticsChart({ nightly, sleepDebt, loading }: SleepAnalyticsChartProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[350px]">
        <span className="text-zinc-600 text-sm">Loading...</span>
      </div>
    );
  }

  if (nightly.length === 0) {
    return (
      <div className="flex items-center justify-center h-[350px]">
        <span className="text-zinc-600 text-sm">No sleep data</span>
      </div>
    );
  }

  const dates = nightly.map((d) =>
    new Date(d.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
  );

  const debtHours = Math.round((sleepDebt / 60) * 10) / 10;
  const debtLabel = sleepDebt > 0 ? `${debtHours}h deficit` : `${Math.abs(debtHours)}h surplus`;
  const debtColor = sleepDebt > 120 ? "#ef4444" : sleepDebt > 0 ? "#eab308" : "#22c55e";

  const option = {
    backgroundColor: "transparent",
    grid: { top: 50, right: 60, bottom: 40, left: 50 },
    tooltip: {
      trigger: "axis" as const,
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
      formatter: (
        params: { seriesName: string; value: number | null; color: string; marker: string }[],
      ) => {
        if (!params || params.length === 0) return "";
        const idx = (params[0] as unknown as { dataIndex: number }).dataIndex;
        const night = nightly[idx];
        if (!night) return "";
        const totalHr = Math.floor(night.durationMinutes / 60);
        const totalMin = night.durationMinutes % 60;
        let html = `<div style="font-weight:600;margin-bottom:4px">${dates[idx] ?? ""} (${totalHr}h ${totalMin}m)</div>`;
        for (const p of params) {
          if (p.seriesName === "7d Avg") {
            if (p.value != null) {
              const avgHr = Math.floor(p.value / 60);
              const avgMin = Math.round(p.value % 60);
              html += `<div>${p.marker} ${p.seriesName}: <b>${avgHr}h ${avgMin}m</b></div>`;
            }
            continue;
          }
          if (p.value == null) continue;
          const mins = Math.round((p.value / 100) * night.durationMinutes);
          html += `<div>${p.marker} ${p.seriesName}: <b>${p.value.toFixed(1)}%</b> (${mins}m)</div>`;
        }
        return html;
      },
    },
    legend: {
      data: ["Deep", "REM", "Light", "Awake", "7d Avg"],
      textStyle: { color: "#a1a1aa", fontSize: 11 },
      top: 0,
    },
    graphic: [
      {
        type: "text" as const,
        right: 10,
        top: 5,
        style: {
          text: `14d Sleep Debt: ${debtLabel}`,
          fill: debtColor,
          fontSize: 13,
          fontWeight: "bold" as const,
        },
      },
    ],
    xAxis: {
      type: "category" as const,
      data: dates,
      axisLabel: { color: "#71717a", fontSize: 11, rotate: 45 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
    },
    yAxis: [
      {
        type: "value" as const,
        name: "Stage %",
        max: 100,
        splitLine: { lineStyle: { color: "#27272a" } },
        axisLabel: {
          color: "#71717a",
          fontSize: 11,
          formatter: "{value}%",
        },
        axisLine: { show: false },
        nameTextStyle: { color: "#71717a", fontSize: 11 },
      },
      {
        type: "value" as const,
        name: "Duration (min)",
        splitLine: { show: false },
        axisLabel: { color: "#71717a", fontSize: 11 },
        axisLine: { show: true, lineStyle: { color: "#3f3f46" } },
        nameTextStyle: { color: "#71717a", fontSize: 11 },
        position: "right" as const,
      },
    ],
    series: [
      {
        name: "Deep",
        type: "bar",
        stack: "sleep",
        data: nightly.map((d) => d.deepPct),
        itemStyle: { color: "#4f46e5" },
        yAxisIndex: 0,
      },
      {
        name: "REM",
        type: "bar",
        stack: "sleep",
        data: nightly.map((d) => d.remPct),
        itemStyle: { color: "#7c3aed" },
        yAxisIndex: 0,
      },
      {
        name: "Light",
        type: "bar",
        stack: "sleep",
        data: nightly.map((d) => d.lightPct),
        itemStyle: { color: "#3b82f6" },
        yAxisIndex: 0,
      },
      {
        name: "Awake",
        type: "bar",
        stack: "sleep",
        data: nightly.map((d) => d.awakePct),
        itemStyle: { color: "#ef4444" },
        yAxisIndex: 0,
      },
      {
        name: "7d Avg",
        type: "line",
        data: nightly.map((d) => d.rollingAvgDuration),
        smooth: true,
        symbol: "none",
        lineStyle: { color: "#22c55e", width: 2.5 },
        itemStyle: { color: "#22c55e" },
        yAxisIndex: 1,
        z: 5,
      },
    ],
  };

  return <ReactECharts option={option} style={{ height: 350 }} notMerge={true} />;
}
