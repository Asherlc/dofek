// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderStatsBreakdown } from "./ProviderStatsBreakdown.tsx";

afterEach(cleanup);

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
  it("renders only the total in the compact card variant", () => {
    render(<ProviderStatsBreakdown stats={zeroStats} />);

    expect(screen.getByText("records")).not.toBeNull();
    expect(screen.getAllByText("0")).toHaveLength(1);
    expect(screen.queryByText("Activities")).toBeNull();
  });

  it("renders every metadata field in the full detail variant", () => {
    render(<ProviderStatsBreakdown stats={zeroStats} variant="full" />);

    expect(screen.getByText("total records")).not.toBeNull();
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
      expect(screen.getByText(label)).not.toBeNull();
    }
    expect(screen.getAllByText("0")).toHaveLength(11);
  });
});
