/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { StrengthProgressionEvidence } from "./StrengthProgressionEvidence.tsx";
import {
  flatBenchmarkRow,
  repImprovementRow,
  unbadgedRepImprovementRow,
} from "./training-progression-fixture.ts";

afterEach(cleanup);

it("keeps dated recorded sets behind a disclosure until opened", () => {
  render(<StrengthProgressionEvidence row={repImprovementRow} />);
  expect(screen.queryByText(/Nov 20, 2026/)).toBeNull();

  fireEvent.click(screen.getByText("See recorded sets"));

  expect(screen.getByText(/Nov 20, 2026 · 10 reps at/)).toBeTruthy();
  expect(screen.getByText(/Nov 3, 2026 · 8 reps at/)).toBeTruthy();
  expect(screen.getAllByText(/WHOOP \(Cloud\)/).length).toBe(2);
});

it("shows the evidence date range from the server without recomputing it", () => {
  render(<StrengthProgressionEvidence row={repImprovementRow} />);
  fireEvent.click(screen.getByText("See recorded sets"));
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  expect(screen.getAllByText(/60.0 kg/)).toHaveLength(2);
});

it("shows effort on recorded sets that have an RPE", () => {
  render(<StrengthProgressionEvidence row={repImprovementRow} />);
  fireEvent.click(screen.getByText("See recorded sets"));
  expect(screen.getAllByText(/Effort 7\/10/)).toHaveLength(2);
});

it("omits effort on recorded sets whose RPE is null", () => {
  render(<StrengthProgressionEvidence row={unbadgedRepImprovementRow} />);
  fireEvent.click(screen.getByText("See recorded sets"));
  expect(screen.queryByText(/Effort/)).toBeNull();
});

it("shows the estimated one-rep max range above the sets for a flat benchmark", () => {
  render(<StrengthProgressionEvidence row={flatBenchmarkRow} />);
  fireEvent.click(screen.getByText("See recorded sets"));
  expect(screen.getByText(/Estimated one-rep max range/)).toBeTruthy();
  expect(screen.getByText(/100.0 kg – 101.5 kg/)).toBeTruthy();
});
