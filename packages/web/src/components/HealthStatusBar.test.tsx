// @vitest-environment jsdom
import { UnitConverter } from "@dofek/format/units";
import { fireEvent, render, screen, within } from "@testing-library/react";
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
  provenance: null,
  comparison: null,
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
  it("opens and closes supporting details without source provenance", () => {
    render(<HealthStatusBar metrics={[serverMetric]} />);

    const button = screen.getByRole("button", { name: "Show details for Skin Temperature" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    const panel = document.getElementById(button.getAttribute("aria-controls") ?? "");
    expect(panel).not.toBeNull();
    expect(panel).not.toBeVisible();
    expect(screen.queryByText(serverMetric.explanation)).toBeNull();

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(panel).toBeVisible();
    expect(screen.getByText(serverMetric.evaluationRule)).toBeVisible();
    expect(screen.getByText(serverMetric.explanation)).toBeVisible();

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(panel).not.toBeVisible();
    expect(screen.queryByText(serverMetric.explanation)).toBeNull();
    expect(screen.getByText(/Near baseline/)).toBeVisible();
  });

  it("keeps weight-goal context beside the server interpretation", () => {
    render(
      <HealthStatusBar
        metrics={[
          {
            ...serverMetric,
            metric: "trend_weight",
            label: "Trend Weight",
            intent: "lower",
            statusLabel: "Moving as intended",
            statusToken: "moving_as_intended",
          },
        ]}
      />,
    );
    expect(screen.getByText(/Moving as intended · Weight loss goal/)).toBeVisible();
  });

  it("shows missing Steps for this day while retaining its recorded baseline", () => {
    render(
      <HealthStatusBar
        metrics={[
          {
            metric: "steps",
            label: "Steps",
            value: null,
            valueText: null,
            baseline: 6055,
            baselineText: "6,055",
            sampleDeviation: 2000,
            deviation: null,
            direction: "unknown",
            intent: "neutral",
            statusToken: "insufficient_data",
            statusColor: "muted",
            statusLabel: "Steps missing for this day",
            evaluationRule:
              "Needs a step count for this day to compare with your recorded baseline",
            explanation:
              "No step count is available for this day; your recorded baseline is available.",
            comparison: null,
            provenance: {
              latestDate: "2026-10-08",
              sourceProviders: ["apple_health"],
              observedDays: 89,
              windowDays: 90,
            },
            baselineProgress: {
              requiredObservationDays: 3,
              observedObservationDays: 89,
              hasMeasurableVariation: true,
              blocker: "missing_source_data",
              requirement: "A step count for this day to compare with your recorded baseline.",
              summary: "No step count is available for this day.",
              action: "Sync steps data again to record a step count for this day.",
            },
          },
        ]}
      />,
    );

    expect(screen.getByText("—")).toBeVisible();
    expect(screen.getByText("baseline 6,055 · Steps missing for this day")).toBeVisible();
    expect(screen.getByLabelText("Steps missing for this day status").textContent).toBe("?");
    expect(
      screen.getByText("Needs a step count for this day to compare with your recorded baseline"),
    ).toBeVisible();
    expect(
      screen.getByText("Sync steps data again to record a step count for this day."),
    ).toBeVisible();

    const button = screen.getByRole("button", { name: "Show details for Steps" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Coverage: 89/90 days")).toBeNull();
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(
      screen.getByText(
        "No step count is available for this day; your recorded baseline is available.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText("A step count for this day to compare with your recorded baseline."),
    ).toBeVisible();
    expect(screen.getByText("No step count is available for this day.")).toBeVisible();
    expect(screen.getByText("Source: Apple Health")).toBeVisible();
    expect(screen.getByText("Latest recorded date: 2026-10-08")).toBeVisible();
    expect(screen.getByText("Coverage: 89/90 days")).toBeVisible();
  });

  it.each([
    {
      blocker: "collecting" as const,
      summary:
        "Skin Temperature has 1 of 3 required days recorded; the baseline is still collecting observations.",
      action: "Keep syncing skin temperature data for at least 2 more days.",
      showAction: true,
    },
    {
      blocker: "syncing" as const,
      summary: "Skin Temperature baseline data is still syncing.",
      action: "Wait for the sync to finish, then check your baseline again.",
      showAction: false,
    },
    {
      blocker: "sync_error" as const,
      summary: "Skin Temperature baseline data could not sync.",
      action: "Reconnect the data source and start the sync again.",
      showAction: true,
    },
  ])("renders baseline guidance for $blocker", ({ blocker, summary, action, showAction }) => {
    render(
      <HealthStatusBar
        metrics={[
          {
            ...serverMetric,
            value: null,
            valueText: null,
            baseline: null,
            baselineText: null,
            sampleDeviation: null,
            deviation: null,
            direction: "unknown",
            statusToken: "insufficient_data",
            statusColor: "muted",
            statusLabel: "Not enough data",
            evaluationRule: "Needs a current value, baseline, and measurable day-to-day variation",
            explanation: "Not enough varied data yet to compare this value with your usual range.",
            baselineProgress: {
              ...serverMetric.baselineProgress,
              observedObservationDays: 1,
              hasMeasurableVariation: false,
              blocker,
              summary,
              action,
            },
          },
        ]}
      />,
    );

    expect(
      screen.getByText("Needs a current value, baseline, and measurable day-to-day variation"),
    ).toBeVisible();
    if (showAction) {
      expect(screen.getByText(action)).toBeVisible();
    } else {
      expect(screen.queryByText(action)).toBeNull();
    }
    fireEvent.click(screen.getByRole("button", { name: "Show details for Skin Temperature" }));
    expect(
      screen.getByText(
        "A current value plus at least 2 more recorded days with measurable variation.",
      ),
    ).toBeDefined();
    expect(screen.getByText(summary)).toBeVisible();
    expect(
      screen.getAllByText("Needs a current value, baseline, and measurable day-to-day variation"),
    ).toHaveLength(1);
  });

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

  it("shows Fahrenheit means and their difference in the same comparison", () => {
    const units = new UnitConverter("imperial");
    render(
      <HealthStatusBar
        metrics={[
          {
            ...serverMetric,
            comparison: {
              recentDays: 7,
              baselineDays: 28,
              recentMean: 36,
              baselineMean: 35,
              delta: 1,
              direction: "increasing",
            },
          },
        ]}
        formatters={{ skin_temperature: (value) => units.formatTemperature(value) }}
        comparisonFormatters={{ skin_temperature: (value) => units.formatTemperatureDelta(value) }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show details for Skin Temperature" }));
    expect(screen.getByText("7d avg 96.8°F vs prior 28d avg 95.0°F · +1.8°F")).toBeTruthy();
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

    fireEvent.click(
      screen.getByRole("button", { name: "Show details for Heart Rate Variability (HRV)" }),
    );
    expect(
      screen.getByText(
        "30d baseline 60.0 ± 6.0 · 2.0 SD above baseline · 7d vs prior 28d +5.0 · 24/30 baseline days",
      ),
    ).toBeDefined();
  });

  it.each([
    {
      recentMean: 97.2,
      unit: undefined,
      expected: "7d avg 97.2 vs prior 28d avg 96.4 · +0.8",
    },
    {
      recentMean: null,
      unit: undefined,
      expected: "7d vs prior 28d · Not enough comparison data",
    },
    {
      recentMean: 97.2,
      unit: "%",
      expected: "7d avg 97.2 % vs prior 28d avg 96.4 % · +0.8 %",
    },
  ])(
    "renders server-authored provenance and comparison context %#",
    ({ recentMean, unit, expected }) => {
      render(
        <HealthStatusBar
          metrics={[
            {
              ...serverMetric,
              metric: "spo2",
              provenance: {
                latestDate: "2026-07-30",
                sourceProviders: ["whoop"],
                observedDays: 3,
                windowDays: 30,
              },
              comparison: {
                recentDays: 7,
                baselineDays: 28,
                recentMean,
                baselineMean: 96.4,
                delta: 0.8,
                direction: "increasing",
              },
            },
          ]}
          units={{ spo2: unit }}
        />,
      );

      const detailsButton = screen.getByRole("button", {
        name: "Show details for Skin Temperature",
      });
      expect(detailsButton.getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByText("Source: WHOOP (Cloud)")).toBeNull();

      fireEvent.click(detailsButton);

      expect(detailsButton.getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByText(expected)).toBeVisible();
      expect(screen.getByText("Source: WHOOP (Cloud)")).toBeDefined();
      expect(screen.getByText("Latest recorded date: 2026-07-30")).toBeDefined();
      expect(screen.getByText("Coverage: 3/30 days")).toBeDefined();
    },
  );

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
    fireEvent.click(screen.getByRole("button", { name: "Show details for Skin Temperature" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Show details for Skin Temperature" }));
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
  ])(
    "renders $statusToken as the non-color symbol $symbol",
    ({ statusToken, statusLabel, symbol }) => {
      render(<HealthStatusBar metrics={[{ ...serverMetric, statusToken, statusLabel }]} />);

      expect(screen.getByLabelText(`${statusLabel} status`).textContent).toBe(symbol);
    },
  );

  it("renders a distinct empty state when no metrics are available", () => {
    render(<HealthStatusBar metrics={[]} />);

    expect(screen.getByText("No health status data for this period.")).toBeDefined();
  });

  it("groups each metric in one full-width disclosure containing its status, value and interpretation", () => {
    const groupedMetrics = [
      {
        ...serverMetric,
        metric: "hrv" as const,
        label: "Heart Rate Variability (HRV)",
        valueText: "52 ms",
      },
      { ...serverMetric, metric: "steps" as const, label: "Steps", valueText: "7,640" },
    ];
    render(<HealthStatusBar grouped metrics={groupedMetrics} />);

    expect(screen.getAllByRole("button", { name: /details$/ })).toHaveLength(2);
    for (const metric of groupedMetrics) {
      const row = screen.getByRole("button", {
        name: `${metric.label}, ${metric.valueText}, Near baseline. Show details`,
      });
      expect(row.getAttribute("aria-expanded")).toBe("false");
      expect(row.getAttribute("aria-label")).toContain(metric.label);
      expect(row.getAttribute("aria-label")).toContain(metric.valueText);
      expect(row.getAttribute("aria-label")).toContain("Near baseline");
      expect(within(row).getByText(metric.label)).toBeTruthy();
      expect(within(row).getByText(metric.valueText)).toBeTruthy();
      expect(within(row).getByText(/Near baseline/)).toBeTruthy();
    }
  });

  it("keeps the grouped blocked action outside the disclosure and reuses expanded details", () => {
    const action = "Sync steps data again to record a step count for this day.";
    render(
      <HealthStatusBar
        grouped
        metrics={[
          {
            ...serverMetric,
            metric: "steps",
            label: "Steps",
            valueText: null,
            value: null,
            statusToken: "insufficient_data",
            statusLabel: "Steps missing for this day",
            baselineProgress: {
              ...serverMetric.baselineProgress,
              blocker: "missing_source_data",
              action,
            },
          },
        ]}
      />,
    );

    const row = screen.getByRole("button", {
      name: /^Steps, —, Steps missing for this day\. Show details$/,
    });
    expect(screen.getByText(action)).toBeTruthy();
    expect(within(row).queryByText(action)).toBeNull();

    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(serverMetric.explanation)).toBeTruthy();
    expect(screen.getByText(serverMetric.evaluationRule)).toBeTruthy();
  });

  it("shows the exact baseline in grouped expanded details without baselineRelative context", () => {
    render(
      <HealthStatusBar
        grouped
        metrics={[
          {
            ...serverMetric,
            metric: "steps",
            label: "Steps",
            value: 7640,
            valueText: "7,640",
            baseline: 6055,
            baselineText: "6,055",
            comparison: {
              recentDays: 7,
              baselineDays: 28,
              recentMean: 6100,
              baselineMean: 6055,
              delta: 45,
              direction: "increasing",
            },
          },
        ]}
      />,
    );

    const row = screen.getByRole("button", { name: /^Steps, 7,640, .*Show details$/ });
    fireEvent.click(row);

    expect(screen.getByText("6,055")).toBeTruthy();
    expect(screen.getByText("7d avg 6100.0 vs prior 28d avg 6055.0 · +45.0")).toBeTruthy();
  });
});
