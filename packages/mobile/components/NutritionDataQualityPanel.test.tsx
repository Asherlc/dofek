/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NutritionDataQualityPanel } from "./NutritionDataQualityPanel";

vi.mock("../theme", () => ({
  colors: new Proxy({}, { get: () => "#71717a" }),
}));

describe("NutritionDataQualityPanel", () => {
  it("shows completeness, overlap, and source decisions", () => {
    render(
      <NutritionDataQualityPanel
        dataQuality={{
          selectedWindowDays: 30,
          daysWithData: 12,
          usableDays: 10,
          overlapDays: 3,
          conflictDays: 2,
          completenessPercent: 33.3,
          sourceLabels: ["Cronometer", "Manual"],
          contributingSourceLabels: ["Manual"],
          excludedSourceLabels: ["Cronometer"],
        }}
      />,
    );

    expect(screen.getByText("Nutrition data quality")).toBeTruthy();
    expect(screen.getByText("Nutrition data exists on 12 selected days.")).toBeTruthy();
    expect(
      screen.getByText("10 of 30 selected days are usable (33.3% completeness)."),
    ).toBeTruthy();
    expect(
      screen.getByText("3 days contain overlapping sources; 2 remain unresolved."),
    ).toBeTruthy();
    expect(screen.getByText("Source overlap to review")).toBeTruthy();
    expect(screen.getByText("Contributing sources: Manual")).toBeTruthy();
    expect(screen.getByText("Excluded or conflicting sources: Cronometer")).toBeTruthy();
  });

  it("shows a loading state before adequacy interpretation", () => {
    render(<NutritionDataQualityPanel loading />);

    expect(screen.getByText("Loading nutrition data quality…")).toBeTruthy();
  });

  it("reports an all-history window without inventing a denominator", () => {
    render(
      <NutritionDataQualityPanel
        dataQuality={{
          selectedWindowDays: null,
          daysWithData: 20,
          usableDays: 20,
          overlapDays: 0,
          conflictDays: 0,
          completenessPercent: null,
          sourceLabels: ["Manual"],
          contributingSourceLabels: ["Manual"],
          excludedSourceLabels: [],
        }}
      />,
    );

    expect(screen.getByText("20 recorded days are usable.")).toBeTruthy();
  });
});
