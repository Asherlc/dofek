/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { DataQualityOverview } from "../../../server/src/repositories/data-quality-repository.ts";
import { DataQualityCenter } from "./DataQualityCenter.tsx";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

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
    {
      key: "sync_freshness",
      label: "Sync freshness",
      status: "healthy",
      title: "Data updates are current",
      message: "All selected datasets are ready.",
      count: 0,
      lastObservedDate: null,
      details: [],
    },
    {
      key: "outliers",
      label: "Outliers",
      status: "informational",
      title: "No unusual observations were flagged",
      message: "No unusual observations were flagged in the last 30 days.",
      count: 0,
      lastObservedDate: null,
      details: [],
    },
    {
      key: "manual_edits",
      label: "Manual edits",
      status: "informational",
      title: "Manual entries are included",
      message: "1 manually entered journal record was recorded in the last 30 days.",
      count: 1,
      lastObservedDate: "2026-07-19",
      details: [],
    },
  ],
};

describe("DataQualityCenter", () => {
  it("renders server-authored checks, evidence, and review links", () => {
    render(<DataQualityCenter data={overview} />);

    expect(screen.getByRole("heading", { name: "Data quality" })).toBeTruthy();
    expect(screen.getByText("1 data quality check needs review.")).toBeTruthy();
    expect(screen.getByText("Nutrition data is missing for 5 of the last 30 days.")).toBeTruthy();
    expect(screen.getByText("Nutrition: 2 overlapping days.")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Review nutrition" })).not.toHaveLength(0);
  });

  it("shows its loading state", () => {
    render(<DataQualityCenter loading />);

    expect(screen.getByText("Loading data quality…")).toBeTruthy();
  });
});
