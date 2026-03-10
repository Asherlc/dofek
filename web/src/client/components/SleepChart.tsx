import ReactECharts from "echarts-for-react";

interface SleepData {
  started_at: string;
  duration_minutes: number | null;
  deep_minutes: number | null;
  rem_minutes: number | null;
  light_minutes: number | null;
  awake_minutes: number | null;
}

interface SleepChartProps {
  data: SleepData[];
  loading?: boolean;
}

export function SleepChart({ data, loading }: SleepChartProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[250px]">
        <span className="text-zinc-600 text-sm">Loading...</span>
      </div>
    );
  }

  const dates = data.map((d) =>
    new Date(d.started_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
  );

  const option = {
    backgroundColor: "transparent",
    grid: { top: 30, right: 20, bottom: 40, left: 50 },
    tooltip: {
      trigger: "axis",
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
      formatter: (params: any) => {
        const date = params[0]?.axisValue ?? "";
        let total = 0;
        const lines = params.map((p: any) => {
          total += p.value ?? 0;
          return `<span style="color:${p.color}">\u25CF</span> ${p.seriesName}: ${p.value ?? 0}m`;
        });
        return `<strong>${date}</strong> (${Math.floor(total / 60)}h ${total % 60}m)<br/>${lines.join("<br/>")}`;
      },
    },
    xAxis: {
      type: "category",
      data: dates,
      axisLabel: { color: "#71717a", fontSize: 11, rotate: 45 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
    },
    yAxis: {
      type: "value",
      name: "minutes",
      splitLine: { lineStyle: { color: "#27272a" } },
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { show: false },
      nameTextStyle: { color: "#71717a", fontSize: 11 },
    },
    legend: {
      textStyle: { color: "#a1a1aa", fontSize: 11 },
      top: 0,
    },
    series: [
      {
        name: "Deep",
        type: "bar",
        stack: "sleep",
        data: data.map((d) => d.deep_minutes),
        itemStyle: { color: "#6366f1" },
      },
      {
        name: "REM",
        type: "bar",
        stack: "sleep",
        data: data.map((d) => d.rem_minutes),
        itemStyle: { color: "#8b5cf6" },
      },
      {
        name: "Light",
        type: "bar",
        stack: "sleep",
        data: data.map((d) => d.light_minutes),
        itemStyle: { color: "#a78bfa" },
      },
      {
        name: "Awake",
        type: "bar",
        stack: "sleep",
        data: data.map((d) => d.awake_minutes),
        itemStyle: { color: "#f87171" },
      },
    ],
  };

  return <ReactECharts option={option} style={{ height: 250 }} notMerge={true} />;
}
