import type { ClimbingStrengthsPanel } from "@dofek/training/climbing-strengths";
import {
  ALL_CLIMBING_GRADES,
  climbingStrengthsAdjustedLabel,
  climbingStrengthsBaselineLabel,
  climbingStrengthsCountLabel,
  climbingStrengthsRateLabel,
} from "@dofek/training/climbing-strengths";
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
  const baselineLabel =
    view === "curves" || view === "pyramids" || (view === "radar" && grade === ALL_CLIMBING_GRADES)
      ? "Same-grade baseline"
      : climbingStrengthsBaselineLabel(grade);
  const adjustedRadar = view === "radar" && grade === ALL_CLIMBING_GRADES;
  const sparseRadar =
    view === "radar" &&
    panel.rows.filter((row) =>
      adjustedRadar
        ? panel.gradeAdjustedStrengths.some(
            (entry) => entry.key === row.key && entry.differencePercentagePoints !== null,
          )
        : row.cells.some((cell) => cell.grade === grade && cell.successRate !== null),
    ).length < 3;
  const allGrades = view === "curves" || view === "pyramids";
  const baselines =
    view === "curves"
      ? panel.grades
      : view === "radar" && !adjustedRadar
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
      : view === "gaps"
        ? Math.max(300, panel.rows.length * 35 + 100)
        : view === "radar"
          ? Math.max(380, panel.rows.length * 20)
          : 340;
  const adjustedLabel = (key: string) =>
    climbingStrengthsAdjustedLabel(panel.gradeAdjustedStrengths.find((entry) => entry.key === key));
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
              <th scope="col">
                {adjustedRadar ? "Grade-adjusted difference and sample" : "Success and sample"}
              </th>
              {view !== "progress" && !adjustedRadar ? (
                <th scope="col">Gap vs {baselineLabel.toLowerCase()}</th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {baselines.map((baseline) => (
              <tr key={`baseline-${baseline.grade}`} className="border-t border-border">
                <th scope="row" className="py-2 pr-3 font-normal">
                  {climbingStrengthsBaselineLabel(baseline.grade)} · {baseline.grade}
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
                    aria-label={`${row.label} · ${cell.grade}${period ? ` · ${period}` : ""} · ${adjustedRadar ? `${adjustedLabel(row.key)} · ` : ""}${climbingStrengthsValueLabel(cell)}`}
                    aria-pressed={selectedRow === row.key && grade === cell.grade}
                    onClick={() => onSelectCell(row.key, cell.grade)}
                  >
                    {row.label} · {cell.grade}
                    {period ? ` · ${period}` : ""}
                  </button>
                </th>
                <td className="py-2 pr-3">
                  {adjustedRadar ? <span className="block">{adjustedLabel(row.key)}</span> : null}
                  {adjustedRadar
                    ? `${climbingStrengthsRateLabel(cell)} · ${climbingStrengthsCountLabel(cell)}`
                    : climbingStrengthsValueLabel(cell)}
                </td>
                {view !== "progress" && !adjustedRadar ? (
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
          {adjustedRadar
            ? "Grade-adjusted difference on a −100 to +100 percentage-point scale. Dashed line: your same-grade baseline at zero."
            : `Success on a shared 0–100% scale. Dashed line: ${baselineLabel.toLowerCase()}. Groups without a success rate are omitted from the polygon.`}{" "}
          Select a style label to see its climbs.
        </p>
      ) : null}
      {sparseRadar ? (
        <>
          <p className="rounded-lg border border-border p-4 text-sm text-muted">
            {adjustedRadar
              ? "Radar needs at least three styles with known results. Explore the recorded values below."
              : "Radar needs at least three style groups with recorded success at this grade. Choose another grade or use the exact values below."}
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
                if (
                  view === "radar" &&
                  event.componentType === "radar" &&
                  event.targetType === "axisName"
                ) {
                  const row = panel.rows.find((row) => row.label === event.name);
                  if (row?.cells.some((cell) => cell.grade === grade)) onSelectCell(row.key, grade);
                  return;
                }
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
