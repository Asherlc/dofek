import ReactECharts from "echarts-for-react";

interface EftpPoint {
  date: string;
  eftp: number;
  activityName: string | null;
}

interface EftpTrendChartProps {
  data: EftpPoint[];
  currentEftp: number | null;
  loading?: boolean;
}

export function EftpTrendChart({ data, currentEftp, loading }: EftpTrendChartProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[240px]">
        <span className="text-zinc-600 text-sm">Loading...</span>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[240px]">
        <span className="text-zinc-600 text-sm">
          No threshold power data (need 20+ min activities with power)
        </span>
      </div>
    );
  }

  const markLine =
    currentEftp != null
      ? {
          silent: true,
          symbol: "none" as const,
          lineStyle: { color: "#f97316", type: "dashed" as const, width: 1 },
          label: {
            formatter: `Threshold: ${currentEftp}W`,
            color: "#f97316",
            fontSize: 11,
          },
          data: [{ yAxis: currentEftp }],
          tooltip: { show: false },
        }
      : undefined;

  const option = {
    backgroundColor: "transparent",
    grid: { top: 30, right: 20, bottom: 30, left: 55 },
    tooltip: {
      trigger: "axis" as const,
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
      formatter: (
        params: Array<{
          data: [string, number];
          axisValueLabel: string;
        }>,
      ) => {
        const point = params[0];
        if (!point) return "";
        const [dateStr, watts] = point.data;
        const match = data.find((d) => d.date === dateStr);
        const name = match?.activityName ?? "";
        const lines = [`<strong>${watts}W</strong>`, point.axisValueLabel];
        if (name) lines.push(`<span style="color:#a1a1aa">${name}</span>`);
        return lines.join("<br/>");
      },
    },
    xAxis: {
      type: "time" as const,
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value" as const,
      name: "Est. Threshold Power (W)",
      min: "dataMin" as const,
      splitLine: { lineStyle: { color: "#27272a" } },
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { show: true, lineStyle: { color: "#3f3f46" } },
      nameTextStyle: { color: "#71717a", fontSize: 11 },
    },
    series: [
      {
        name: "Est. Threshold Power",
        type: "line",
        data: data.map((d) => [d.date, d.eftp]),
        smooth: true,
        symbol: "circle",
        symbolSize: 5,
        lineStyle: { width: 2, color: "#f97316" },
        itemStyle: { color: "#f97316" },
        areaStyle: { opacity: 0.08, color: "#f97316" },
        markLine,
      },
    ],
  };

  return <ReactECharts option={option} style={{ height: 240 }} notMerge={true} />;
}
