// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HealthStatusCards } from "./HealthStatusCards";

const readyBaselineProgress = {
  requiredObservationDays: 3,
  observedObservationDays: 3,
  hasMeasurableVariation: true,
  blocker: null,
  requirement: "A current value plus at least 2 more recorded days with measurable variation.",
  summary: "The baseline is ready.",
  action: "No action needed.",
} as const;

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
            baselineProgress: readyBaselineProgress,
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
            baselineProgress: readyBaselineProgress,
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
            baselineProgress: readyBaselineProgress,
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

  it("renders server-authored baseline requirements, progress, and action", () => {
    render(
      <HealthStatusCards
        metrics={[
          {
            metric: "resting_heart_rate",
            label: "Resting Heart Rate",
            value: 56,
            baseline: 56,
            sampleDeviation: null,
            deviation: null,
            direction: "unknown",
            intent: "lower",
            statusToken: "insufficient_data",
            statusColor: "muted",
            statusLabel: "Waiting for baseline",
            evaluationRule: "Server-selected rule.",
            explanation: "Server-selected explanation.",
            baselineProgress: {
              requiredObservationDays: 3,
              observedObservationDays: 1,
              hasMeasurableVariation: false,
              blocker: "collecting",
              requirement:
                "A current value plus at least 2 more recorded days with measurable variation.",
              summary:
                "Resting Heart Rate has 1 of 3 required days recorded; the baseline is still collecting observations.",
              action: "Keep syncing resting heart rate data for at least 2 more days.",
            },
          },
        ]}
      />,
    );

    expect(screen.getByText("Waiting for baseline")).toBeTruthy();
    expect(
      screen.getByText(
        "A current value plus at least 2 more recorded days with measurable variation.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("1 of 3 required days recorded")).toBeTruthy();
    expect(
      screen.getByText(
        "Resting Heart Rate has 1 of 3 required days recorded; the baseline is still collecting observations.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("Keep syncing resting heart rate data for at least 2 more days."),
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
            baselineProgress: readyBaselineProgress,
          },
        ]}
      />,
    );

    expect(screen.getByText("Server-selected label")).toBeTruthy();
    expect(screen.getByText("Server-selected rule.")).toBeTruthy();
    expect(screen.getByText("Server-selected explanation.")).toBeTruthy();
    expect(screen.queryByText(/abnormal/i)).toBeNull();
  });

  it("renders server-authored provenance and comparison context", () => {
    render(
      <HealthStatusCards
        metrics={[
          {
            metric: "spo2",
            label: "Blood Oxygen Saturation (SpO2)",
            value: 97.2,
            baseline: 96.4,
            sampleDeviation: 0.4,
            deviation: 2,
            direction: "above",
            intent: "neutral",
            statusToken: "near_baseline",
            statusColor: "positive",
            statusLabel: "Near baseline",
            evaluationRule: "Server-selected rule.",
            explanation: "Server-selected explanation.",
            provenance: {
              latestDate: "2026-07-30",
              sourceProviders: ["whoop"],
              observedDays: 3,
              windowDays: 30,
            },
            comparison: {
              recentDays: 7,
              baselineDays: 28,
              recentMean: 97.2,
              baselineMean: 96.4,
              delta: 0.8,
              direction: "increasing",
            },
            baselineProgress: readyBaselineProgress,
          },
        ]}
        formatComparisonValue={(_, value) => value.toFixed(1)}
      />,
    );

    expect(screen.getByText("WHOOP (Cloud) · 3/30 days · latest 2026-07-30")).toBeTruthy();
    expect(screen.getByText("7d avg 97.2 vs prior 28d avg 96.4 · +0.8")).toBeTruthy();

    const detailsButton = screen.getByRole("button", {
      name: "Show source details for Blood Oxygen Saturation (SpO2)",
    });
    expect(detailsButton.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Source: WHOOP (Cloud)")).toBeNull();

    fireEvent.click(detailsButton);

    expect(detailsButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Source: WHOOP (Cloud)")).toBeTruthy();
    expect(screen.getByText("Latest recorded date: 2026-07-30")).toBeTruthy();
    expect(screen.getByText("Coverage: 3/30 days")).toBeTruthy();
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
            baselineProgress: readyBaselineProgress,
          },
        ]}
      />,
    );

    expect(screen.getByLabelText(`${statusLabel} status`).textContent).toBe(symbol);
  });
});
