// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HealthStatusCards } from "./HealthStatusCards";

describe("HealthStatusCards", () => {
  it("renders server-authored HRV and steps text instead of recomputing raw values", () => {
    render(
      <HealthStatusCards
        metrics={[
          {
            metric: "hrv",
            label: "Heart Rate Variability (HRV)",
            value: 999,
            valueText: "52 ms",
            baseline: 998,
            baselineText: "51 ms",
            sampleDeviation: 5,
            deviation: 0,
            direction: "aligned",
            intent: "higher",
            statusToken: "near_baseline",
            statusColor: "positive",
            statusLabel: "Near baseline",
            evaluationRule: "Server-selected rule.",
            explanation: "Server-selected explanation.",
          },
          {
            metric: "steps",
            label: "Steps",
            value: 1,
            valueText: "7,640",
            baseline: 2,
            baselineText: "7,640",
            sampleDeviation: 5,
            deviation: 0,
            direction: "aligned",
            intent: "neutral",
            statusToken: "near_baseline",
            statusColor: "positive",
            statusLabel: "Near baseline",
            evaluationRule: "Server-selected rule.",
            explanation: "Server-selected explanation.",
          },
        ]}
        formatValue={() => "client-recomputed value"}
      />,
    );

    expect(screen.getByText("52 ms")).toBeTruthy();
    expect(screen.getByText(/baseline 51 ms/)).toBeTruthy();
    expect(screen.getByText("7,640")).toBeTruthy();
    expect(screen.getByText(/baseline 7,640/)).toBeTruthy();
    expect(screen.queryByText("client-recomputed value")).toBeNull();
  });

  it("renders the canonical status and explanation returned by the server", () => {
    render(
      <HealthStatusCards
        metrics={[
          {
            metric: "trend_weight",
            label: "Trend Weight",
            value: 80,
            valueText: null,
            baseline: 82,
            baselineText: null,
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
            valueText: null,
            baseline: 20,
            baselineText: null,
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
            valueText: "50 ms",
            baseline: 50,
            baselineText: "50 ms",
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
