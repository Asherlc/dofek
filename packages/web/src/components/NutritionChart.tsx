import { statusColors } from "@dofek/scoring/colors";
import {
  chartColors,
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
} from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";

interface NutritionData {
  date: string;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
}

interface NutritionChartProps {
  data: NutritionData[];
  loading?: boolean;
}

export function NutritionChart({ data, loading }: NutritionChartProps) {
  const option = {
    grid: dofekGrid("dualAxis"),
    tooltip: dofekTooltip(),
    xAxis: dofekAxis.time(),
    yAxis: [
      dofekAxis.value({ name: "kcal", position: "left" }),
      dofekAxis.value({ name: "grams", position: "right", showSplitLine: false }),
    ],
    legend: dofekLegend(true),
    series: [
      dofekSeries.bar(
        "Calories",
        data.map((d) => [d.date, d.calories]),
        {
          color: chartColors.amber,
          itemStyle: { opacity: 0.6 },
        },
      ),
      dofekSeries.line(
        "Protein",
        data.map((d) => [d.date, d.protein_g]),
        {
          color: statusColors.danger,
          yAxisIndex: 1,
        },
      ),
      dofekSeries.line(
        "Carbs",
        data.map((d) => [d.date, d.carbs_g]),
        {
          color: chartColors.blue,
          yAxisIndex: 1,
        },
      ),
      dofekSeries.line(
        "Fat",
        data.map((d) => [d.date, d.fat_g]),
        {
          color: chartColors.purple,
          yAxisIndex: 1,
        },
      ),
    ],
  };

  return (
    <DofekChart
      option={option}
      loading={loading}
      empty={data.length === 0}
      emptyMessage="No nutrition data"
      height={200}
    />
  );
}
