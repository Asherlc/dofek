import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

const types = ["Bouldering", "Lead", "Top rope"];
const settings = ["Indoor", "Outdoor", "Unknown"];

function ClimbingFilterOptions({ variant }: { variant: "rows" | "grid" | "popover" }) {
  const [selectedTypes, setTypes] = useState(["Bouldering", "Lead"]);
  const [selectedSettings, setSettings] = useState(["Indoor", "Outdoor"]);
  const [cells, setCells] = useState([
    "Bouldering Indoor",
    "Bouldering Outdoor",
    "Lead Indoor",
    "Lead Outdoor",
  ]);
  const [open, setOpen] = useState(true);
  function row(
    label: string,
    options: string[],
    selected: string[],
    change: (value: string[]) => void,
  ) {
    return (
      <fieldset className="flex flex-wrap items-center gap-x-6 gap-y-1">
        <legend className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">
          {label}
        </legend>
        {["All", ...options].map((item) => (
          <label key={item} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 accent-accent"
              checked={
                item === "All" ? selected.length === options.length : selected.includes(item)
              }
              ref={
                item === "All"
                  ? (node) => {
                      if (node)
                        node.indeterminate =
                          selected.length > 0 && selected.length < options.length;
                    }
                  : undefined
              }
              onChange={() =>
                change(
                  item === "All"
                    ? selected.length === options.length
                      ? []
                      : options
                    : options.filter((option) =>
                        option === item ? !selected.includes(option) : selected.includes(option),
                      ),
                )
              }
            />
            {item}
          </label>
        ))}
      </fieldset>
    );
  }
  const title =
    variant === "rows"
      ? "A · Two filter rows"
      : variant === "grid"
        ? "B · Type × setting grid"
        : "C · Compact filter popover";
  return (
    <main className="min-h-screen bg-bg p-8 text-foreground">
      <div className="mx-auto max-w-3xl">
        <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">
          Climbing · Filter exploration
        </p>
        <h1 className="mb-2 text-2xl font-semibold">{title}</h1>
        <p className="mb-6 text-sm text-muted">
          {variant === "grid"
            ? "Choose exact combinations, such as indoor bouldering and outdoor lead."
            : variant === "rows"
              ? "Choose climbing types and settings independently. Both groups stay visible."
              : "Keep the page compact; open Filters to change the selection."}
        </p>
        <section className="relative rounded-xl border border-border bg-surface p-6">
          {variant === "rows" ? (
            <div className="space-y-4">
              {row("Type", types, selectedTypes, setTypes)}
              <div className="border-t border-border" />
              {row("Setting", settings, selectedSettings, setSettings)}
            </div>
          ) : null}
          {variant === "grid" ? (
            <table className="w-full table-fixed text-sm">
              <thead>
                <tr>
                  <th className="w-[34%] pb-3 text-left font-normal text-muted">Climbing type</th>
                  {settings.map((setting) => (
                    <th key={setting} className="pb-3 font-normal text-muted">
                      {setting}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {types.map((type) => (
                  <tr key={type} className="border-t border-border">
                    <th className="py-4 text-left font-medium">{type}</th>
                    {settings.map((setting) => {
                      const key = `${type} ${setting}`;
                      return (
                        <td
                          key={setting}
                          className={
                            cells.includes(key) ? "bg-accent/10 text-center" : "text-center"
                          }
                        >
                          <input
                            type="checkbox"
                            aria-label={key}
                            className="h-5 w-5 accent-accent"
                            checked={cells.includes(key)}
                            onChange={() =>
                              setCells(
                                cells.includes(key)
                                  ? cells.filter((cell) => cell !== key)
                                  : [...cells, key],
                              )
                            }
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {variant === "popover" ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm">
                  {selectedTypes.join(" + ")} <span className="mx-2 text-muted">·</span>{" "}
                  {selectedSettings.join(" + ")}
                </p>
                <button
                  type="button"
                  className="min-h-11 rounded-lg border border-accent px-4 text-sm text-accent"
                  aria-expanded={open}
                  onClick={() => setOpen(!open)}
                >
                  Filters · 4 <span className="ml-3">⌄</span>
                </button>
              </div>
              {open ? (
                <div className="mt-4 rounded-xl border border-border bg-bg p-5 shadow-lg">
                  <div className="space-y-4">
                    {row("Type", types, selectedTypes, setTypes)}
                    <div className="border-t border-border" />
                    {row("Setting", settings, selectedSettings, setSettings)}
                  </div>
                  <div className="mt-4 flex justify-end border-t border-border pt-3">
                    <button
                      type="button"
                      className="min-h-10 rounded-lg bg-accent px-5 text-sm text-white"
                      onClick={() => setOpen(false)}
                    >
                      Done
                    </button>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </section>
        <section className="mt-6 rounded-xl border border-border bg-surface p-6">
          <div className="mb-5 flex gap-6 border-b border-border text-sm">
            <span className="border-b-2 border-accent pb-3 font-medium text-accent">Styles</span>
            <span className="text-muted">Grades</span>
            <span className="text-muted">Progress</span>
          </div>
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Climbing strengths</h2>
            <span className="text-xs text-muted">Wall angle · All grades</span>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-4">
            {["Bouldering", "Lead"].map((type) => (
              <div key={type} className="rounded-lg border border-border p-4">
                <p className="text-sm font-medium">{type}</p>
                <p className="mt-1 text-xs text-muted">Indoor + Outdoor</p>
                <div className="mt-5 space-y-3">
                  {["Slab", "Vertical", "Overhang"].map((label, index) => (
                    <div key={label} className="flex items-center gap-3">
                      <span className="w-16 text-xs text-muted">{label}</span>
                      <div className="h-2 flex-1 rounded bg-accent/10">
                        <div
                          className="h-2 rounded bg-accent/50"
                          style={{ width: `${75 - index * 20}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
        <p className="mt-4 text-xs text-muted">Design prototype · Illustrative chart only.</p>
      </div>
    </main>
  );
}
const meta = {
  title: "Design explorations/Climbing filter options",
  component: ClimbingFilterOptions,
  parameters: { layout: "fullscreen" },
  args: { variant: "rows" },
} satisfies Meta<typeof ClimbingFilterOptions>;
export default meta;
type Story = StoryObj<typeof meta>;
export const CheckboxRows: Story = {};
export const CombinationGrid: Story = { args: { variant: "grid" } };
export const CompactPopover: Story = { args: { variant: "popover" } };
