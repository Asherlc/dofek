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
            evaluationRule: "Below your baseline, where lower values support this metric",
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
      screen.getByText("Below your baseline, where lower values support this metric"),
    ).toBeTruthy();
    expect(
      screen.getByText("Trend Weight is below your baseline, in line with your weight goal."),
    ).toBeTruthy();
    expect(screen.getByLabelText("Moving as intended status").textContent).toBe("✓");
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
            evaluationRule: "Server-selected rule.",
            explanation: "Server-selected explanation.",
          },
        ]}
      />,
    );

    expect(screen.getByText("Server-selected label")).toBeTruthy();
    expect(screen.getByText("Server-selected rule.")).toBeTruthy();
    expect(screen.getByText("Server-selected explanation.")).toBeTruthy();
    expect(screen.queryByText(/abnormal/i)).toBeNull();
  });

  it.each([
    { statusToken: "insufficient_data" as const, statusLabel: "Not enough data", symbol: "?" },
    { statusToken: "near_baseline" as const, statusLabel: "Near baseline", symbol: "✓" },
    { statusToken: "moving_as_intended" as const, statusLabel: "Moving as intended", symbol: "✓" },
    { statusToken: "notable_deviation" as const, statusLabel: "Notable deviation", symbol: "!" },
    { statusToken: "far_from_baseline" as const, statusLabel: "Far from baseline", symbol: "×" },
  ])("renders $statusToken as the non-color symbol $symbol", ({
    statusToken,
    statusLabel,
    symbol,
  }) => {
    render(
      <HealthStatusCards
        metrics={[
          {
            metric: "hrv",
            label: "Heart Rate Variability (HRV)",
            value: 50,
            baseline: 50,
            sampleDeviation: 5,
            deviation: 0,
            direction: "aligned",
            intent: "neutral",
            statusToken,
            statusColor: "positive",
            statusLabel,
            evaluationRule: "Server-selected rule.",
            explanation: "Server-selected explanation.",
          },
        ]}
      />,
    );

    expect(screen.getByLabelText(`${statusLabel} status`).textContent).toBe(symbol);
  });
});
