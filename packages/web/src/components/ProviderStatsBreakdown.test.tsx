// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderStatsBreakdown } from "./ProviderStatsBreakdown.tsx";

afterEach(cleanup);

describe("ProviderStatsBreakdown", () => {
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
          clinicalRecords: 0,
          journalEntries: 0,
        }}
      />,
    );

    expect(screen.getByText("records")).not.toBeNull();
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
      "Journal",
    ]) {
      expect(screen.getByText(label)).not.toBeNull();
    }
    expect(screen.getAllByText("0")).toHaveLength(11);
  });
});
