// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HealthStatusCards } from "./HealthStatusCards";

describe("HealthStatusCards", () => {
  it("renders the canonical status and explanation returned by the server", () => {
    render(
      <HealthStatusCards
        metrics={[
          {
            metric: "trend_weight",
            label: "Trend Weight",
            value: 80,
            baseline: 82,
            sampleDeviation: 1,
            deviation: -2,
            direction: "below",
            intent: "lower",
            statusToken: "moving_as_intended",
            statusColor: "positive",
            statusLabel: "Moving as intended",
            explanation: "Trend Weight is below your baseline, in line with your weight goal.",
          },
        ]}
        formatValue={() => "176.4 lb"}
      />,
    );

    expect(screen.getByText("Trend Weight")).toBeTruthy();
    expect(screen.getByText("176.4 lb")).toBeTruthy();
    expect(screen.getByText("Moving as intended")).toBeTruthy();
    expect(
      screen.getByText("Trend Weight is below your baseline, in line with your weight goal."),
    ).toBeTruthy();
  });

  it("does not reinterpret a server status from the numeric fields", () => {
    render(
      <HealthStatusCards
        metrics={[
          {
            metric: "body_fat_percentage",
            label: "Body Fat %",
            value: 30,
            baseline: 20,
            sampleDeviation: 2,
            deviation: 5,
            direction: "above",
            intent: "neutral",
            statusToken: "near_baseline",
            statusColor: "positive",
            statusLabel: "Server-selected label",
            explanation: "Server-selected explanation.",
          },
        ]}
      />,
    );

    expect(screen.getByText("Server-selected label")).toBeTruthy();
    expect(screen.getByText("Server-selected explanation.")).toBeTruthy();
    expect(screen.queryByText(/abnormal/i)).toBeNull();
  });
});
