import { formatDateMedium, formatNumber } from "@dofek/format/format";
import type { TrainingMonotonyWeek } from "dofek-server/types";
import {
  chartColors,
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
  escapeTooltipHtml,
} from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";
import { MethodExplanation } from "./MethodExplanation.tsx";

interface TrainingMonotonyChartProps {
  data: TrainingMonotonyWeek[];
  loading?: boolean;
}

export function TrainingMonotonyChart({ data, loading }: TrainingMonotonyChartProps) {
  const method = data[0]?.method;
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
        const dateLabel = formatDateMedium(dataPoint.week);
        return [
          `<strong>${escapeTooltipHtml(dateLabel)}</strong>`,
          `Monotony: <span style="color:${chartColors.blue}">${formatNumber(dataPoint.monotony, 2)}</span>`,
          `Strain: ${formatNumber(dataPoint.strain)}`,
          `Daily mean cycling load: ${formatNumber(dataPoint.dailyMeanLoad, 2)}`,
          `Population standard deviation (SD): ${formatNumber(dataPoint.dailyLoadStandardDeviation, 2)}`,
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
              color: chartColors.blue,
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
      {method ? (
        <MethodExplanation
          className="mb-2"
          lines={[method.formula, method.calendar, method.activityScope, method.interpretation]}
          source={method.source}
        />
      ) : null}
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
