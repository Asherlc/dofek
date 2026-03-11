import ReactECharts from "echarts-for-react";

interface PmcDataPoint {
  date: string;
  load: number;
  ctl: number;
  atl: number;
  tsb: number;
}

interface TssModelInfo {
  type: "learned" | "generic";
  pairedActivities: number;
  r2: number | null;
  ftp: number | null;
}

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
        Learned model (R²={model.r2?.toFixed(2)}, {model.pairedActivities} paired activities
        {model.ftp != null && `, FTP ${model.ftp}W`})
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs bg-zinc-800 text-zinc-400 border border-zinc-700/50">
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-zinc-500" />
      Generic TRIMP model
      {model.pairedActivities > 0 && ` (${model.pairedActivities} paired activities — need 10+)`}
      {model.ftp != null && ` · FTP ${model.ftp}W`}
    </span>
  );
}

export function PmcChart({ data, model, loading }: PmcChartProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[300px]">
        <span className="text-zinc-600 text-sm">Loading...</span>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[300px]">
        <span className="text-zinc-600 text-sm">No training load data</span>
      </div>
    );
  }

  const dates = data.map((d) =>
    new Date(d.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
  );

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
      formatter(params: Array<{ seriesName: string; value: number; marker: string }>) {
        if (!params.length) return "";
        const idx = (params[0] as unknown as { dataIndex: number }).dataIndex;
        const d = data[idx];
        return [
          `<strong>${dates[idx]}</strong>`,
          `<span style="color:#71717a">Load:</span> ${d.load.toFixed(1)}`,
          `<span style="color:#3b82f6">Fitness (CTL):</span> ${d.ctl.toFixed(1)}`,
          `<span style="color:#ec4899">Fatigue (ATL):</span> ${d.atl.toFixed(1)}`,
          `<span style="color:${d.tsb >= 0 ? "#22c55e" : "#ef4444"}">Form (TSB):</span> ${d.tsb.toFixed(1)}`,
        ].join("<br/>");
      },
    },
    legend: {
      data: ["Load", "Fitness (CTL)", "Fatigue (ATL)", "Form +", "Form -"],
      textStyle: { color: "#a1a1aa", fontSize: 11 },
      top: 0,
    },
    xAxis: {
      type: "category" as const,
      data: dates,
      axisLabel: { color: "#71717a", fontSize: 11, rotate: 45 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
    },
    yAxis: [
      {
        type: "value" as const,
        name: "CTL / ATL",
        splitLine: { lineStyle: { color: "#27272a" } },
        axisLabel: { color: "#71717a", fontSize: 11 },
        axisLine: { show: false },
        nameTextStyle: { color: "#71717a", fontSize: 11 },
      },
      {
        type: "value" as const,
        name: "TSB",
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
        data: data.map((d) => d.load),
        itemStyle: { color: "#71717a", opacity: 0.35 },
        yAxisIndex: 0,
        z: 1,
      },
      {
        name: "Fitness (CTL)",
        type: "line",
        data: data.map((d) => d.ctl),
        smooth: true,
        symbol: "none",
        lineStyle: { color: "#3b82f6", width: 2 },
        itemStyle: { color: "#3b82f6" },
        yAxisIndex: 0,
        z: 3,
      },
      {
        name: "Fatigue (ATL)",
        type: "line",
        data: data.map((d) => d.atl),
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
        data: tsbPositive,
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
        data: tsbNegative,
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
