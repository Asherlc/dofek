import type { DataQualityOverview } from "@dofek/format/data-quality";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DataQualityCenter } from "./DataQualityCenter";

const overview: DataQualityOverview = {
  generatedAt: "2026-07-22T12:00:00.000Z",
  window: { days: 30, endDate: "2026-07-22" },
  overallStatus: "attention",
  overallMessage: "1 data quality check needs review.",
  checks: [
    {
      key: "coverage",
      label: "Missing days",
      status: "attention",
      title: "Coverage gaps",
      message: "Nutrition data is missing for 5 of the last 30 days.",
      count: 5,
      lastObservedDate: null,
      details: [],
    },
    {
      key: "source_overlap",
      label: "Source overlap",
      status: "attention",
      title: "Some records have overlapping sources",
      message: "Review the source decisions before interpreting these records.",
      count: 2,
      lastObservedDate: "2026-07-21",
      details: ["Nutrition: 2 overlapping days."],
    },
  ],
};

describe("DataQualityCenter", () => {
  it("renders server-authored checks and review actions", () => {
    const onReview = vi.fn();
    render(<DataQualityCenter data={overview} onReview={onReview} />);

    expect(screen.getByText("Data quality")).toBeTruthy();
    expect(screen.getByText("1 data quality check needs review.")).toBeTruthy();
    expect(screen.getByText("Nutrition: 2 overlapping days.")).toBeTruthy();
    const reviewButtons = screen.getAllByRole("button", { name: "Review nutrition" });
    expect(reviewButtons).not.toHaveLength(0);
    fireEvent.click(reviewButtons[0]);
    expect(onReview).toHaveBeenCalledWith("coverage");
  });

  it("renders an empty state when the overview is not available", () => {
    render(<DataQualityCenter />);

    expect(screen.getByText("No data quality checks are available yet.")).toBeTruthy();
  });

  it("does not render review actions without a review callback", () => {
    render(<DataQualityCenter data={overview} />);

    expect(screen.queryByRole("button", { name: "Review nutrition" })).toBeNull();
  });

  it("shows its loading state", () => {
    render(<DataQualityCenter loading />);

    expect(screen.getByText("Loading data quality…")).toBeTruthy();
  });

  it("renders repeated detail text without duplicate React keys", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const data: DataQualityOverview = {
      ...overview,
      checks: overview.checks.map((qualityCheck) =>
        qualityCheck.key === "coverage"
          ? { ...qualityCheck, details: ["Repeated detail", "Repeated detail"] }
          : qualityCheck,
      ),
    };

    render(<DataQualityCenter data={data} />);

    expect(screen.getAllByText("Repeated detail")).toHaveLength(2);
    expect(consoleError.mock.calls.flat().map(String).join(" ")).not.toContain("same key");
    consoleError.mockRestore();
  });
});
