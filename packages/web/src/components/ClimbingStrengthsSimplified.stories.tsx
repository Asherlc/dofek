import { ALL_CLIMBING_GRADES } from "@dofek/training/climbing-strengths";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import {
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
  seriesColor,
} from "../lib/chartTheme.ts";
import { ClimbingStrengthsChart } from "./ClimbingStrengthsChart.tsx";
import { climbingStrengthsFixture } from "./climbing-strengths-fixtures.ts";
import { DofekChart } from "./DofekChart.tsx";

const views = [
  {
    value: "curves",
    label: "Styles",
    description: "Compare styles across every recorded grade.",
  },
  {
    value: "profile",
    label: "Grades",
    description: "See how your send rate changes with grade for each style.",
  },
  {
    value: "progress",
    label: "Progress",
    description: "See how your send rate changes each month.",
  },
] as const;
function SimplifiedStrengths() {
  const [dimension, setDimension] = useState("wall_angle");
  const [view, setView] = useState<(typeof views)[number]["value"]>("curves");
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
          <h2 className="mb-2 font-medium">
            {view === "curves"
              ? "Send rate across grades"
              : view === "profile"
                ? "Send rate by grade and style"
                : "Monthly send rate"}
          </h2>
          <p className="mb-4 text-sm text-muted">
            {views.find((item) => item.value === view)?.description}
          </p>
          {view === "progress" ? (
            <p className="mb-4 text-xs text-muted">
              Combines all grades; changes can reflect the difficulty of climbs recorded each month.
            </p>
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
                        title={`${cell.sends} sends / ${cell.climbs} climbs`}
                        style={
                          cell.successRate === null
                            ? undefined
                            : {
                                backgroundColor: `color-mix(in srgb, var(--color-accent) calc(${cell.successRate}% * 0.4), var(--color-surface-solid))`,
                              }
                        }
                        className="border-4 border-surface bg-accent/10 p-4 text-center"
                      >
                        {cell.successRate === null ? "No data" : `${cell.successRate}%`}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : view === "progress" ? (
            <DofekChart
              height={340}
              option={{
                animation: false,
                grid: dofekGrid("single", {
                  top: 50,
                  bottom: 40,
                  left: 40,
                  right: 20,
                  containLabel: true,
                }),
                legend: dofekLegend(true),
                tooltip: dofekTooltip({ trigger: "axis" }),
                xAxis: dofekAxis.category({ show: true, data: ["Aug", "Sep", "Oct"] }),
                yAxis: dofekAxis.value({ name: "Send rate (%)", min: 0, max: 100 }),
                series: panel.rows.map((row, index) =>
                  dofekSeries.line(
                    row.label,
                    [
                      [50, 62, 68],
                      [35, 45, 55],
                      [80, 75, 83],
                    ][index] ?? [],
                    { color: seriesColor(index), smooth: false, symbol: "circle", symbolSize: 8 },
                  ),
                ),
              }}
            />
          ) : (
            <ClimbingStrengthsChart
              panel={panel}
              grade={ALL_CLIMBING_GRADES}
              view="curves"
              selectedRow={null}
              onSelectCell={() => {}}
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
