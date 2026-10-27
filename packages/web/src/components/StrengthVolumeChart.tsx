import { formatDateMedium, formatNumber } from "@dofek/format/format";
import type { VolumeOverTimeRow } from "dofek-server/types";
import { useState } from "react";
import {
  chartColors,
  dofekAxis,
  dofekGrid,
  dofekSeries,
  dofekTooltip,
  escapeTooltipHtml,
} from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";

interface StrengthVolumeChartProps {
  data: VolumeOverTimeRow[];
  loading?: boolean;
}

export function StrengthVolumeChart({ data, loading }: StrengthVolumeChartProps) {
  const [metric, setMetric] = useState<"weight" | "sets" | "time">("weight");
  const label =
    metric === "weight" ? "Weight lifted (kg)" : metric === "sets" ? "Sets" : "Time (minutes)";
  const option = {
    grid: dofekGrid("single", { top: 30, bottom: 40, left: 60 }),
    tooltip: dofekTooltip({
      formatter(params: { dataIndex: number }[]) {
        const first = params[0];
        if (!first) return "";
        const index = first.dataIndex;
        const dataPoint = data[index];
        if (!dataPoint) return "";
        const dateLabel = formatDateMedium(dataPoint.week);
        const selectedValue =
          metric === "weight"
            ? dataPoint.recordedVolumeKg
            : metric === "sets"
              ? dataPoint.recordedSetCount
              : dataPoint.durationMinutes;
        return `<strong>${escapeTooltipHtml(dateLabel ?? "")}</strong><br/>
          ${escapeTooltipHtml(label)}: ${selectedValue == null ? "Not recorded" : selectedValue.toLocaleString()}`;
      },
    }),
    xAxis: dofekAxis.time(),
    yAxis: dofekAxis.value({
      name: label,
      axisLabel: {
        formatter(value: number) {
          return value >= 1000 ? `${formatNumber(value / 1000)}k` : String(value);
        },
      },
    }),
    series: [
      {
        ...dofekSeries.bar(
          "Volume",
          data.map((d) => [
            d.week,
            metric === "weight"
              ? d.recordedVolumeKg
              : metric === "sets"
                ? d.recordedSetCount
                : d.durationMinutes,
          ]),
          {
            color: chartColors.emerald,
          },
        ),
        itemStyle: {
          color: chartColors.emerald,
          borderRadius: [4, 4, 0, 0],
        },
        emphasis: {
          itemStyle: { color: chartColors.emerald },
        },
      },
    ],
  };

  return (
    <>
      <label>
        Metric{" "}
        <select
          aria-label="Strength volume metric"
          value={metric}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "weight" || value === "sets" || value === "time") setMetric(value);
          }}
        >
          <option value="weight">Weight lifted</option>
          <option value="sets">Sets</option>
          <option value="time">Time</option>
        </select>
      </label>
      {data.some(
        (row) =>
          (metric === "weight"
            ? row.recordedVolumeKg
            : metric === "sets"
              ? row.recordedSetCount
              : row.durationMinutes) === null,
      ) ? (
        <p className="text-xs text-muted">Weeks with incomplete records are not plotted.</p>
      ) : null}
      <DofekChart
        option={option}
        loading={loading}
        empty={data.length === 0}
        height={280}
        emptyMessage="No strength volume data"
      />
    </>
  );
}
