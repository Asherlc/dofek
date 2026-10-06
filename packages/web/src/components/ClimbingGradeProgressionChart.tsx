import { formatDateMedium, formatDateShort } from "@dofek/format/format";
import { gradeOptionsForSystem, gradeSortValue } from "@dofek/training/climbing-grades";
import type { ClimbingGradeProgressionRow } from "dofek-server/types";
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

interface ClimbingGradeProgressionChartProps {
  data: ClimbingGradeProgressionRow[];
  loading?: boolean;
}

class ClimbingGradeProgressionChartModel {
  readonly #rows: ClimbingGradeProgressionRow[];

  constructor(rows: ClimbingGradeProgressionRow[]) {
    this.#rows = [...rows].sort((left, right) => left.date.localeCompare(right.date));
  }

  get latestRows(): ClimbingGradeProgressionRow[] {
    const latestByType = new Map<string, ClimbingGradeProgressionRow>();
    for (const row of this.#rows) {
      const existing = latestByType.get(row.climbType);
      if (!existing || row.date > existing.date) {
        latestByType.set(row.climbType, row);
      }
    }
    return [...latestByType.values()].sort((left, right) =>
      left.climbType.localeCompare(right.climbType),
    );
  }

  option(): Record<string, unknown> {
    const hasBoulder = this.#rows.some((row) => row.climbType === "boulder");
    const hasRoute = this.#rows.some((row) => row.climbType === "route");
    return {
      grid: dofekGrid(hasBoulder && hasRoute ? "dualAxis" : "single", {
        top: 50,
        bottom: 42,
        left: 64,
        right: hasBoulder && hasRoute ? 64 : 20,
      }),
      legend: dofekLegend(true),
      tooltip: dofekTooltip({
        formatter: (params: Array<{ seriesIndex: number; dataIndex: number }>) => {
          const rows = params.flatMap((param) => {
            const row = this.#rowsForType(param.seriesIndex === 0 ? "boulder" : "route")[
              param.dataIndex
            ];
            return row ? [row] : [];
          });
          const first = rows[0];
          if (!first) return "";
          return [
            `<strong>${escapeTooltipHtml(formatDateMedium(first.date, { timeZone: "UTC" }))}</strong>`,
            ...rows.map(
              (row) =>
                `${climbTypeLabel(row.climbType)}: <strong>${escapeTooltipHtml(row.grade)}</strong>`,
            ),
          ].join("<br/>");
        },
      }),
      xAxis: dofekAxis.time({
        show: true,
        axisLabel: {
          formatter: (value: number) => formatDateShort(value),
          hideOverlap: true,
        },
      }),
      yAxis: [this.#gradeAxis("boulder", false), this.#gradeAxis("route", hasBoulder)],
      series: [
        dofekSeries.line("Boulder", this.#seriesData("boulder"), {
          color: chartColors.emerald,
          symbol: "circle",
          symbolSize: 6,
          smooth: false,
        }),
        dofekSeries.line("Route", this.#seriesData("route"), {
          color: chartColors.blue,
          yAxisIndex: 1,
          symbol: "circle",
          symbolSize: 6,
          smooth: false,
        }),
      ],
    };
  }

  #rowsForType(climbType: ClimbingGradeProgressionRow["climbType"]): ClimbingGradeProgressionRow[] {
    return this.#rows.filter((row) => row.climbType === climbType);
  }

  #seriesData(climbType: ClimbingGradeProgressionRow["climbType"]): Array<{
    name: string;
    displayValue: string;
    value: [number, number];
  }> {
    return this.#rowsForType(climbType).map((row) => ({
      name: formatDateMedium(row.date, { timeZone: "UTC" }),
      displayValue: row.grade,
      // Match ECharts' local calendar parsing of the selected date-range boundaries.
      value: [Date.parse(`${row.date}T00:00:00`), row.gradeSortValue],
    }));
  }

  #gradeAxis(climbType: ClimbingGradeProgressionRow["climbType"], onRight: boolean) {
    const rows = this.#rowsForType(climbType);
    const latest = rows.at(-1);
    const grades = latest
      ? gradeOptionsForSystem(latest.gradeSystem)
          .flatMap((grade) => {
            const score = gradeSortValue(grade, latest.gradeSystem);
            return score === null ? [] : [{ grade, score }];
          })
          .sort((left, right) => left.score - right.score)
      : [];
    const scores = rows.map((row) => row.gradeSortValue);
    const lowest = Math.min(...scores);
    const highest = Math.max(...scores);
    const lower = [...grades].reverse().find((grade) => grade.score < lowest)?.score ?? lowest;
    const upper = grades.find((grade) => grade.score > highest)?.score ?? highest;
    const candidates = grades.filter((grade) => grade.score >= lower && grade.score <= upper);
    // Cap density while placing every tick at a real grade's normalized score.
    const stride = Math.max(1, Math.ceil((candidates.length - 1) / 5));
    const ticks = candidates.filter(
      (_grade, index) => index % stride === 0 || index === candidates.length - 1,
    );
    const labels = new Map(ticks.map(({ grade, score }) => [score, grade]));
    const customValues = ticks.map((grade) => grade.score);
    return {
      ...dofekAxis.value({
        name: `${climbTypeLabel(climbType)} Grade`,
        position: onRight ? "right" : "left",
        showSplitLine: !onRight,
        min: latest ? lower : 0,
        max: latest ? upper : 1,
        axisLabel: {
          customValues,
          formatter: (value: number) => labels.get(value) ?? "",
          hideOverlap: true,
        },
      }),
      show: rows.length > 0,
      axisTick: { show: true, customValues },
      axisPointer: { label: { show: false } },
    };
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
