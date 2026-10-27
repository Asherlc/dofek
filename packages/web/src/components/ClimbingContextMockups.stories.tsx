import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, within } from "storybook/test";
import { ClimbingStrengths } from "./ClimbingStrengths.tsx";
import { climbingStrengthsFixture } from "./climbing-strengths-fixtures.ts";

// Design prototypes only. All contexts reuse illustrative strengths data.
const contexts = [
  {
    id: "boulder-free",
    kind: "Bouldering",
    method: null,
    label: "Bouldering",
    detail: "V scale · Free climbing",
  },
  {
    id: "lead-free",
    kind: "Routes",
    method: "Lead",
    label: "Lead",
    detail: "YDS · Free climbing",
  },
  {
    id: "top-rope-free",
    kind: "Routes",
    method: "Top rope",
    label: "Top rope",
    detail: "YDS · Free climbing",
  },
] as const;
type Context = (typeof contexts)[number];

const buttonClass =
  "min-h-11 rounded-lg border px-4 py-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent";
function choiceClass(selected: boolean) {
  return `${buttonClass} ${selected ? "border-accent bg-accent/10 text-accent" : "border-border bg-surface text-muted hover:text-foreground"}`;
}

function Choices({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly string[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-xs font-medium text-muted">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={value === option}
            className={choiceClass(value === option)}
            onClick={() => onChange(option)}
          >
            {option}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function StrengthsPreview({ context }: { context: Context }) {
  const routeGrades = ["5.9", "5.10a", "5.10b", "5.11a"];
  const gradeLabel = (grade: string) =>
    context.kind === "Routes"
      ? (routeGrades[["V3", "V4", "V5", "V6"].indexOf(grade)] ?? grade)
      : grade;
  const data = {
    ...climbingStrengthsFixture,
    panels: climbingStrengthsFixture.panels.map((panel) => ({
      ...panel,
      contextKey: context.id,
      contextLabel: `${context.label} · ${context.detail}`,
      grades: panel.grades.map((grade) => ({ ...grade, grade: gradeLabel(grade.grade) })),
      rows: panel.rows.map((row) => ({
        ...row,
        cells: row.cells.map((cell) => ({
          ...cell,
          grade: gradeLabel(cell.grade),
          examples: cell.examples.map((example) => ({
            ...example,
            grade: gradeLabel(example.grade),
            activityId: null,
            sourceUrl: null,
          })),
        })),
      })),
      progress: panel.progress.map((period) => ({
        ...period,
        rows: period.rows.map((row) => ({
          ...row,
          cells: row.cells.map((cell) => ({ ...cell, grade: gradeLabel(cell.grade) })),
        })),
      })),
    })),
  };
  return <ClimbingStrengths key={context.id} data={data} />;
}

function ClimbingContextMockup({ variant }: { variant: "filters" | "picker" }) {
  const [context, setContext] = useState<Context>(contexts[0]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [period, setPeriod] = useState("90 days");
  function select(next: Context) {
    setContext(next);
    setPickerOpen(false);
  }
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-4 text-foreground sm:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-widest text-accent">
            Interactive concept {variant === "filters" ? "A" : "B"}
          </p>
          <h1 className="text-2xl font-semibold">Climbing strengths</h1>
          <p className="mt-1 text-sm text-muted">
            Find your strengths across grades and climbing styles.
          </p>
        </div>
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
      </div>
      <section
        aria-label="Climbing selection"
        className="space-y-5 rounded-xl border border-border bg-surface p-5"
      >
        {variant === "filters" ? (
          <>
            <Choices
              label="Climbing"
              options={["Bouldering", "Routes"]}
              value={context.kind}
              onChange={(kind) => {
                const next = contexts.find((item) => item.kind === kind);
                if (next) select(next);
              }}
            />
            <div className="flex flex-wrap gap-6">
              {context.kind === "Routes" && (
                <Choices
                  label="Rope method"
                  options={["Lead", "Top rope"]}
                  value={context.method ?? ""}
                  onChange={(method) => {
                    const next = contexts.find((item) => item.method === method);
                    if (next) select(next);
                  }}
                />
              )}
            </div>
          </>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs text-muted">Comparing</p>
                <p className="mt-1 text-lg font-medium" aria-live="polite">
                  {context.label}{" "}
                  <span className="text-sm font-normal text-muted">· {context.detail}</span>
                </p>
              </div>
              <button
                type="button"
                aria-expanded={pickerOpen}
                aria-controls="context-choices"
                className={choiceClass(pickerOpen)}
                onClick={() => setPickerOpen(!pickerOpen)}
              >
                Change context {pickerOpen ? "−" : "+"}
              </button>
            </div>
            {pickerOpen && (
              <div
                id="context-choices"
                className="grid gap-5 border-t border-border pt-4 sm:grid-cols-2"
              >
                {["Bouldering", "Routes"].map((kind) => (
                  <fieldset key={kind} className="space-y-2">
                    <legend className="mb-2 text-sm font-medium">{kind}</legend>
                    {contexts
                      .filter((item) => item.kind === kind)
                      .map((item) => (
                        <button
                          type="button"
                          key={item.id}
                          aria-pressed={context.id === item.id}
                          className={`${choiceClass(context.id === item.id)} flex w-full items-center justify-between gap-3 text-left`}
                          onClick={() => select(item)}
                        >
                          <span>
                            <span className="block font-medium">{item.label}</span>
                            <span className="block text-xs text-muted">{item.detail}</span>
                          </span>
                          {context.id === item.id && <span aria-hidden="true">✓</span>}
                        </button>
                      ))}
                  </fieldset>
                ))}
              </div>
            )}
          </div>
        )}
      </section>
      <section
        aria-label="Strengths preview"
        className="rounded-xl border border-border bg-surface p-4 sm:p-5"
      >
        <StrengthsPreview context={context} />
      </section>
      <p className="text-xs text-muted">
        Design prototype · Illustrative data reused across contexts and periods. Try changing
        context, view, or grade, then select a cell to inspect climbs.
      </p>
    </main>
  );
}

const meta = {
  title: "Design explorations/Climbing context",
  component: ClimbingContextMockup,
  parameters: { layout: "fullscreen" },
  args: { variant: "filters" },
} satisfies Meta<typeof ClimbingContextMockup>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SeparateFilters: Story = {};
export const GroupedPicker: Story = { args: { variant: "picker" } };
export const NarrowFilters: Story = {
  globals: { viewport: { value: "mobile1", isRotated: false } },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 390, margin: "0 auto" }}>
        <Story />
      </div>
    ),
  ],
};
export const FiltersInteraction: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Routes" }));
    await userEvent.click(canvas.getByRole("button", { name: "Top rope" }));
    await expect(canvas.getByRole("button", { name: "Top rope" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Grades" }));
    await expect(canvas.getByRole("columnheader", { name: "5.10a" })).toBeVisible();
    await userEvent.selectOptions(canvas.getByLabelText("Period"), "All time");
    await expect(canvas.getByLabelText("Period")).toHaveValue("All time");
  },
};
export const PickerInteraction: Story = {
  args: { variant: "picker" },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /Change context/ }));
    await userEvent.click(canvas.getByRole("button", { name: "Lead YDS · Free climbing" }));
    await expect(canvas.getByRole("button", { name: /Change context/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Grades" }));
    await expect(canvas.getByRole("columnheader", { name: "5.10a" })).toBeVisible();
  },
};
