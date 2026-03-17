import type { PmcDataPoint, TssModelInfo } from "dofek-server/types";
import ReactECharts from "echarts-for-react";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface PmcChartProps {
  data: PmcDataPoint[];
  model?: TssModelInfo | null;
  loading?: boolean;
}

function ModelBadge({ model }: { model: TssModelInfo }) {
  if (model.type === "learned") {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs bg-emerald-900/40 text-emerald-400 border border-emerald-800/50">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400" />
        Learned model (fit={model.r2?.toFixed(2)}, {model.pairedActivities} paired activities
        {model.ftp != null && `, threshold ${model.ftp}W`})
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs bg-zinc-800 text-zinc-400 border border-zinc-700/50">
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-zinc-500" />
      Generic heart rate model
      {model.pairedActivities > 0 && ` (${model.pairedActivities} paired activities — need 10+)`}
      {model.ftp != null && ` · threshold ${model.ftp}W`}
    </span>
  );
}

export function PmcChart({ data, model, loading }: PmcChartProps) {
  if (loading) {
    return <ChartLoadingSkeleton height={300} />;
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[300px]">
        <span className="text-zinc-600 text-sm">No training load data</span>
      </div>
    );
  }

  // Split TSB into positive (green) and negative (red) for area coloring
  const tsbPositive = data.map((d) => (d.tsb >= 0 ? d.tsb : 0));
  const tsbNegative = data.map((d) => (d.tsb < 0 ? d.tsb : 0));

  const option = {
    backgroundColor: "transparent",
    grid: { top: 40, right: 70, bottom: 50, left: 60 },
    tooltip: {
      trigger: "axis" as const,
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
      formatter(
        params: Array<{ seriesName: string; value: number; marker: string; dataIndex: number }>,
      ) {
        const first = params[0];
        if (!first) return "";
        const idx = first.dataIndex;
        const d = data[idx];
        if (!d) return "";
        const label = new Date(d.date).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        return [
          `<strong>${label}</strong>`,
          `<span style="color:#71717a">Load:</span> ${d.load.toFixed(1)}`,
          `<span style="color:#3b82f6">Fitness (Chronic Training Load):</span> ${d.ctl.toFixed(1)}`,
          `<span style="color:#ec4899">Fatigue (Acute Training Load):</span> ${d.atl.toFixed(1)}`,
          `<span style="color:${d.tsb >= 0 ? "#22c55e" : "#ef4444"}">Form (Training Stress Balance):</span> ${d.tsb.toFixed(1)}`,
        ].join("<br/>");
      },
    },
    legend: {
      data: [
        "Load",
        "Fitness (Chronic Training Load)",
        "Fatigue (Acute Training Load)",
        "Form +",
        "Form -",
      ],
      textStyle: { color: "#a1a1aa", fontSize: 11 },
      top: 0,
    },
    xAxis: {
      type: "time" as const,
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
    },
    yAxis: [
      {
        type: "value" as const,
        name: "Fitness / Fatigue",
        splitLine: { lineStyle: { color: "#27272a" } },
        axisLabel: { color: "#71717a", fontSize: 11 },
        axisLine: { show: false },
        nameTextStyle: { color: "#71717a", fontSize: 11 },
      },
      {
        type: "value" as const,
        name: "Form",
        splitLine: { show: false },
        axisLabel: { color: "#71717a", fontSize: 11 },
        axisLine: { show: false },
        nameTextStyle: { color: "#71717a", fontSize: 11 },
        position: "right" as const,
      },
    ],
    series: [
      {
        name: "Load",
        type: "bar",
        data: data.map((d) => [d.date, d.load]),
        itemStyle: { color: "#71717a", opacity: 0.35 },
        yAxisIndex: 0,
        z: 1,
      },
      {
        name: "Fitness (Chronic Training Load)",
        type: "line",
        data: data.map((d) => [d.date, d.ctl]),
        smooth: true,
        symbol: "none",
        lineStyle: { color: "#3b82f6", width: 2 },
        itemStyle: { color: "#3b82f6" },
        yAxisIndex: 0,
        z: 3,
      },
      {
        name: "Fatigue (Acute Training Load)",
        type: "line",
        data: data.map((d) => [d.date, d.atl]),
        smooth: true,
        symbol: "none",
        lineStyle: { color: "#ec4899", width: 2 },
        itemStyle: { color: "#ec4899" },
        yAxisIndex: 0,
        z: 3,
      },
      {
        name: "Form +",
        type: "line",
        data: data.map((d, i) => [d.date, tsbPositive[i]]),
        smooth: true,
        symbol: "none",
        lineStyle: { width: 0 },
        areaStyle: { color: "#22c55e", opacity: 0.25 },
        itemStyle: { color: "#22c55e" },
        yAxisIndex: 1,
        z: 2,
      },
      {
        name: "Form -",
        type: "line",
        data: data.map((d, i) => [d.date, tsbNegative[i]]),
        smooth: true,
        symbol: "none",
        lineStyle: { width: 0 },
        areaStyle: { color: "#ef4444", opacity: 0.25 },
        itemStyle: { color: "#ef4444" },
        yAxisIndex: 1,
        z: 2,
      },
    ],
  };

  return (
    <div>
      {model && (
        <div className="mb-2">
          <ModelBadge model={model} />
        </div>
      )}
      <ReactECharts option={option} style={{ height: 300 }} notMerge={true} />
    </div>
  );
}
