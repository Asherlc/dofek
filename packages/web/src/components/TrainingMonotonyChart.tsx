import type { TrainingMonotonyWeek } from "dofek-server/types";
import {
  chartColors,
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
} from "../lib/chartTheme.ts";
import { formatNumber } from "../lib/format.ts";
import { DofekChart } from "./DofekChart.tsx";

interface TrainingMonotonyChartProps {
  data: TrainingMonotonyWeek[];
  loading?: boolean;
}

export function TrainingMonotonyChart({ data, loading }: TrainingMonotonyChartProps) {
  const option = {
    grid: dofekGrid("dualAxis", { top: 50, bottom: 50 }),
    tooltip: dofekTooltip({
      formatter(
        params: Array<{
          seriesName: string;
          value: [string, number];
          marker: string;
          dataIndex: number;
        }>,
      ) {
        if (!params.length) return "";
        const first = params[0];
        if (!first) return "";
        const idx = first.dataIndex;
        const dataPoint = data[idx];
        if (!dataPoint) return "";
        const dateLabel = new Date(dataPoint.week).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        const monotonyColor = dataPoint.monotony > 2.0 ? "#ef4444" : chartColors.blue;
        return [
          `<strong>${dateLabel}</strong>`,
          `Monotony: <span style="color:${monotonyColor}">${formatNumber(dataPoint.monotony, 2)}</span>${dataPoint.monotony > 2.0 ? " (high!)" : ""}`,
          `Strain: ${formatNumber(dataPoint.strain)}`,
        ].join("<br/>");
      },
    }),
    legend: dofekLegend(true, { data: ["Monotony", "Strain"] }),
    xAxis: dofekAxis.time(),
    yAxis: [
      dofekAxis.value({ name: "Monotony" }),
      dofekAxis.value({ name: "Strain", position: "right", showSplitLine: false }),
    ],
    series: [
      {
        ...dofekSeries.bar(
          "Monotony",
          data.map((d) => ({
            value: [d.week, d.monotony],
            itemStyle: {
              color: d.monotony > 2.0 ? "#ef4444" : chartColors.blue,
            },
          })),
          {},
        ),
      },
      dofekSeries.line(
        "Strain",
        data.map((d) => [d.week, d.strain]),
        {
          color: chartColors.orange,
          symbol: "circle",
          symbolSize: 6,
          yAxisIndex: 1,
        },
      ),
    ],
  };

  return (
    <div>
      <p className="text-xs text-dim mb-2">
        Monotony &gt; 2.0 (red) with high strain indicates elevated overtraining risk.
      </p>
      <DofekChart
        option={option}
        loading={loading}
        empty={data.length === 0}
        height={300}
        emptyMessage="No training monotony data available"
      />
    </div>
  );
}
