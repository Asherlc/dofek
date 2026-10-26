import type { ClimbingStrengthsPanel } from "@dofek/training/climbing-strengths";
import type { ClimbingStrengthsView } from "@dofek/training/climbing-strengths-views";
import {
  climbingStrengthsChartOption,
  climbingStrengthsValueLabel,
} from "./climbing-strengths-chart-options.ts";
import { DofekChart } from "./DofekChart.tsx";

export function ClimbingStrengthsChart({
  panel,
  view,
  grade,
  selectedRow,
  onSelectCell,
}: {
  panel: ClimbingStrengthsPanel;
  view: Exclude<ClimbingStrengthsView, "profile">;
  grade: string;
  selectedRow: string | null;
  onSelectCell: (rowKey: string, grade: string) => void;
}) {
  const sparseRadar =
    view === "radar" &&
    panel.rows.filter((row) =>
      row.cells.some((cell) => cell.grade === grade && cell.successRate !== null),
    ).length < 3;
  const allGrades = view === "curves" || view === "pyramids";
  const baselines =
    view === "curves"
      ? panel.grades
      : view === "radar"
        ? panel.grades.filter((item) => item.grade === grade)
        : [];
  const exact =
    view === "progress"
      ? panel.progress.flatMap((period) =>
          panel.rows.flatMap((row) => {
            const cell = period.rows
              .find((item) => item.key === row.key)
              ?.cells.find((item) => item.grade === grade);
            return cell ? [{ row, cell, period: `${period.startDate} – ${period.endDate}` }] : [];
          }),
        )
      : panel.rows.flatMap((row) =>
          row.cells
            .filter((cell) => allGrades || cell.grade === grade)
            .map((cell) => ({ row, cell, period: "" })),
        );
  const height =
    view === "pyramids"
      ? 40 + panel.rows.length * (panel.grades.length * 28 + 100)
      : view === "progress"
        ? 40 + panel.rows.length * 190
        : view === "gaps"
          ? Math.max(300, panel.rows.length * 35 + 100)
          : view === "radar"
            ? Math.max(380, panel.rows.length * 20)
            : 340;
  const dataDisclosure = (
    <details className="text-xs text-muted">
      <summary className="cursor-pointer py-2 font-medium text-foreground">Exact values</summary>
      <div className="max-h-96 overflow-auto">
        <table className="w-full text-left">
          <caption className="sr-only">
            Selectable climbing strengths values
            {view === "progress" ? " by calendar month; selection opens whole-period climbs" : ""}
          </caption>
          <thead>
            <tr>
              <th scope="col">Style / grade{view === "progress" ? " / month" : ""}</th>
              <th scope="col">Success and sample</th>
              {view !== "progress" ? <th scope="col">Gap vs same-grade baseline</th> : null}
            </tr>
          </thead>
          <tbody>
            {baselines.map((baseline) => (
              <tr key={`baseline-${baseline.grade}`} className="border-t border-border">
                <th scope="row" className="py-2 pr-3 font-normal">
                  Same-grade baseline · {baseline.grade}
                </th>
                <td className="py-2 pr-3">{climbingStrengthsValueLabel(baseline)}</td>
                <td>Baseline</td>
              </tr>
            ))}
            {exact.map(({ row, cell, period }) => (
              <tr
                key={JSON.stringify([row.key, cell.grade, period])}
                className="border-t border-border"
              >
                <th scope="row" className="font-normal">
                  <button
                    type="button"
                    className="min-h-11 py-2 pr-3 text-left text-accent"
                    aria-label={`${row.label} · ${cell.grade}${period ? ` · ${period}` : ""} · ${climbingStrengthsValueLabel(cell)}`}
                    aria-pressed={selectedRow === row.key && grade === cell.grade}
                    onClick={() => onSelectCell(row.key, cell.grade)}
                  >
                    {row.label} · {cell.grade}
                    {period ? ` · ${period}` : ""}
                  </button>
                </th>
                <td className="py-2 pr-3">{climbingStrengthsValueLabel(cell)}</td>
                {view !== "progress" ? (
                  <td>
                    {"differencePercentagePoints" in cell &&
                    typeof cell.differencePercentagePoints === "number"
                      ? `${cell.differencePercentagePoints > 0 ? "+" : ""}${cell.differencePercentagePoints} percentage points`
                      : "No comparison"}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
  return (
    <div className="space-y-3">
      {view === "progress" ? (
        <p className="text-xs text-muted">
          Each climb counts once in each month it was tried; monthly counts need not sum to the
          whole period. Select a point for climbs across the selected period.
        </p>
      ) : null}
      {view === "radar" ? (
        <p className="text-xs text-muted">
          Success on a shared 0–100% scale. Dashed line: same-grade baseline. Groups without a
          success rate are omitted from the polygon.
        </p>
      ) : null}
      {sparseRadar ? (
        <>
          <p className="rounded-lg border border-border p-4 text-sm text-muted">
            Radar needs at least three style groups with recorded success at this grade. Choose
            another grade or use the exact values below.
          </p>
          {dataDisclosure}
        </>
      ) : (
        <div className="overflow-auto">
          <DofekChart
            option={climbingStrengthsChartOption(panel, view, grade, selectedRow)}
            height={height}
            timeRangeMode="data"
            dataDisclosure={dataDisclosure}
            onEvents={{
              click: (event) => {
                const data = event.data;
                if (
                  !data ||
                  typeof data !== "object" ||
                  !("rowKey" in data) ||
                  !("grade" in data) ||
                  typeof data.rowKey !== "string" ||
                  typeof data.grade !== "string"
                )
                  return;
                const row = panel.rows.find((row) => row.key === data.rowKey);
                if (row?.cells.some((cell) => cell.grade === data.grade))
                  onSelectCell(data.rowKey, data.grade);
              },
            }}
          />
        </div>
      )}
    </div>
  );
}
