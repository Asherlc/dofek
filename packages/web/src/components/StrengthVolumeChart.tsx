import type { VolumeOverTimeRow } from "dofek-server/types";
import { chartColors, dofekAxis, dofekGrid, dofekSeries, dofekTooltip } from "../lib/chartTheme.ts";
import { formatNumber } from "../lib/format.ts";
import { DofekChart } from "./DofekChart.tsx";

interface StrengthVolumeChartProps {
  data: VolumeOverTimeRow[];
  loading?: boolean;
}

export function StrengthVolumeChart({ data, loading }: StrengthVolumeChartProps) {
  const option = {
    grid: dofekGrid("single", { top: 30, bottom: 40, left: 60 }),
    tooltip: dofekTooltip({
      formatter(params: { dataIndex: number }[]) {
        const first = params[0];
        if (!first) return "";
        const index = first.dataIndex;
        const d = data[index];
        if (!d) return "";
        const dateLabel = new Date(d.week).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        return `<strong>${dateLabel ?? ""}</strong><br/>
          Volume: ${Math.round(d.totalVolumeKg).toLocaleString()} kg<br/>
          Sets: ${d.setCount}`;
      },
    }),
    xAxis: dofekAxis.time(),
    yAxis: dofekAxis.value({
      name: "Volume (kg)",
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
          data.map((d) => [d.week, d.totalVolumeKg]),
          {
            color: chartColors.emerald,
          },
        ),
        itemStyle: {
          color: chartColors.emerald,
          borderRadius: [4, 4, 0, 0],
        },
        emphasis: {
          itemStyle: { color: "#34d399" },
        },
      },
    ],
  };

  return (
    <DofekChart
      option={option}
      loading={loading}
      empty={data.length === 0}
      height={280}
      emptyMessage="No strength volume data"
    />
  );
}
