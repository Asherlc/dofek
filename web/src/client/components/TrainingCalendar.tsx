import type { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";

interface CalendarDay {
  date: string;
  activityCount: number;
  totalMinutes: number;
  activityTypes: string[];
}

interface TrainingCalendarProps {
  data: CalendarDay[];
  height?: number;
}

export function TrainingCalendar({ data, height = 180 }: TrainingCalendarProps) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center" style={{ height }}>
        <span className="text-zinc-600 text-sm">No training data</span>
      </div>
    );
  }

  // Build a lookup map for tooltips
  const dayMap = new Map<string, CalendarDay>();
  for (const d of data) {
    dayMap.set(d.date, d);
  }

  // Determine date range from data
  const dates = data.map((d) => d.date).sort();
  const startDate = dates[0];
  const endDate = dates[dates.length - 1];

  // Series data: [date, totalMinutes]
  const seriesData: [string, number][] = data.map((d) => [d.date, d.totalMinutes]);

  const option: EChartsOption = {
    backgroundColor: "transparent",
    tooltip: {
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
      formatter(params: unknown): string {
        const p = params as { value: [string, number] };
        const date = p.value[0];
        const minutes = p.value[1];
        const day = dayMap.get(date);
        if (!day) return date;
        const types = day.activityTypes.join(", ");
        return [
          `<strong>${date}</strong>`,
          `Activities: ${day.activityCount}`,
          `Duration: ${minutes} min`,
          `Types: ${types}`,
        ].join("<br/>");
      },
    },
    visualMap: {
      min: 0,
      max: Math.max(...data.map((d) => d.totalMinutes), 120),
      type: "piecewise" as const,
      pieces: [
        { min: 0, max: 0, color: "#18181b" },
        { min: 1, max: 30, color: "#064e3b" },
        { min: 31, max: 60, color: "#059669" },
        { min: 61, max: 120, color: "#22c55e" },
        { min: 121, color: "#86efac" },
      ],
      orient: "horizontal" as const,
      left: "center",
      bottom: 0,
      textStyle: { color: "#71717a" },
    },
    calendar: {
      range: [startDate, endDate],
      cellSize: ["auto" as const, 15],
      top: 30,
      left: 40,
      right: 10,
      itemStyle: { borderColor: "#09090b", borderWidth: 2 },
      splitLine: { lineStyle: { color: "#27272a" } },
      dayLabel: {
        color: "#71717a",
        fontSize: 10,
        nameMap: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
      },
      monthLabel: { color: "#71717a", fontSize: 11 },
      yearLabel: { show: false },
    },
    series: [
      {
        type: "heatmap",
        coordinateSystem: "calendar",
        data: seriesData,
      },
    ],
  };

  return <ReactECharts option={option} style={{ height }} notMerge={true} />;
}
