/** @vitest-environment jsdom */
import type { ClimbingFilters as Filters } from "@dofek/training/climbing-filters";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { ClimbingFilters } from "./ClimbingFilters.tsx";

afterEach(cleanup);
function Harness({ initial = {} }: { initial?: Filters }) {
  const [value, onChange] = useState(initial);
  return (
    <>
      <ClimbingFilters value={value} onChange={onChange} />
      <output>{JSON.stringify(value)}</output>
    </>
  );
}
it("combines visible context and setting selections and clears each independently", () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Bouldering" }));
  fireEvent.click(screen.getByRole("button", { name: "Outdoor" }));
  expect(JSON.parse(screen.getByRole("status").textContent ?? "")).toEqual({
    climbKind: "boulder",
    setting: "outdoor",
  });
  fireEvent.click(screen.getByRole("button", { name: "Lead" }));
  expect(JSON.parse(screen.getByRole("status").textContent ?? "")).toEqual({
    climbKind: "route",
    ropeMethod: "lead",
    setting: "outdoor",
  });
  fireEvent.click(screen.getByRole("button", { name: "All climbing" }));
  expect(JSON.parse(screen.getByRole("status").textContent ?? "")).toEqual({ setting: "outdoor" });
  fireEvent.click(
    within(screen.getByRole("group", { name: "Setting" })).getByRole("button", {
      name: "All settings",
    }),
  );
  expect(screen.getByRole("status")).toHaveTextContent("{}");
});
it("keeps advanced filters discoverable and removes one without clearing context", () => {
  render(<Harness initial={{ climbKind: "route", ropeMethod: "lead", solo: false }} />);
  fireEvent.click(screen.getByRole("button", { name: "More filters" }));
  fireEvent.change(screen.getByLabelText("Protection used"), { target: { value: "trad" } });
  expect(screen.getByRole("button", { name: "Lead" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Remove Protection used: Trad filter" }));
  expect(JSON.parse(screen.getByRole("status").textContent ?? "")).toEqual({
    climbKind: "route",
    ropeMethod: "lead",
    solo: false,
  });
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(screen.getByRole("status")).toHaveTextContent("{}");
});
it("explains a custom context and retains unknown settings", () => {
  render(<Harness initial={{ ropeMethod: "follow", setting: "unknown" }} />);
  expect(screen.getByText("Custom climbing selection")).toBeVisible();
  expect(screen.getByRole("button", { name: "Unknown setting" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "Top rope" }));
  expect(JSON.parse(screen.getByRole("status").textContent ?? "")).toEqual({
    climbKind: "route",
    ropeMethod: "top_rope",
    setting: "unknown",
  });
});
