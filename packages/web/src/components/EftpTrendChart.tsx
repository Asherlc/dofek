import type { TrainingChartAvailability } from "dofek-server/types";
import {
  chartColors,
  chartThemeColors,
  dofekAxis,
  dofekGrid,
  dofekSeries,
  dofekTooltip,
  escapeTooltipHtml,
} from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";
import { TrainingChartEmptyState } from "./TrainingChartEmptyState.tsx";

interface EftpPoint {
  date: string;
  eftp: number;
  activityName: string | null;
}

interface EftpTrendChartProps {
  data: EftpPoint[];
  currentEftp: number | null;
  loading?: boolean;
  availability?: TrainingChartAvailability;
}

export function EftpTrendChart({ data, currentEftp, loading, availability }: EftpTrendChartProps) {
  if (!loading && availability?.status === "insufficient_data") {
    return <TrainingChartEmptyState availability={availability} />;
  }

  const markLine =
    currentEftp != null
      ? {
          silent: true,
          symbol: "none" as const,
          lineStyle: { color: chartColors.orange, type: "dashed" as const, width: 1 },
          label: {
            formatter: `Threshold: ${currentEftp}W`,
            color: chartColors.orange,
            fontSize: 11,
          },
          data: [{ yAxis: currentEftp }],
          tooltip: { show: false },
        }
      : undefined;

  const option = {
    grid: dofekGrid("single", { top: 30, left: 55 }),
    tooltip: dofekTooltip({
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
        const lines = [`<strong>${watts}W</strong>`, escapeTooltipHtml(point.axisValueLabel)];
        if (name) {
          lines.push(
            `<span style="color:${chartThemeColors.legendText}">${escapeTooltipHtml(name)}</span>`,
          );
        }
        return lines.join("<br/>");
      },
    }),
    xAxis: dofekAxis.time(),
    yAxis: dofekAxis.value({ name: "Est. Threshold Power (W)", min: "dataMin" }),
    series: [
      {
        ...dofekSeries.line(
          "Est. Threshold Power",
          data.map((d) => [d.date, d.eftp]),
          {
            color: chartColors.orange,
            symbol: "circle",
            symbolSize: 5,
            areaStyle: { opacity: 0.08 },
          },
        ),
        markLine,
      },
    ],
  };

  return (
    <DofekChart
      option={option}
      loading={loading}
      empty={data.length === 0}
      height={240}
      emptyMessage="No threshold power data (need 20+ min activities with power)"
    />
  );
}
