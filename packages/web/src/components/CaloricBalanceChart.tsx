import { statusColors } from "@dofek/scoring/colors";
import type { CaloricBalanceRow } from "../../../server/src/routers/nutrition-analytics.ts";
import {
  chartColors,
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
} from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";

interface CaloricBalanceChartProps {
  data: CaloricBalanceRow[];
  loading?: boolean;
}

export function CaloricBalanceChart({ data, loading }: CaloricBalanceChartProps) {
  const option = {
    grid: dofekGrid("single", { left: 50 }),
    tooltip: dofekTooltip(),
    legend: dofekLegend(true),
    xAxis: dofekAxis.time(),
    yAxis: dofekAxis.value({ name: "kcal" }),
    series: [
      {
        ...dofekSeries.bar(
          "Balance",
          data.map((d) => [d.date, d.balance]),
        ),
        itemStyle: {
          color: (params: { value: [string, number] }) =>
            params.value[1] >= 0 ? chartColors.green : statusColors.danger,
        },
      },
      dofekSeries.line(
        "7-day Avg",
        data.filter((d) => d.rollingAvgBalance != null).map((d) => [d.date, d.rollingAvgBalance]),
        { color: chartColors.purple },
      ),
    ],
  };

  return (
    <DofekChart
      option={option}
      loading={loading}
      empty={data.length === 0}
      emptyMessage="Need both nutrition and energy expenditure data"
    />
  );
}
