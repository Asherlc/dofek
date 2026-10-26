import type { ClimbingStrengthsCell } from "@dofek/training/climbing-strengths";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, within } from "storybook/test";
import { ClimbingStrengthsChart } from "./ClimbingStrengthsChart.tsx";
import { climbingStrengthsFixture } from "./climbing-strengths-fixtures.ts";

const panel = (() => {
  const value = climbingStrengthsFixture.panels[0];
  if (!value) throw new Error("Missing climbing fixture");
  return value;
})();

// Illustrative server response: pooled results are supplied, never calculated by the UI.
function pooledCell(
  sends: number,
  climbs: number,
  successRate: number | null,
  differencePercentagePoints: number | null,
  sampleStatus: ClimbingStrengthsCell["sampleStatus"] = "available",
): ClimbingStrengthsCell {
  return {
    grade: "All grades",
    sends,
    climbs,
    successRate,
    differencePercentagePoints,
    sampleStatus,
    examples: [],
  };
}
const totals = [
  pooledCell(13, 21, 61.9, 7.9),
  pooledCell(11, 19, 57.9, 3.9),
  pooledCell(10, 23, 43.5, -10.5),
];
const monthlyTotals = [
  [
    pooledCell(2, 4, 50, null, "limited"),
    pooledCell(1, 3, 33.3, null, "limited"),
    pooledCell(1, 1, 100, null, "limited"),
  ],
  [
    pooledCell(0, 0, null, null, "no_data"),
    pooledCell(0, 0, null, null, "no_data"),
    pooledCell(0, 0, null, null, "no_data"),
  ],
  totals,
];
const combinedPanel = {
  ...panel,
  grades: [
    { grade: "All grades", gradeSortValue: 0, sends: 34, climbs: 63, successRate: 54 },
    ...panel.grades,
  ],
  rows: panel.rows.map((row, index) => ({
    ...row,
    cells: [...row.cells, ...totals.slice(index, index + 1)],
  })),
  progress: panel.progress.map((period, index) => ({
    ...period,
    rows: period.rows.map((row, rowIndex) => ({
      ...row,
      cells: [...row.cells, ...(monthlyTotals[index]?.slice(rowIndex, rowIndex + 1) ?? [])],
    })),
  })),
};
const views = [
  { value: "gaps", label: "Style gaps" },
  { value: "exposure", label: "Exposure map" },
  { value: "progress", label: "Progress" },
  { value: "radar", label: "Radar profile" },
] as const;
type View = (typeof views)[number]["value"];

function AllGradesMockup() {
  const [view, setView] = useState<View>("gaps");
  const [grade, setGrade] = useState("All grades");
  const [period, setPeriod] = useState("All time");
  const [selected, setSelected] = useState<{ row: string; grade: string } | null>(null);
  const row = combinedPanel.rows.find((item) => item.key === selected?.row);
  const cell = row?.cells.find((item) => item.grade === selected?.grade);
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-4 text-foreground sm:p-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-2xl font-semibold">Climbing strengths</h1>
        <div className="flex flex-wrap gap-3">
          <label className="text-xs text-muted">
            Period
            <select
              className="ml-2 min-h-11 rounded-lg border border-border bg-surface p-2 text-sm text-foreground"
              value={period}
              onChange={(event) => setPeriod(event.target.value)}
            >
              <option>30 days</option>
              <option>90 days</option>
              <option>1 year</option>
              <option>All time</option>
            </select>
          </label>
          <label className="text-xs text-muted">
            View
            <select
              className="ml-2 min-h-11 rounded-lg border border-border bg-surface p-2 text-sm text-foreground"
              value={view}
              onChange={(event) => {
                const next = views.find((item) => item.value === event.target.value);
                if (next) {
                  setView(next.value);
                  setSelected(null);
                }
              }}
            >
              {views.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-muted">
            Grade
            <select
              className="ml-2 min-h-11 rounded-lg border border-border bg-surface p-2 text-sm text-foreground"
              value={grade}
              onChange={(event) => {
                setGrade(event.target.value);
                setSelected(null);
              }}
            >
              {combinedPanel.grades.map((item) => (
                <option key={item.grade} value={item.grade}>
                  {item.grade}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <section
        aria-label="Climbing strengths chart"
        className="rounded-xl border border-border bg-surface p-4"
      >
        <ClimbingStrengthsChart
          panel={combinedPanel}
          view={view}
          grade={grade}
          selectedRow={selected?.row ?? null}
          onSelectCell={(row, grade) => setSelected({ row, grade })}
        />
      </section>
      {row && cell ? (
        <section
          aria-label="Selected climbs"
          className="space-y-2 rounded-xl border border-border bg-surface p-4"
        >
          <h2 className="font-semibold">{row.label}</h2>
          <p>
            {cell.successRate === null ? "No data" : `${cell.successRate}%`} · {cell.sends} sends /{" "}
            {cell.climbs} climbs
          </p>
          {cell.examples.map((example) => (
            <p key={example.logEntryId}>
              {example.name} · {example.grade} · {example.date}
            </p>
          ))}
        </section>
      ) : null}
      <p className="text-xs text-muted">
        Design prototype · Illustrative data reused across periods.
      </p>
    </main>
  );
}

const meta = {
  title: "Design explorations/Climbing all grades",
  component: AllGradesMockup,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AllGradesMockup>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Combined: Story = {};
export const GradeSelection: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText("Exact values"));
    await expect(
      canvas.getByRole("button", { name: /Vertical · All grades · 61.9%/ }),
    ).toBeVisible();
    await userEvent.selectOptions(canvas.getByLabelText("Grade"), "V4");
    await expect(canvas.getByRole("button", { name: /Vertical · V4 · 50%/ })).toBeVisible();
    await userEvent.selectOptions(canvas.getByLabelText("Grade"), "All grades");
    await userEvent.click(canvas.getByRole("button", { name: /Vertical · All grades · 61.9%/ }));
    await expect(canvas.getByRole("region", { name: "Selected climbs" })).toHaveTextContent(
      "13 sends / 21 climbs",
    );
  },
};
