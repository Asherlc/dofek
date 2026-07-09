import type { ClimbingGradeProgressionRow } from "dofek-server/types";
import {
  chartColors,
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
} from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";

interface ClimbingGradeProgressionChartProps {
  data: ClimbingGradeProgressionRow[];
  loading?: boolean;
}

class ClimbingGradeProgressionChartModel {
  readonly #rows: ClimbingGradeProgressionRow[];

  constructor(rows: ClimbingGradeProgressionRow[]) {
    this.#rows = rows;
  }

  get latestRows(): ClimbingGradeProgressionRow[] {
    const latestByType = new Map<string, ClimbingGradeProgressionRow>();
    for (const row of this.#rows) {
      latestByType.set(row.climbType, row);
    }
    return [...latestByType.values()].sort((left, right) =>
      left.climbType.localeCompare(right.climbType),
    );
  }

  option(): Record<string, unknown> {
    return {
      grid: dofekGrid("single", { top: 36, bottom: 42, left: 48 }),
      legend: dofekLegend(true),
      tooltip: dofekTooltip(),
      xAxis: dofekAxis.time(),
      yAxis: dofekAxis.value({ name: "Grade" }),
      series: [
        dofekSeries.line("Boulder", this.#seriesData("boulder"), {
          color: chartColors.emerald,
          symbol: "circle",
          symbolSize: 6,
        }),
        dofekSeries.line("Route", this.#seriesData("route"), {
          color: chartColors.blue,
          symbol: "circle",
          symbolSize: 6,
        }),
      ],
    };
  }

  #seriesData(climbType: ClimbingGradeProgressionRow["climbType"]): Array<[string, number]> {
    return this.#rows
      .filter((row) => row.climbType === climbType)
      .map((row) => [row.date, row.gradeSortValue]);
  }
}

function climbTypeLabel(climbType: ClimbingGradeProgressionRow["climbType"]): string {
  return climbType === "boulder" ? "Boulder" : "Route";
}

export function ClimbingGradeProgressionChart({
  data,
  loading,
}: ClimbingGradeProgressionChartProps) {
  const model = new ClimbingGradeProgressionChartModel(data);

  return (
    <div className="space-y-3">
      <DofekChart
        option={model.option()}
        loading={loading}
        empty={data.length === 0}
        emptyMessage="No climbing grade progression"
        height={280}
      />
      {data.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2">
          {model.latestRows.map((row) => (
            <div key={row.climbType} className="rounded border border-border bg-surface px-3 py-2">
              <div className="text-xs text-dim">{climbTypeLabel(row.climbType)}</div>
              <div className="text-lg font-semibold text-foreground">{row.grade}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
