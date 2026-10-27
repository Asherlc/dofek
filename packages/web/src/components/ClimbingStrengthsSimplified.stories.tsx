import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { ClimbingStrengthsChart } from "./ClimbingStrengthsChart.tsx";
import { climbingStrengthsFixture } from "./climbing-strengths-fixtures.ts";

const views = [
  {
    value: "gaps",
    label: "Compare styles",
    description: "See which styles you send more often at the same grade.",
  },
  {
    value: "profile",
    label: "Compare grades",
    description: "See how your send rate changes with grade for each style.",
  },
  {
    value: "progress",
    label: "Track progress",
    description: "See how your send rate changes over the selected period.",
  },
] as const;
function SimplifiedStrengths() {
  const [dimension, setDimension] = useState("wall_angle");
  const [view, setView] = useState<(typeof views)[number]["value"]>("gaps");
  const [grade, setGrade] = useState("V4");
  const panel = climbingStrengthsFixture.panels.find((item) => item.dimension === dimension);
  if (!panel) return null;
  return (
    <main className="min-h-screen bg-bg p-6 text-foreground sm:p-10">
      <section className="mx-auto max-w-4xl rounded-xl border border-border bg-surface p-6">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-lg font-semibold">Climbing strengths</h1>
          <span className="text-sm text-muted">Bouldering · Indoor</span>
        </div>
        <fieldset className="mb-5 flex flex-wrap items-center gap-3" aria-label="Analyze">
          <legend className="mb-2 text-xs text-muted">Analyze</legend>
          {[
            { value: "wall_angle", label: "Wall angle" },
            { value: "hold_type", label: "Hold type" },
          ].map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={dimension === item.value}
              onClick={() => setDimension(item.value)}
              className={`min-h-10 rounded-lg border px-4 text-sm ${dimension === item.value ? "border-accent bg-accent/10 text-accent" : "border-border text-muted"}`}
            >
              {item.label}
            </button>
          ))}
        </fieldset>
        <div className="flex flex-wrap items-center justify-between gap-x-4 border-b border-border">
          <fieldset aria-label="View" className="flex flex-wrap gap-6">
            {views.map((item) => (
              <button
                key={item.value}
                type="button"
                aria-pressed={view === item.value}
                onClick={() => setView(item.value)}
                className={`min-h-11 border-b-2 pb-3 text-sm ${view === item.value ? "border-accent font-medium text-accent" : "border-transparent text-muted"}`}
              >
                {item.label}
              </button>
            ))}
          </fieldset>
        </div>
        <div className="mt-5 rounded-lg border border-border p-4">
          <p className="mb-4 text-sm text-muted">
            {views.find((item) => item.value === view)?.description}
          </p>
          {view !== "profile" ? (
            <label className="mb-5 flex flex-wrap items-center gap-3 text-sm text-foreground">
              {view === "progress" ? "Track climbs at grade" : "Compare climbs at grade"}
              <select
                value={grade}
                onChange={(event) => setGrade(event.target.value)}
                className="min-h-10 rounded-lg border border-border bg-surface px-3 text-sm text-foreground"
              >
                {panel.grades.map((item) => (
                  <option key={item.grade}>{item.grade}</option>
                ))}
              </select>
            </label>
          ) : null}
          {view === "profile" ? (
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="p-3 text-left font-normal text-muted">Style</th>
                  {panel.grades.map((item) => (
                    <th key={item.grade} className="p-3 font-normal text-muted">
                      {item.grade}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {panel.rows.map((row) => (
                  <tr key={row.key}>
                    <th className="p-3 text-left font-normal">{row.label}</th>
                    {row.cells.map((cell) => (
                      <td
                        key={cell.grade}
                        className="border-4 border-surface bg-accent/10 p-4 text-center"
                      >
                        {cell.successRate === null ? "No data" : `${cell.successRate}%`}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <ClimbingStrengthsChart
              panel={panel}
              grade={grade}
              view={view}
              selectedRow={null}
              onSelectCell={(_row, value) => setGrade(value)}
            />
          )}
        </div>
      </section>
      <p className="mx-auto mt-4 max-w-4xl text-xs text-muted">Layout preview · Example data</p>
    </main>
  );
}
const meta = {
  title: "Design explorations/Simpler climbing strengths",
  component: SimplifiedStrengths,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof SimplifiedStrengths>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Simplified: Story = {};

function AllGradesStrengths() {
  const [dimension, setDimension] = useState("wall_angle");
  const panel = climbingStrengthsFixture.panels.find((item) => item.dimension === dimension);
  if (!panel) return null;
  return (
    <main className="min-h-screen bg-bg p-6 text-foreground sm:p-10">
      <section className="mx-auto max-w-4xl rounded-xl border border-border bg-surface p-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-lg font-semibold">Climbing strengths</h1>
          <span className="text-sm text-muted">Bouldering · Indoor</span>
        </div>
        <fieldset aria-label="Analyze" className="mb-5 flex gap-2">
          {[
            { value: "wall_angle", label: "Wall angle" },
            { value: "hold_type", label: "Hold type" },
          ].map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={dimension === item.value}
              onClick={() => setDimension(item.value)}
              className={`min-h-10 rounded-lg border px-4 text-sm ${dimension === item.value ? "border-accent bg-accent/10 text-accent" : "border-border text-muted"}`}
            >
              {item.label}
            </button>
          ))}
        </fieldset>
        <h2 className="font-medium">Send rate across grades</h2>
        <p className="mb-5 mt-1 text-sm text-muted">
          Compare styles at every difficulty. Hover over a point for its recorded climbs.
        </p>
        <ClimbingStrengthsChart
          panel={panel}
          view="curves"
          grade="All grades"
          selectedRow={null}
          onSelectCell={() => {}}
        />
        <p className="mt-3 text-xs text-muted">
          Missing observations leave gaps. Hollow points indicate limited samples.
        </p>
      </section>
      <p className="mx-auto mt-4 max-w-4xl text-xs text-muted">Layout preview · Example data</p>
    </main>
  );
}

export const GradeAsAxis: Story = { render: () => <AllGradesStrengths /> };
