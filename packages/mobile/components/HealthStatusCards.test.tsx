// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import type { HealthStatusMetric } from "dofek-server/mobile-dashboard-contracts";
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
    expect(screen.getByText("Moving as intended · Weight loss goal")).toBeTruthy();
    const button = screen.getByRole("button", { name: "Show details for Trend Weight" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.queryByText("Trend Weight is below your baseline, in line with your weight goal."),
    ).toBeNull();
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(
      screen.getByText("Below your baseline, where lower values support this metric"),
    ).toBeTruthy();
    expect(
      screen.getByText("Trend Weight is below your baseline, in line with your weight goal."),
    ).toBeTruthy();
    expect(screen.getByLabelText("Moving as intended status").textContent).toBe("✓");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.queryByText("Trend Weight is below your baseline, in line with your weight goal."),
    ).toBeNull();
  });

  it("shows missing Steps for this day while retaining its recorded baseline", () => {
    render(
      <HealthStatusCards
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

    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText("baseline 6,055 · Steps missing for this day")).toBeTruthy();
    expect(screen.getByLabelText("Steps missing for this day status").textContent).toBe("?");
    expect(
      screen.getByText("Needs a step count for this day to compare with your recorded baseline"),
    ).toBeTruthy();
    expect(
      screen.getByText("Sync steps data again to record a step count for this day."),
    ).toBeTruthy();

    const button = screen.getByRole("button", { name: "Show details for Steps" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Coverage: 89/90 days")).toBeNull();
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(
      screen.getByText(
        "No step count is available for this day; your recorded baseline is available.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("A step count for this day to compare with your recorded baseline."),
    ).toBeTruthy();
    expect(screen.getByText("No step count is available for this day.")).toBeTruthy();
    expect(screen.getByText("Source: Apple Health")).toBeTruthy();
    expect(screen.getByText("Latest recorded date: 2026-10-08")).toBeTruthy();
    expect(screen.getByText("Coverage: 89/90 days")).toBeTruthy();
  });

  it.each([
    {
      blocker: "collecting" as const,
      summary:
        "Resting Heart Rate has 1 of 3 required days recorded; the baseline is still collecting observations.",
      action: "Keep syncing resting heart rate data for at least 2 more days.",
    },
    {
      blocker: "syncing" as const,
      summary: "Resting Heart Rate baseline data is still syncing.",
      action: "Wait for the sync to finish, then check your baseline again.",
    },
    {
      blocker: "sync_error" as const,
      summary: "Resting Heart Rate baseline data could not sync.",
      action: "Reconnect the data source and start the sync again.",
    },
  ])("renders baseline requirements and actionable guidance for $blocker", (fixture) => {
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
            evaluationRule: "Needs a current value, baseline, and measurable day-to-day variation",
            explanation: "Server-selected explanation.",
            baselineProgress: {
              requiredObservationDays: 3,
              observedObservationDays: 1,
              hasMeasurableVariation: false,
              blocker: fixture.blocker,
              requirement:
                "A current value plus at least 2 more recorded days with measurable variation.",
              summary: fixture.summary,
              action: fixture.action,
            },
          },
        ]}
      />,
    );

    expect(screen.getByText("Waiting for baseline")).toBeTruthy();
    expect(
      screen.getByText("Needs a current value, baseline, and measurable day-to-day variation"),
    ).toBeTruthy();
    if (fixture.blocker === "syncing") {
      expect(screen.queryByText(fixture.action)).toBeNull();
    } else {
      expect(screen.getByText(fixture.action)).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", { name: "Show details for Resting Heart Rate" }));
    expect(
      screen.getByText(
        "A current value plus at least 2 more recorded days with measurable variation.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(fixture.summary)).toBeTruthy();
    if (fixture.blocker === "syncing") {
      expect(screen.queryByText(fixture.action)).toBeNull();
    } else {
      expect(screen.getByText(fixture.action)).toBeTruthy();
    }
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
    fireEvent.click(screen.getByRole("button", { name: "Show details for Body Fat %" }));
    expect(screen.getByText("Server-selected rule.")).toBeTruthy();
    expect(screen.getByText("Server-selected explanation.")).toBeTruthy();
    expect(screen.queryByText(/abnormal/i)).toBeNull();
  });

  it.each([
    { recentMean: 97.2, expected: "7d avg 97.2 vs prior 28d avg 96.4 · +0.8" },
    { recentMean: null, expected: "7d avg — vs prior 28d avg 96.4 · +0.8" },
  ])("renders server-authored provenance and comparison context %#", ({ recentMean, expected }) => {
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
              recentMean,
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

    const detailsButton = screen.getByRole("button", {
      name: "Show details for Blood Oxygen Saturation (SpO2)",
    });
    expect(detailsButton.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Source: WHOOP (Cloud)")).toBeNull();

    fireEvent.click(detailsButton);

    expect(detailsButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(expected)).toBeTruthy();
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
  ])(
    "renders $statusToken as the non-color symbol $symbol",
    ({ statusToken, statusLabel, symbol }) => {
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
    },
  );
});

function compactMetric(
  overrides: Partial<HealthStatusMetric> & Pick<HealthStatusMetric, "metric" | "label">,
): HealthStatusMetric {
  return {
    value: 52,
    valueText: "52 ms",
    baseline: 50,
    baselineText: "50 ms",
    sampleDeviation: 5,
    deviation: 0.4,
    direction: "above",
    intent: "neutral",
    statusToken: "near_baseline",
    statusColor: "positive",
    statusLabel: "Near baseline",
    evaluationRule: "Within your usual range: less than 1 standard deviation from baseline",
    explanation: "The most recent measurement was near your baseline.",
    provenance: null,
    comparison: null,
    baselineProgress: readyBaselineProgress,
    ...overrides,
  };
}

describe("HealthStatusCards compact grouped summary", () => {
  it("groups one focusable disclosure per row with metric, status and value together", () => {
    const hrv = compactMetric({ metric: "hrv", label: "Heart Rate Variability (HRV)" });
    const steps = compactMetric({
      metric: "steps",
      label: "Steps",
      valueText: "7,640",
      baselineText: "7,640",
    });
    render(<HealthStatusCards compact metrics={[hrv, steps]} />);

    const rows = screen.getAllByRole("button", { name: /details$/ });
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.getByRole("button", {
        name: /Heart Rate Variability \(HRV\), 52 ms, Near baseline\. Show details/,
      }),
    ).toBeTruthy();
    expect(within(rows[0]).getByText("Heart Rate Variability (HRV)")).toBeTruthy();
    expect(within(rows[0]).getByText("52 ms")).toBeTruthy();
    expect(within(rows[0]).getByText("Near baseline")).toBeTruthy();
    expect(within(rows[0]).queryByText(/baseline 50 ms/)).toBeNull();
    expect(within(rows[1]).getByText("7,640")).toBeTruthy();
    expect(within(rows[1]).getByText("Steps")).toBeTruthy();
  });

  it("shows the concise status in the row and moves exact baseline and evidence into expanded details", () => {
    const longStatus = "Notably above baseline · Weight management goal";
    const metric = compactMetric({
      metric: "trend_weight",
      label: "Trend Weight",
      statusLabel: longStatus,
      valueText: "84.2 kg",
      baselineText: "82.0 kg",
      explanation: "Trend Weight is above your usual range.",
      provenance: {
        latestDate: "2026-11-17",
        sourceProviders: ["whoop"],
        observedDays: 5,
        windowDays: 7,
      },
      comparison: {
        recentDays: 7,
        baselineDays: 28,
        recentMean: 84,
        baselineMean: 82,
        delta: 2,
        direction: "increasing",
      },
    });
    render(<HealthStatusCards compact metrics={[metric]} />);

    const row = screen.getByRole("button", { name: /Trend Weight, 84\.2 kg, .*Show details/ });
    expect(within(row).getByText(longStatus)).toBeTruthy();
    expect(screen.queryByText(/baseline 82.0 kg/)).toBeNull();

    fireEvent.click(row);

    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Baseline: 82.0 kg")).toBeTruthy();
    expect(screen.getByText("Trend Weight is above your usual range.")).toBeTruthy();
    expect(screen.getByText("7d avg 84 vs prior 28d avg 82 · +2")).toBeTruthy();
    expect(screen.getByText("Source: WHOOP (Cloud)")).toBeTruthy();
    expect(screen.getByText("Latest recorded date: 2026-11-17")).toBeTruthy();
    expect(screen.getByText("Coverage: 5/7 days")).toBeTruthy();
  });

  it("keeps the blocked baseline action visible and exposes requirement, summary, baseline and provenance on expand", () => {
    const requirement = "A step count for this day to compare with your recorded baseline.";
    const summary = "No step count is available for this day.";
    const action = "Sync steps data again to record a step count for this day.";
    const metric = compactMetric({
      metric: "steps",
      label: "Steps",
      value: null,
      valueText: null,
      baselineText: "6,055",
      statusToken: "insufficient_data",
      statusLabel: "Steps missing for this day",
      provenance: {
        latestDate: "2026-10-08",
        sourceProviders: ["apple_health"],
        observedDays: 89,
        windowDays: 90,
      },
      comparison: {
        recentDays: 7,
        baselineDays: 28,
        recentMean: 6100,
        baselineMean: 6055,
        delta: 45,
        direction: "increasing",
      },
      baselineProgress: {
        ...readyBaselineProgress,
        blocker: "missing_source_data",
        requirement,
        summary,
        action,
      },
    });
    render(<HealthStatusCards compact metrics={[metric]} />);

    const row = screen.getByRole("button", {
      name: /Steps, —, Steps missing for this day\. Show details/,
    });
    expect(screen.getByText(action)).toBeTruthy();
    expect(within(row).queryByText(action)).toBeNull();
    expect(screen.queryByText(summary)).toBeNull();

    fireEvent.click(row);

    expect(screen.getByText(requirement)).toBeTruthy();
    expect(screen.getByText(summary)).toBeTruthy();
    expect(screen.getByText("Baseline: 6,055")).toBeTruthy();
    expect(screen.getByText("Source: Apple Health")).toBeTruthy();
    expect(screen.getByText("Coverage: 89/90 days")).toBeTruthy();
    expect(screen.getByText("7d avg 6100 vs prior 28d avg 6055 · +45")).toBeTruthy();
  });

  it("shows the blocked evaluation rule inside compact expanded details", () => {
    const evaluationRule = "Requires a recorded value above the baseline minimum.";
    const metric = compactMetric({
      metric: "steps",
      label: "Steps",
      value: null,
      valueText: null,
      baselineText: "6,055",
      statusToken: "insufficient_data",
      statusLabel: "Steps missing for this day",
      evaluationRule,
      baselineProgress: {
        ...readyBaselineProgress,
        blocker: "missing_source_data",
        requirement: "A step count is required.",
        summary: "No step count for this day.",
        action: "Sync steps data again.",
      },
    });
    render(<HealthStatusCards compact metrics={[metric]} />);

    const row = screen.getByRole("button", { name: /^Steps, —, .*Show details$/ });
    expect(screen.queryByText(evaluationRule)).toBeNull();

    fireEvent.click(row);

    expect(screen.getByText(evaluationRule)).toBeTruthy();
  });
});
