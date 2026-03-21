import type { CalendarDay } from "dofek-server/types";
import type { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";

interface TrainingCalendarProps {
  data: CalendarDay[];
  height?: number;
}

export function TrainingCalendar({ data, height = 180 }: TrainingCalendarProps) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center" style={{ height }}>
        <span className="text-dim text-sm">No training data</span>
      </div>
    );
  }

  // Build a lookup map for tooltips
  const dayMap = new Map<string, CalendarDay>();
  for (const d of data) {
    dayMap.set(d.date, d);
  }

  // Determine date range from data, capping to 1 year for calendar readability
  const dates = data.map((d) => d.date).sort();
  const endDate = dates[dates.length - 1] ?? "";
  const oneYearBefore = new Date(endDate);
  oneYearBefore.setFullYear(oneYearBefore.getFullYear() - 1);
  const minDate = oneYearBefore.toISOString().split("T")[0] ?? "";
  const startDate = (dates[0] ?? "") > minDate ? (dates[0] ?? "") : minDate;

  // Series data: [date, totalMinutes] — only include dates within the display range
  const seriesData: [string, number][] = data
    .filter((d) => d.date >= startDate)
    .map((d) => [d.date, d.totalMinutes]);

  const option: EChartsOption = {
    backgroundColor: "transparent",
    tooltip: {
      backgroundColor: "#ffffff",
      borderColor: "rgba(74, 158, 122, 0.2)",
      textStyle: { color: "#1a2e1a", fontSize: 12 },
      formatter(params: unknown): string {
        if (!params || typeof params !== "object" || !("value" in params)) return "";
        const rawValue = Array.isArray(params.value) ? params.value : ["", 0];
        const date = String(rawValue[0] ?? "");
        const minutes = Number(rawValue[1] ?? 0);
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
        { min: 0, max: 0, color: "#ffffff" },
        { min: 1, max: 30, color: "#064e3b" },
        { min: 31, max: 60, color: "#059669" },
        { min: 61, max: 120, color: "#22c55e" },
        { min: 121, color: "#86efac" },
      ],
      orient: "horizontal" as const,
      left: "center",
      bottom: 0,
      textStyle: { color: "#6b8a6b" },
    },
    calendar: {
      range: [startDate, endDate],
      cellSize: ["auto" as const, 15],
      top: 30,
      left: 40,
      right: 10,
      itemStyle: { borderColor: "#eef3ed", borderWidth: 2 },
      splitLine: { lineStyle: { color: "rgba(74, 158, 122, 0.12)" } },
      dayLabel: {
        color: "#6b8a6b",
        fontSize: 10,
        nameMap: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
      },
      monthLabel: { color: "#6b8a6b", fontSize: 11 },
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
