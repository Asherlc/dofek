/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { StrengthLoggedSetComparison } from "./StrengthLoggedSetComparison.tsx";
import { loggedSetFixture } from "./strength-logged-set-fixture.ts";
import {
  flatBenchmarkRow,
  repImprovementRow,
  unbadgedRepImprovementRow,
} from "./training-progression-fixture.ts";

afterEach(cleanup);
it("renders exact rep evidence and missing sessions", () => {
  render(<StrengthLoggedSetComparison data={loggedSetFixture} />);
  expect(screen.getByText("12")).toBeTruthy();
  expect(screen.getByText("Across 4 recorded sessions")).toBeTruthy();
  expect(screen.getByText("No 6-rep set")).toBeTruthy();
  expect(screen.getAllByText(/80/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/85/).length).toBeGreaterThan(0);
});
it("shows error independently", () => {
  render(<StrengthLoggedSetComparison error={new Error("Unavailable")} />);
  expect(screen.getByText("Unavailable")).toBeTruthy();
});

it("selects other reps and equipment and falls back when options disappear", () => {
  const { rerender } = render(<StrengthLoggedSetComparison data={loggedSetFixture} />);
  fireEvent.change(screen.getByRole("combobox", { name: "Rep count" }), { target: { value: "8" } });
  expect(screen.getAllByText("Heaviest set of 8 reps")[0]).toBeTruthy();
  expect(screen.getByText(/Nov 12.*One recorded date/)).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "Exercise and equipment" }), {
    target: { value: "dumbbell" },
  });
  expect(screen.getAllByText(/20[.,]?0?\s*kg/).length).toBeGreaterThan(0);
  rerender(
    <StrengthLoggedSetComparison
      data={{ ...loggedSetFixture, exercises: loggedSetFixture.exercises.slice(0, 1) }}
    />,
  );
  expect(screen.getByText("12")).toBeTruthy();
});
it("distinguishes loading and empty", () => {
  const { rerender } = render(<StrengthLoggedSetComparison loading />);
  rerender(<StrengthLoggedSetComparison data={{ ...loggedSetFixture, exercises: [] }} />);
  expect(screen.getByText("No logged sets with load and reps in this period")).toBeTruthy();
});

it("retains cached observations during loading and errors", () => {
  render(
    <StrengthLoggedSetComparison
      data={loggedSetFixture}
      loading
      error={new Error("Refresh failed")}
    />,
  );
  expect(screen.getByText("12")).toBeTruthy();
  expect(screen.getByText("Refresh failed")).toBeTruthy();
});

it("includes the year in recorded dates", () => {
  render(<StrengthLoggedSetComparison data={loggedSetFixture} />);
  expect(screen.getAllByText(/2026/).length).toBeGreaterThan(0);
});

it("preserves server calendar dates in sessions and comparison endpoints", () => {
  render(<StrengthLoggedSetComparison data={loggedSetFixture} />);
  expect(screen.getByText("Nov 3, 2026 to Nov 20, 2026")).toBeTruthy();
  expect(screen.getByRole("rowheader", { name: "Nov 3, 2026" })).toBeTruthy();
  expect(screen.getByRole("rowheader", { name: "Nov 12, 2026" })).toBeTruthy();
});

it("shows the selected lift's progression status and follows exercise changes", () => {
  render(
    <StrengthLoggedSetComparison
      data={loggedSetFixture}
      progressionRows={[unbadgedRepImprovementRow, repImprovementRow]}
    />,
  );
  const status = () => screen.getByRole("region", { name: "Training progression status" });
  expect(within(status()).getByText("Ready to progress")).toBeTruthy();
  expect(within(status()).getByText("Bench press · Barbell")).toBeTruthy();
  expect(within(status()).getByText("More reps at the same weight")).toBeTruthy();

  fireEvent.change(screen.getByRole("combobox", { name: "Exercise and equipment" }), {
    target: { value: "dumbbell" },
  });
  expect(within(status()).queryByText("Ready to progress")).toBeNull();
  expect(within(status()).getByText("Bench press · Dumbbell")).toBeTruthy();
  expect(within(status()).getByText("More reps at the same weight")).toBeTruthy();

  fireEvent.change(screen.getByRole("combobox", { name: "Exercise and equipment" }), {
    target: { value: "bench" },
  });
  expect(within(status()).getByText("Ready to progress")).toBeTruthy();
});

it("shows a flat benchmark status for the selected lift", () => {
  render(
    <StrengthLoggedSetComparison
      data={loggedSetFixture}
      progressionRows={[{ ...flatBenchmarkRow, exerciseId: "bench" }]}
    />,
  );
  const status = within(screen.getByRole("region", { name: "Training progression status" }));
  expect(status.getByText("Stagnating")).toBeTruthy();
  expect(
    status.getByText("Estimated strength held steady across 7 comparable sessions."),
  ).toBeTruthy();
});

it("keeps the comparison usable when no progression rows match", () => {
  render(<StrengthLoggedSetComparison data={loggedSetFixture} progressionRows={[]} />);
  expect(screen.queryByRole("region", { name: "Training progression status" })).toBeNull();
  expect(screen.getByText("12")).toBeTruthy();
});
