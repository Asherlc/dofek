import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderStatsBreakdown } from "./ProviderStatsBreakdown";

const zeroStats = {
  totalRecords: 0,
  activities: 0,
  metricStream: 0,
  dailyMetrics: 0,
  sleepSessions: 0,
  bodyMeasurements: 0,
  healthEvents: 0,
  foodEntries: 0,
  nutritionDaily: 0,
  clinicalRecords: 0,
  climbingLogEntries: 0,
};

describe("ProviderStatsBreakdown", () => {
  it("shows only the computed total in the compact list variant", () => {
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
          clinicalRecords: 0,
          climbingLogEntries: 0,
        }}
      />,
    );

    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText("records")).toBeTruthy();
    expect(screen.queryByText("Activities")).toBeNull();
  });

  it("keeps every record-type breakdown in the full detail variant", () => {
    render(<ProviderStatsBreakdown stats={zeroStats} variant="full" />);

    expect(screen.getByText("total records")).toBeTruthy();
    for (const label of [
      "Activities",
      "Metric Stream",
      "Daily Metrics",
      "Sleep",
      "Body",
      "Food",
      "Nutrition",
      "Events",
      "Clinical Records",
      "Climbing log",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getAllByText("0")).toHaveLength(11);
  });
});
