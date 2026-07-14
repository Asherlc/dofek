import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderStatsBreakdown } from "./ProviderStatsBreakdown";

describe("ProviderStatsBreakdown", () => {
  it("computes the total from metadata when totalRecords is omitted", () => {
    render(
      <ProviderStatsBreakdown
        stats={{
          activities: 7,
          metricStream: 0,
          dailyMetrics: 0,
          sleepSessions: 0,
          bodyMeasurements: 0,
          healthEvents: 0,
          foodEntries: 0,
          nutritionDaily: 0,
          labPanels: 0,
          labResults: 0,
          journalEntries: 0,
        }}
      />,
    );

    expect(screen.getAllByText("7")).toHaveLength(2);
  });

  it("renders every metadata field when all counts are zero", () => {
    render(
      <ProviderStatsBreakdown
        stats={{
          totalRecords: 0,
          activities: 0,
          metricStream: 0,
          dailyMetrics: 0,
          sleepSessions: 0,
          bodyMeasurements: 0,
          healthEvents: 0,
          foodEntries: 0,
          nutritionDaily: 0,
          labPanels: 0,
          labResults: 0,
          journalEntries: 0,
        }}
      />,
    );

    expect(screen.getByText("records")).toBeTruthy();
    for (const label of [
      "Activities",
      "Metric Stream",
      "Daily Metrics",
      "Sleep",
      "Body",
      "Food",
      "Nutrition",
      "Events",
      "Lab Panels",
      "Lab Results",
      "Journal",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getAllByText("0")).toHaveLength(12);
  });
});
