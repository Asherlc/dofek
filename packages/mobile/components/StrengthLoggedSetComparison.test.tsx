/** @vitest-environment jsdom */

import { UnitConverter } from "@dofek/format/units";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { StrengthLoggedSetComparison } from "./StrengthLoggedSetComparison";
import { loggedSetFixture } from "./strength-logged-set-fixture";

afterEach(cleanup);
it("renders exact rep evidence and missing sessions", () => {
  render(
    <StrengthLoggedSetComparison data={loggedSetFixture} units={new UnitConverter("metric")} />,
  );
  expect(screen.getByText("12")).toBeTruthy();
  expect(screen.getByText("Across 4 recorded sessions")).toBeTruthy();
  expect(screen.getByText("No 6-rep set")).toBeTruthy();
  expect(screen.getAllByText(/80/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/85/).length).toBeGreaterThan(0);
});
it("shows error independently", () => {
  render(
    <StrengthLoggedSetComparison
      error={new Error("Unavailable")}
      units={new UnitConverter("metric")}
    />,
  );
  expect(screen.getByText("Unavailable")).toBeTruthy();
});

it("selects other reps and equipment and falls back when options disappear", () => {
  const { rerender } = render(
    <StrengthLoggedSetComparison data={loggedSetFixture} units={new UnitConverter("metric")} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "8 reps" }));
  expect(screen.getAllByText("Heaviest set of 8 reps")[0]).toBeTruthy();
  expect(screen.getByText(/Nov 12.*One recorded date/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Bench press · Dumbbell" }));
  expect(screen.getAllByText(/20[.,]?0?\s*kg/).length).toBeGreaterThan(0);
  rerender(
    <StrengthLoggedSetComparison
      data={{ ...loggedSetFixture, exercises: loggedSetFixture.exercises.slice(0, 1) }}
      units={new UnitConverter("metric")}
    />,
  );
  expect(screen.getByText("12")).toBeTruthy();
});
it("distinguishes loading and empty", () => {
  const { rerender } = render(
    <StrengthLoggedSetComparison loading units={new UnitConverter("metric")} />,
  );
  rerender(
    <StrengthLoggedSetComparison
      data={{ ...loggedSetFixture, exercises: [] }}
      units={new UnitConverter("metric")}
    />,
  );
  expect(screen.getByText("No logged sets with load and reps in this period")).toBeTruthy();
});

it("retains cached observations during loading and errors", () => {
  render(
    <StrengthLoggedSetComparison
      data={loggedSetFixture}
      loading
      error={new Error("Refresh failed")}
      units={new UnitConverter("metric")}
    />,
  );
  expect(screen.getByText("12")).toBeTruthy();
  expect(screen.getByText("Refresh failed")).toBeTruthy();
});

it("includes the year in recorded dates", () => {
  render(
    <StrengthLoggedSetComparison data={loggedSetFixture} units={new UnitConverter("metric")} />,
  );
  expect(screen.getAllByText(/2026/).length).toBeGreaterThan(0);
});

it("visibly marks the active exercise and rep choices", () => {
  render(
    <StrengthLoggedSetComparison data={loggedSetFixture} units={new UnitConverter("metric")} />,
  );
  expect(screen.getByText("Sets and performance").getAttribute("role")).toBe("header");
  const barbell = screen.getByRole("button", { name: "Bench press · Barbell" });
  const dumbbell = screen.getByRole("button", { name: "Bench press · Dumbbell" });
  expect(barbell.style.borderColor).not.toBe(dumbbell.style.borderColor);
  const six = screen.getByRole("button", { name: "6 reps" });
  const eight = screen.getByRole("button", { name: "8 reps" });
  expect(six.style.borderColor).not.toBe(eight.style.borderColor);
  fireEvent.click(eight);
  expect(eight.style.borderColor).toBe(barbell.style.borderColor);
  expect(six.style.borderColor).toBe(dumbbell.style.borderColor);
});

it("preserves server calendar dates in sessions and comparison endpoints", () => {
  render(
    <StrengthLoggedSetComparison data={loggedSetFixture} units={new UnitConverter("metric")} />,
  );
  expect(screen.getByText("Nov 3, 2026 to Nov 20, 2026")).toBeTruthy();
  expect(screen.getByText("Nov 3, 2026 · 3 logged sets")).toBeTruthy();
  expect(screen.getByText("Nov 12, 2026 · 2 logged sets")).toBeTruthy();
});
