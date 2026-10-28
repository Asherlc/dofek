/** @vitest-environment jsdom */
import type { ClimbingFilters as Filters } from "@dofek/training/climbing-filters";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { ClimbingFilters } from "./ClimbingFilters.tsx";

afterEach(cleanup);

it("combines protection choices with mixed and all checkbox states", () => {
  render(<Harness />);
  open();
  fireEvent.click(screen.getByRole("button", { name: "More filters" }));
  const group = within(screen.getByRole("group", { name: "Protection used" }));
  fireEvent.click(group.getByRole("checkbox", { name: "Unknown" }));
  expect(value()).toEqual({ protectionUsed: ["sport", "trad"] });
  expect(group.getByRole("checkbox", { name: "All" })).toBePartiallyChecked();
  fireEvent.click(group.getByRole("checkbox", { name: "Sport" }));
  expect(value()).toEqual({ protectionUsed: ["trad"] });
  fireEvent.click(group.getByRole("checkbox", { name: "All" }));
  expect(value()).toEqual({});
  fireEvent.click(group.getByRole("checkbox", { name: "All" }));
  expect(value()).toEqual({ protectionUsed: [] });
});
function Harness({ initial = {} }: { initial?: Filters }) {
  const [value, onChange] = useState(initial);
  return (
    <>
      <ClimbingFilters value={value} onChange={onChange} />
      <output>{JSON.stringify(value)}</output>
    </>
  );
}
function open() {
  fireEvent.click(screen.getByRole("button", { name: "Filters" }));
}
function value() {
  return JSON.parse(screen.getByRole("status").textContent ?? "");
}

it("uses an opaque panel so charts cannot show through the filters", () => {
  render(<Harness />);
  open();
  expect(screen.getByRole("dialog", { name: "Climbing filters" })).toHaveClass("bg-surface-solid");
});

it("keeps filters in a popover and summarizes multiple climbing types after closing", async () => {
  render(<Harness initial={{ types: ["bouldering", "lead", "top_rope"] }} />);
  expect(screen.queryByRole("checkbox", { name: "Bouldering" })).toBeNull();
  open();
  fireEvent.click(screen.getByRole("checkbox", { name: "Top rope" }));
  expect(value()).toEqual({ types: ["bouldering", "lead"] });
  fireEvent.click(screen.getByRole("checkbox", { name: "Unknown setting" }));
  expect(value()).toEqual({ types: ["bouldering", "lead"], setting: ["indoor", "outdoor"] });
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.getByText("Bouldering + Lead · Indoor + Outdoor")).toBeVisible();
  expect(screen.queryByRole("checkbox", { name: "Bouldering" })).toBeNull();
  await waitFor(() => expect(screen.getByRole("button", { name: "Filters" })).toHaveFocus());
  open();
  expect(screen.getByRole("checkbox", { name: "All climbing" })).toBePartiallyChecked();
});
it("toggles settings independently and selects or clears the entire group", () => {
  render(<Harness />);
  open();
  const all = screen.getByRole("checkbox", { name: "All settings" });
  const indoor = screen.getByRole("checkbox", { name: "Indoor" });
  const outdoor = screen.getByRole("checkbox", { name: "Outdoor" });
  const unknown = screen.getByRole("checkbox", { name: "Unknown setting" });
  expect(all).toBeChecked();
  fireEvent.click(unknown);
  expect(all).toBePartiallyChecked();
  expect(value()).toEqual({ setting: ["indoor", "outdoor"] });
  fireEvent.click(indoor);
  fireEvent.click(outdoor);
  expect(all).not.toBeChecked();
  expect(value()).toEqual({ setting: [] });
  fireEvent.click(all);
  expect(all).toBeChecked();
  expect(unknown).toBeChecked();
  expect(value()).toEqual({});
  fireEvent.click(all);
  expect(indoor).not.toBeChecked();
  expect(outdoor).not.toBeChecked();
  expect(unknown).not.toBeChecked();
});
it("combines advanced factual filters and removes them independently", () => {
  render(<Harness initial={{ types: ["lead"], setting: ["unknown"], solo: [false] }} />);
  open();
  fireEvent.click(screen.getByRole("button", { name: "More filters" }));
  const protection = within(screen.getByRole("group", { name: "Protection used" }));
  fireEvent.click(protection.getByRole("checkbox", { name: "All" }));
  fireEvent.click(protection.getByRole("checkbox", { name: "Trad" }));
  expect(value()).toEqual({
    types: ["lead"],
    setting: ["unknown"],
    solo: [false],
    protectionUsed: ["trad"],
  });
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove Protection used: Trad filter" }));
  expect(value()).toEqual({ types: ["lead"], setting: ["unknown"], solo: [false] });
  open();
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(value()).toEqual({});
});
it("preserves selections when dismissed with Escape", () => {
  render(<Harness />);
  open();
  fireEvent.click(screen.getByRole("checkbox", { name: "All climbing" }));
  expect(value()).toEqual({ types: [] });
  fireEvent.keyDown(screen.getByRole("dialog", { name: "Climbing filters" }), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText("No climbing types · All settings")).toBeVisible();
});
