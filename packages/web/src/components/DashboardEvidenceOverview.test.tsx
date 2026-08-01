// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  DashboardEvidenceOverview,
  formatDashboardRange,
  trendPositionLabel,
} from "./DashboardEvidenceOverview.tsx";

describe("DashboardEvidenceOverview helpers", () => {
  it("formats the dashboard date range inclusively", () => {
    expect(formatDashboardRange("2026-05-27", 30)).toBe("Apr 28 - May 27");
  });

  it("labels resting heart rate position against baseline", () => {
    expect(trendPositionLabel({ latestRestingHeartRate: 52, averageRestingHeartRate: 56 })).toBe(
      "below average",
    );
    expect(trendPositionLabel({ latestRestingHeartRate: null, averageRestingHeartRate: 56 })).toBe(
      "Waiting for baseline",
    );
  });
});

describe("DashboardEvidenceOverview", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the evidence desk content architecture", () => {
    render(
      <DashboardEvidenceOverview
        days={30}
        endDate="2026-05-27"
        trend={{
          latestRestingHeartRate: 52,
          averageRestingHeartRate: 56,
          restingHeartRatePoints: [
            { date: "2026-05-26", value: 56 },
            { date: "2026-05-27", value: 52 },
          ],
        }}
        topInsight={{
          id: "insight-1",
          type: "correlation",
          confidence: "strong",
          metric: "Sleep consistency",
          action: "Heart Rate Variability",
          message: "Sleep consistency + Heart Rate Variability",
          detail: "30-day correlation",
          whenTrue: { mean: 1, n: 30 },
          whenFalse: { mean: 0, n: 30 },
          effectSize: 0.72,
          pValue: 0.01,
          evidence: {
            relationship: "correlation",
            label: "Server-authored descriptive correlation",
            method: "Server correlation method.",
            interpretation: "Server interpretation: association does not establish causation.",
            limitations:
              "Server limitations: missing observations and confounding remain possible.",
            recommendation: "Server recommendation: this is not a prescription.",
          },
          dataPoints: [{ x: 68, y: 82, date: "2026-05-27" }],
        }}
        healthMonitor={<div>Latest values vs. rolling average</div>}
      />,
    );

    expect(screen.getByRole("region", { name: "Dashboard overview" })).toBeTruthy();
    expect(screen.getByText("Overview")).toBeTruthy();
    expect(screen.getByText("Apr 28 - May 27")).toBeTruthy();
    expect(screen.getByText("Key correlation")).toBeTruthy();
    expect(screen.getByText("Server-authored descriptive correlation")).toBeTruthy();
    expect(
      screen.getByText("Server interpretation: association does not establish causation."),
    ).toBeTruthy();
    expect(screen.getByText("Recent trend")).toBeTruthy();
    expect(screen.getByText("Training load compared with sleep consistency")).toBeTruthy();
    expect(screen.queryByText("Compare sources")).toBeNull();
    expect(screen.queryByText("Connected source coverage")).toBeNull();
    expect(screen.getByText("Health monitor")).toBeTruthy();
    expect(screen.getByText("Latest values vs. rolling average")).toBeTruthy();
    expect(screen.queryByText("Export confidence")).toBeNull();
  });

  it("renders axes and hover details from API-backed chart points", () => {
    render(
      <DashboardEvidenceOverview
        days={30}
        endDate="2026-05-27"
        trend={{
          latestRestingHeartRate: 52,
          averageRestingHeartRate: 56,
          restingHeartRatePoints: [
            { date: "2026-05-25", value: 57 },
            { date: "2026-05-26", value: 55 },
            { date: "2026-05-27", value: 52 },
          ],
        }}
        topInsight={{
          id: "insight-1",
          type: "correlation",
          confidence: "strong",
          metric: "Sleep consistency",
          action: "Heart Rate Variability",
          message: "Sleep consistency + Heart Rate Variability",
          detail: "30-day correlation",
          whenTrue: { mean: 1, n: 30 },
          whenFalse: { mean: 0, n: 30 },
          effectSize: 0.72,
          pValue: 0.01,
          dataPoints: [
            { x: 62, y: 74, date: "2026-05-25" },
            { x: 68, y: 82, date: "2026-05-27" },
          ],
        }}
        healthMonitor={<div>Latest values vs. rolling average</div>}
      />,
    );

    expect(screen.getByText("Heart Rate Variability")).toBeTruthy();
    expect(screen.getByText("Sleep consistency")).toBeTruthy();
    expect(
      screen.getByText("May 27: Heart Rate Variability: 68, Sleep consistency: 82"),
    ).toBeTruthy();

    expect(screen.getByText("May 25")).toBeTruthy();
    expect(screen.getByText("May 27")).toBeTruthy();
    expect(screen.getByText("57 bpm")).toBeTruthy();
    expect(screen.getByText("52 bpm")).toBeTruthy();
    expect(screen.getByText("May 25: Resting heart rate: 57 bpm")).toBeTruthy();
    expect(screen.getByText("May 27: Resting heart rate: 52 bpm")).toBeTruthy();
  });

  it("does not render fake chart data when API-backed points are missing", () => {
    render(
      <DashboardEvidenceOverview
        days={30}
        endDate="2026-05-27"
        trend={{ latestRestingHeartRate: 52, averageRestingHeartRate: 56 }}
        topInsight={{
          id: "insight-1",
          type: "correlation",
          confidence: "strong",
          metric: "Sleep consistency",
          action: "Heart Rate Variability",
          message: "Sleep consistency + Heart Rate Variability",
          detail: "30-day correlation",
          whenTrue: { mean: 1, n: 30 },
          whenFalse: { mean: 0, n: 30 },
          effectSize: 0.72,
          pValue: 0.01,
        }}
        healthMonitor={<div>Latest values vs. rolling average</div>}
      />,
    );

    expect(screen.getAllByText("No chart data yet.")).toHaveLength(3);
    expect(screen.queryByText("Training load: 10, Sleep consistency: 82")).toBeNull();
    expect(screen.queryByText("Average resting heart rate: 56 bpm")).toBeNull();
  });

  it("uses chart loading and error states for resting heart rate points", () => {
    const loadingResult = render(
      <DashboardEvidenceOverview
        days={30}
        endDate="2026-05-27"
        trend={{ latestRestingHeartRate: 52, averageRestingHeartRate: 56 }}
        restingHeartRateLoading={true}
        healthMonitor={<div>Latest values vs. rolling average</div>}
      />,
    );

    expect(loadingResult.container.querySelector(".animate-spin")).not.toBeNull();
    expect(screen.getAllByText("No chart data yet.")).toHaveLength(2);

    loadingResult.unmount();

    render(
      <DashboardEvidenceOverview
        days={30}
        endDate="2026-05-27"
        trend={{ latestRestingHeartRate: 52, averageRestingHeartRate: 56 }}
        restingHeartRateError={new Error("Resting heart rate chart failed.")}
        healthMonitor={<div>Latest values vs. rolling average</div>}
      />,
    );

    expect(screen.getByText("Resting heart rate chart failed.")).toBeTruthy();
    expect(screen.getAllByText("No chart data yet.")).toHaveLength(2);
  });

  it("labels resting heart rate axes with observed values instead of padded domains", () => {
    render(
      <DashboardEvidenceOverview
        days={30}
        endDate="2026-05-27"
        trend={{
          latestRestingHeartRate: 55,
          averageRestingHeartRate: 55,
          restingHeartRatePoints: [
            { date: "2026-05-26", value: 55 },
            { date: "2026-05-27", value: 55 },
          ],
        }}
        healthMonitor={<div>Latest values vs. rolling average</div>}
      />,
    );

    expect(screen.getAllByText("55 bpm").length).toBeGreaterThan(0);
    expect(screen.queryByText("54 bpm")).toBeNull();
    expect(screen.queryByText("56 bpm")).toBeNull();
  });

  it("colors resting heart rate by whether the trend is happy or sad", () => {
    const lowerResult = render(
      <DashboardEvidenceOverview
        days={30}
        endDate="2026-05-27"
        trend={{
          latestRestingHeartRate: 52,
          averageRestingHeartRate: 56,
          restingHeartRatePoints: [
            { date: "2026-05-26", value: 56 },
            { date: "2026-05-27", value: 52 },
          ],
        }}
        healthMonitor={<div>Latest values vs. rolling average</div>}
      />,
    );

    expect(screen.getByText("52").className).toContain("text-accent");
    expect(lowerResult.container.innerHTML).toContain('stroke="var(--color-accent)"');

    lowerResult.unmount();

    const higherResult = render(
      <DashboardEvidenceOverview
        days={30}
        endDate="2026-05-27"
        trend={{
          latestRestingHeartRate: 60,
          averageRestingHeartRate: 56,
          restingHeartRatePoints: [
            { date: "2026-05-26", value: 56 },
            { date: "2026-05-27", value: 60 },
          ],
        }}
        healthMonitor={<div>Latest values vs. rolling average</div>}
      />,
    );

    expect(screen.getByText("60").className).toContain("text-danger");
    expect(higherResult.container.innerHTML).toContain('stroke="var(--color-danger)"');
  });

  it("shows insight errors instead of falling back to a fake empty correlation", () => {
    render(
      <DashboardEvidenceOverview
        days={30}
        endDate="2026-05-27"
        trend={{ latestRestingHeartRate: 52, averageRestingHeartRate: 56 }}
        insightError={<div>Could not load insights.</div>}
        healthMonitor={<div>Latest values vs. rolling average</div>}
      />,
    );

    expect(screen.getByText("Could not load insights.")).toBeTruthy();
    expect(screen.queryByText("Sleep consistency + Heart Rate Variability")).toBeNull();
  });
});
