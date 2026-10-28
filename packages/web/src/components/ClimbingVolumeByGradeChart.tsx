import type { ClimbingVolumeByGradeRow } from "dofek-server/types";
import {
  chartColors,
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
} from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";

interface ClimbingVolumeByGradeChartProps {
  data: ClimbingVolumeByGradeRow[];
  loading?: boolean;
}

class ClimbingVolumeByGradeChartModel {
  readonly #rows: ClimbingVolumeByGradeRow[];

  constructor(rows: ClimbingVolumeByGradeRow[]) {
    this.#rows = [...rows].sort((left, right) => left.gradeSortValue - right.gradeSortValue);
  }

  option(): Record<string, unknown> {
    const grades = this.#rows.map((row) => row.grade);
    return {
      grid: dofekGrid("single", { top: 36, bottom: 42, left: 48 }),
      legend: dofekLegend(true),
      tooltip: dofekTooltip(),
      xAxis: dofekAxis.category({ data: grades, show: true }),
      yAxis: dofekAxis.value({ name: "Recorded attempts and sends" }),
      series: [
        dofekSeries.bar(
          "Recorded attempts",
          this.#rows.map((row) => row.attempts ?? row.recordedAttempts),
          { color: chartColors.blue },
        ),
        dofekSeries.bar(
          "Sends",
          this.#rows.map((row) => row.sends),
          { color: chartColors.emerald },
        ),
      ],
    };
  }
}

export function ClimbingVolumeByGradeChart({ data, loading }: ClimbingVolumeByGradeChartProps) {
  const model = new ClimbingVolumeByGradeChartModel(data);

  return (
    <DofekChart
      option={model.option()}
      loading={loading}
      empty={data.length === 0}
      emptyMessage="No climbing volume by grade"
      height={280}
    />
  );
}
