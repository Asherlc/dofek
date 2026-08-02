// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HealthStatusBar } from "./HealthStatusBar.tsx";

const serverMetric = {
  metric: "skin_temperature" as const,
  label: "Skin Temperature",
  value: 34.4,
  valueText: null,
  baseline: 34,
  baselineText: null,
  sampleDeviation: 0.5,
  deviation: 0.8,
  direction: "above" as const,
  intent: "neutral" as const,
  statusToken: "near_baseline" as const,
  statusColor: "positive" as const,
  statusLabel: "Near baseline",
  evaluationRule: "Within your usual range: less than 1 standard deviation from baseline",
  explanation: "Skin Temperature is close to your usual range.",
  baselineProgress: {
    requiredObservationDays: 3,
    observedObservationDays: 3,
    hasMeasurableVariation: true,
    blocker: null,
    requirement: "A current value plus at least 2 more recorded days with measurable variation.",
    summary: "Skin Temperature baseline is ready.",
    action: "No action needed.",
  },
};

describe("HealthStatusBar", () => {
  it("renders server-authored HRV and steps text instead of recomputing raw values", () => {
    render(
      <HealthStatusBar
        metrics={[
          {
            ...serverMetric,
            metric: "hrv",
            label: "Heart Rate Variability (HRV)",
            value: 999,
            valueText: "52 ms",
            baseline: 998,
            baselineText: "51 ms",
          },
          {
            ...serverMetric,
            metric: "steps",
            label: "Steps",
            value: 1,
            valueText: "7,640",
            baseline: 2,
            baselineText: "7,640",
          },
        ]}
        formatters={{
          hrv: () => ({ text: "999 ms", parts: [{ type: "integer", value: "999" }] }),
        }}
      />,
    );

    expect(screen.getByText("52 ms")).toBeDefined();
    expect(screen.getByText(/baseline 51 ms/)).toBeDefined();
    expect(screen.getByText("7,640")).toBeDefined();
    expect(screen.getByText(/baseline 7,640/)).toBeDefined();
    expect(screen.queryByText("999 ms")).toBeNull();
    expect(screen.getByText("52 ms").classList).toContain("whitespace-nowrap");
  });

  it("renders server-computed baseline deviation, comparison, and coverage", () => {
    render(
      <HealthStatusBar
        metrics={[{ ...serverMetric, metric: "hrv", label: "Heart Rate Variability (HRV)" }]}
        baselineRelative={[
          {
            metric: "hrv",
            label: "Heart Rate Variability (HRV)",
            value: 72,
            baseline: {
              windowDays: 30,
              mean: 60,
              standardDeviation: 6,
              zScore: 2,
              sampleCount: 24,
              coverage: 0.8,
            },
            comparison: {
              recentDays: 7,
              baselineDays: 28,
              recentMean: 66,
              baselineMean: 61,
              delta: 5,
              direction: "increasing",
            },
          },
        ]}
      />,
    );

    expect(
      screen.getByText(
        "30d baseline 60.0 ± 6.0 · 2.0 SD above baseline · 7d vs prior 28d +5.0 · 24/30 baseline days",
      ),
    ).toBeDefined();
  });

  it("renders structured units while preserving the exact server status", () => {
    const { container } = render(
      <HealthStatusBar
        metrics={[serverMetric]}
        formatters={{
          skin_temperature: () => ({
            text: "94.0°F",
            parts: [
              { type: "integer", value: "94" },
              { type: "decimal", value: "." },
              { type: "fraction", value: "0" },
              { type: "unit", value: "°F" },
            ],
          }),
        }}
      />,
    );

    expect(container.querySelector(".font-semibold")?.textContent).toContain("94.0°F");
    expect(screen.getByText(/baseline 94.0°F/)).toBeDefined();
    expect(screen.getByText(/Near baseline/)).toBeDefined();
    expect(
      screen.getByText("Within your usual range: less than 1 standard deviation from baseline"),
    ).toBeDefined();
    expect(screen.getByText("Skin Temperature is close to your usual range.")).toBeDefined();
    expect(screen.getByLabelText("Near baseline status").textContent).toBe("✓");
  });

  it("does not recalculate or rename the status returned by the server", () => {
    render(
      <HealthStatusBar
        metrics={[
          {
            ...serverMetric,
            value: 100,
            baseline: 34,
            sampleDeviation: 0.5,
            deviation: 132,
            statusToken: "near_baseline",
            statusColor: "positive",
            statusLabel: "Server-selected label",
            explanation: "Server-selected explanation.",
          },
        ]}
      />,
    );

    expect(screen.getByText(/Server-selected label/)).toBeDefined();
    expect(screen.getByText("Server-selected explanation.")).toBeDefined();
    expect(screen.queryByText(/abnormal/i)).toBeNull();
  });

  it("renders the server insufficient-data state without inventing a classification", () => {
    render(
      <HealthStatusBar
        metrics={[
          {
            ...serverMetric,
            value: null,
            baseline: null,
            sampleDeviation: null,
            deviation: null,
            direction: "unknown",
            statusToken: "insufficient_data",
            statusColor: "muted",
            statusLabel: "Not enough data",
            evaluationRule: "Needs a current value, baseline, and measurable day-to-day variation",
            explanation: "Not enough varied data yet to compare this value with your usual range.",
          },
        ]}
      />,
    );

    expect(screen.getByText(/Not enough data/)).toBeDefined();
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
    render(<HealthStatusBar metrics={[{ ...serverMetric, statusToken, statusLabel }]} />);

    expect(screen.getByLabelText(`${statusLabel} status`).textContent).toBe(symbol);
  });

  it("renders a distinct empty state when no metrics are available", () => {
    render(<HealthStatusBar metrics={[]} />);

    expect(screen.getByText("No health status data for this period.")).toBeDefined();
  });
});
