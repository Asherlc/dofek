import { formatDateMedium } from "@dofek/format/format";
import { statusColors, surfaceColors } from "@dofek/scoring/colors";
import {
  ACTIVITY_HEATMAP_BANDS,
  ACTIVITY_HEATMAP_MEASURE_LABEL,
  ACTIVITY_HEATMAP_UNIT_LABEL,
  type ActivityHeatmapBandId,
} from "@dofek/training/activity-heatmap";
import type { CalendarDay } from "dofek-server/types";
import { useId, useMemo, useState } from "react";
import { chartThemeColors, dofekTooltip, escapeTooltipHtml } from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";

interface TrainingCalendarProps {
  data: CalendarDay[];
  height?: number;
}

export function TrainingCalendar({ data, height = 180 }: TrainingCalendarProps) {
  if (data.length === 0) {
    return <DofekChart option={{}} empty={true} height={height} emptyMessage="No training data" />;
  }

  return <TrainingCalendarContent data={data} height={height} />;
}

function TrainingCalendarContent({ data, height }: TrainingCalendarProps) {
  // Determine date range from data, capping to 1 year for calendar readability
  const dates = data.map((d) => d.date).sort();
  const endDate = dates[dates.length - 1] ?? "";
  const oneYearBefore = new Date(endDate);
  oneYearBefore.setFullYear(oneYearBefore.getFullYear() - 1);
  const minDate = oneYearBefore.toISOString().split("T")[0] ?? "";
  const startDate = (dates[0] ?? "") > minDate ? (dates[0] ?? "") : minDate;
  const displayDays = data
    .filter((day) => day.date >= startDate)
    .sort((left, right) => left.date.localeCompare(right.date));

  const dayMap = useMemo(() => new Map(data.map((day) => [day.date, day])), [data]);
  const [selectedDate, setSelectedDate] = useState<string | undefined>(displayDays.at(-1)?.date);
  const selectedDay =
    (selectedDate === undefined ? undefined : dayMap.get(selectedDate)) ?? displayDays.at(-1);
  const detailsSelectId = useId();

  // Series data: [date, totalMinutes] — only include dates within the display range
  const seriesData: [string, number][] = displayDays.map((day) => [day.date, day.totalMinutes]);

  const colorsByBand: Record<ActivityHeatmapBandId, string> = {
    none: "#ffffff",
    light: "#064e3b",
    moderate: "#059669",
    high: statusColors.positive,
    very_high: "#86efac",
  };

  const visualMapPieces = ACTIVITY_HEATMAP_BANDS.map((band) => ({
    min: band.min,
    ...(band.max === null ? {} : { max: band.max }),
    color: colorsByBand[band.id],
    label: band.label,
  }));

  const option = {
    tooltip: dofekTooltip({
      trigger: "item",
      formatter(params: unknown): string {
        if (!params || typeof params !== "object" || !("value" in params)) return "";
        const rawValue = Array.isArray(params.value) ? params.value : ["", 0];
        const date = String(rawValue[0] ?? "");
        const minutes = Number(rawValue[1] ?? 0);
        const day = dayMap.get(date);
        if (!day) return formatDateMedium(date);
        const types = day.activityTypes.join(", ");
        return [
          `<strong>${escapeTooltipHtml(formatDateMedium(date))}</strong>`,
          `Activities: ${day.activityCount}`,
          `Training time: ${minutes} minutes`,
          `Types: ${escapeTooltipHtml(types || "No activity types recorded")}`,
        ].join("<br/>");
      },
    }),
    visualMap: {
      show: false,
      name: `${ACTIVITY_HEATMAP_MEASURE_LABEL} (${ACTIVITY_HEATMAP_UNIT_LABEL})`,
      min: 0,
      max: Math.max(...data.map((d) => d.totalMinutes), 120),
      type: "piecewise" as const,
      pieces: visualMapPieces,
      orient: "horizontal" as const,
      left: "center",
      bottom: 0,
      textStyle: { color: chartThemeColors.axisLabel },
    },
    calendar: {
      range: [startDate, endDate],
      cellSize: ["auto" as const, 15],
      top: 30,
      left: 40,
      right: 10,
      itemStyle: { borderColor: surfaceColors.background, borderWidth: 2 },
      splitLine: { lineStyle: { color: chartThemeColors.gridLine } },
      dayLabel: {
        color: chartThemeColors.axisLabel,
        fontSize: 10,
        nameMap: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
      },
      monthLabel: { color: chartThemeColors.axisLabel, fontSize: 11 },
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

  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold text-muted">
        {ACTIVITY_HEATMAP_MEASURE_LABEL} ({ACTIVITY_HEATMAP_UNIT_LABEL})
      </p>
      <ul
        aria-label="Training time legend"
        className="flex flex-wrap gap-x-3 gap-y-1.5 text-xs text-muted"
      >
        {ACTIVITY_HEATMAP_BANDS.map((band) => (
          <li key={band.id} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-3 w-3 rounded border border-border-strong"
              style={{ backgroundColor: colorsByBand[band.id] }}
            />
            {band.label}
          </li>
        ))}
      </ul>
      <DofekChart
        option={option}
        height={height}
        onEvents={{
          click(params) {
            const value = params.value;
            const date = Array.isArray(value) ? String(value[0] ?? "") : "";
            if (dayMap.has(date)) setSelectedDate(date);
          },
        }}
      />
      {selectedDay ? (
        <div className="space-y-2 rounded-md border border-border bg-surface px-3 py-2 text-xs text-muted">
          <label className="font-semibold text-foreground" htmlFor={detailsSelectId}>
            Day
          </label>
          <select
            className="w-full rounded border border-border-strong bg-surface-solid px-2 py-1 text-foreground"
            id={detailsSelectId}
            onChange={(event) => setSelectedDate(event.target.value)}
            value={selectedDay.date}
          >
            {displayDays.map((day) => (
              <option key={day.date} value={day.date}>
                {formatDateMedium(day.date)} — {day.totalMinutes} min
              </option>
            ))}
          </select>
          <p aria-live="polite">
            {selectedDay.activityCount}{" "}
            {selectedDay.activityCount === 1 ? "activity" : "activities"}
          </p>
        </div>
      ) : null}
    </div>
  );
}
