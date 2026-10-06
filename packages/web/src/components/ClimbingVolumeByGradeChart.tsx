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

  option(): Record<string, unknown> {
    const grades = this.#rows.map((row) => row.grade);
    return {
      grid: dofekGrid("single", { top: 36, bottom: 42, left: 48 }),
      legend: dofekLegend(true),
      tooltip: dofekTooltip(),
      xAxis: dofekAxis.category({ data: grades }),
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
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {model.rows.map((row) => (
              <div
                key={`${row.climbType}-${row.gradeSystem}-${row.grade}`}
                className="rounded border border-border bg-surface px-3 py-2"
              >
                <div className="font-semibold text-foreground">{row.grade}</div>
                {(row.attempts ?? row.recordedAttempts) !== null && (
                  <div className="text-xs text-dim">
                    {row.attempts !== null
                      ? `${row.attempts} attempts`
                      : `${row.recordedAttempts} recorded attempts`}
                  </div>
                )}
                <div className="text-xs text-dim">{row.sends} sends</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
