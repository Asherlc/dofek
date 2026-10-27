import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

type Variant = "nested" | "compact" | "sections";
const disciplines = ["Bouldering", "Lead", "Top rope"];
const settings = ["All", "Indoor", "Outdoor"];
const observations = {
  All: [
    [83, 63, 38],
    [75, 53, 30],
    [63, 42, 25],
  ],
  Indoor: [
    [90, 75, 50],
    [83, 67, 40],
    [75, 50, 33],
  ],
  Outdoor: [
    [75, 50, 25],
    [67, 40, 20],
    [50, 33, 17],
  ],
};
type Setting = keyof typeof observations;

function ClimbingSettingMockup({ variant }: { variant: Variant }) {
  const [discipline, setDiscipline] = useState("Bouldering");
  const [setting, setSetting] = useState<Setting>("All");
  const [breakdown, setBreakdown] = useState("Wall angle");
  const [view, setView] = useState("Grade profile");
  const grades = discipline === "Bouldering" ? ["V3", "V4", "V5"] : ["5.10", "5.11", "5.12"];
  const rows =
    breakdown === "Wall angle"
      ? ["Slab", "Vertical", "Overhang"]
      : ["Crimps", "Slopers", "Pinches"];
  const selectClass =
    "min-h-11 rounded-lg border border-border bg-surface px-3 text-sm text-foreground";

  function chart(selectedSetting: Setting) {
    const values = observations[selectedSetting];
    const title =
      variant === "sections"
        ? selectedSetting
        : `${discipline} · ${selectedSetting === "All" ? "All settings" : selectedSetting}`;
    return (
      <section key={selectedSetting} className="min-w-0 space-y-4" aria-label={title}>
        <h3 className="font-medium">{title}</h3>
        {view === "Grade profile" ? (
          <table
            className="w-full table-fixed border-separate border-spacing-1 text-sm"
            aria-label={`${title} example success rates`}
          >
            <thead>
              <tr>
                <th scope="col" className="w-[30%] text-left text-xs font-normal text-muted">
                  {breakdown}
                </th>
                {grades.map((grade) => (
                  <th key={grade} scope="col" className="py-2 font-normal text-muted">
                    {grade}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row}>
                  <th scope="row" className="text-left font-normal">
                    {row}
                  </th>
                  {values[index]?.map((value, column) => (
                    <td
                      key={grades[column]}
                      className={`rounded-md py-3 text-center tabular-nums ${value >= 65 ? "bg-accent/25" : "bg-accent/10"}`}
                    >
                      {value}%
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="space-y-5">
            {rows.map((row, index) => (
              <div key={row}>
                <div className="mb-2 flex justify-between text-sm">
                  <span>
                    {row} · {grades[1]}
                  </span>
                  <span>{values[index]?.[1]}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded bg-accent/10">
                  <div className="h-full bg-accent" style={{ width: `${values[index]?.[1]}%` }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    );
  }

  return (
    <main className="min-h-screen bg-bg p-4 text-foreground sm:p-8">
      <section className="mx-auto max-w-3xl rounded-xl border border-border bg-surface p-4 sm:p-6">
        <h1 className="mb-6 text-lg font-semibold uppercase tracking-wider">Climbing strengths</h1>
        <fieldset
          aria-label="Discipline"
          className="mb-5 flex flex-wrap gap-6 border-b border-border"
        >
          {disciplines.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={discipline === item}
              onClick={() => setDiscipline(item)}
              className={`min-h-11 border-b-2 pb-3 text-sm font-medium ${discipline === item ? "border-accent text-accent" : "border-transparent text-muted"}`}
            >
              {item}
            </button>
          ))}
        </fieldset>
        {variant === "nested" && (
          <fieldset className="mb-6 flex flex-wrap items-center gap-3">
            <legend className="mb-2 text-xs text-muted">Setting</legend>
            <div className="flex rounded-lg bg-accent/10 p-1">
              {settings.map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-pressed={setting === item}
                  onClick={() => {
                    if (item === "All" || item === "Indoor" || item === "Outdoor") setSetting(item);
                  }}
                  className={`min-h-10 rounded-md px-4 text-sm ${setting === item ? "bg-surface text-accent shadow-sm" : "text-muted"}`}
                >
                  {item}
                </button>
              ))}
            </div>
          </fieldset>
        )}
        <div className="mb-6 flex flex-wrap gap-4 border-b border-border pb-5">
          {variant === "compact" && (
            <label className="flex min-w-32 flex-1 flex-col gap-2 text-xs text-muted">
              Setting
              <select
                className={selectClass}
                value={setting}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === "All" || value === "Indoor" || value === "Outdoor")
                    setSetting(value);
                }}
              >
                {settings.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
          )}
          <label className="flex min-w-32 flex-1 flex-col gap-2 text-xs text-muted">
            Break down by
            <select
              className={selectClass}
              value={breakdown}
              onChange={(event) => setBreakdown(event.target.value)}
            >
              <option>Wall angle</option>
              <option>Hold type</option>
            </select>
          </label>
          <label className="flex min-w-32 flex-1 flex-col gap-2 text-xs text-muted">
            View
            <select
              className={selectClass}
              value={view}
              onChange={(event) => setView(event.target.value)}
            >
              <option>Grade profile</option>
              <option>Success rate</option>
            </select>
          </label>
        </div>
        <div aria-live="polite">
          {variant === "sections" ? (
            <div className="grid gap-8 sm:grid-cols-2">
              {chart("Indoor")}
              {chart("Outdoor")}
            </div>
          ) : (
            chart(setting)
          )}
        </div>
        <p className="mt-6 text-xs text-muted">
          Design prototype · Illustrative data reused across disciplines.
        </p>
      </section>
    </main>
  );
}

const meta = {
  title: "Design explorations/Climbing setting",
  component: ClimbingSettingMockup,
  parameters: { layout: "fullscreen" },
  args: { variant: "nested" },
} satisfies Meta<typeof ClimbingSettingMockup>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NestedTabs: Story = {};
export const CompactFilters: Story = { args: { variant: "compact" } };
export const IndoorOutdoorSections: Story = { args: { variant: "sections" } };
export const NarrowNestedTabs: Story = {
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-[390px]">
        <Story />
      </div>
    ),
  ],
};
