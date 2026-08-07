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

  get rows(): ClimbingVolumeByGradeRow[] {
    return this.#rows;
  }

  get totalAttempts(): number {
    return this.#rows.reduce((total, row) => total + row.attempts, 0);
  }

  get totalSends(): number {
    return this.#rows.reduce((total, row) => total + row.sends, 0);
  }

  option(): Record<string, unknown> {
    const grades = this.#rows.map((row) => row.grade);
    return {
      grid: dofekGrid("single", { top: 36, bottom: 42, left: 48 }),
      legend: dofekLegend(true),
      tooltip: dofekTooltip(),
      xAxis: dofekAxis.category({ data: grades }),
      yAxis: dofekAxis.value({ name: "Attempts and sends" }),
      series: [
        dofekSeries.bar(
          "Attempts",
          this.#rows.map((row) => row.attempts),
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
    <div className="space-y-3">
      <DofekChart
        option={model.option()}
        loading={loading}
        empty={data.length === 0}
        emptyMessage="No climbing volume by grade"
        height={280}
      />
      {data.length > 0 && (
        <div className="space-y-2">
          <div className="flex gap-4 text-xs text-muted">
            <span>{model.totalAttempts} attempts</span>
            <span>{model.totalSends} sends</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {model.rows.map((row) => (
              <div
                key={`${row.climbType}-${row.gradeSystem}-${row.grade}`}
                className="rounded border border-border bg-surface px-3 py-2"
              >
                <div className="font-semibold text-foreground">{row.grade}</div>
                <div className="text-xs text-dim">{row.attempts} attempts</div>
                <div className="text-xs text-dim">{row.sends} sends</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
