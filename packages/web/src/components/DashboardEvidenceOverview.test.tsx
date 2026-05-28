// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  correlationStrengthLabel,
  DashboardEvidenceOverview,
  formatDashboardRange,
  trendPositionLabel,
} from "./DashboardEvidenceOverview.tsx";

describe("DashboardEvidenceOverview helpers", () => {
  it("formats the dashboard date range inclusively", () => {
    expect(formatDashboardRange("2026-05-27", 30)).toBe("Apr 28 - May 27");
  });

  it("labels correlation strength without exposing statistical jargon", () => {
    expect(correlationStrengthLabel(0.72)).toBe("Strong positive");
    expect(correlationStrengthLabel(-0.42)).toBe("Emerging negative");
    expect(correlationStrengthLabel(undefined)).toBe("Collecting signal");
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
        trend={{ latestRestingHeartRate: 52, averageRestingHeartRate: 56 }}
        sources={[
          { id: "whoop", name: "WHOOP", authorized: true },
          { id: "oura", name: "Oura", authorized: true },
          { id: "apple_health", name: "Apple Health", authorized: false, importOnly: true },
        ]}
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
        dailySummary={<div>Daily rings appear first</div>}
        healthMonitor={<div>Latest values vs. rolling average</div>}
      />,
    );

    expect(screen.getByRole("region", { name: "Dashboard overview" })).toBeTruthy();
    expect(screen.getByText("Overview")).toBeTruthy();
    expect(screen.getByText("Apr 28 - May 27")).toBeTruthy();
    expect(screen.getByText("Key correlation")).toBeTruthy();
    expect(screen.getByText("Recent trend")).toBeTruthy();
    expect(screen.getByText("Training load compared with sleep consistency")).toBeTruthy();
    expect(screen.getByText("Compare sources")).toBeTruthy();
    expect(screen.getByText("Apple Health")).toBeTruthy();
    expect(screen.getByText("Health monitor")).toBeTruthy();
    expect(screen.getByText("Latest values vs. rolling average")).toBeTruthy();
    expect(screen.queryByText("Export confidence")).toBeNull();

    const dailySummary = screen.getByText("Daily rings appear first");
    const keyCorrelation = screen.getByText("Key correlation");
    expect(
      dailySummary.compareDocumentPosition(keyCorrelation) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows insight errors instead of falling back to a fake empty correlation", () => {
    render(
      <DashboardEvidenceOverview
        days={30}
        endDate="2026-05-27"
        trend={{ latestRestingHeartRate: 52, averageRestingHeartRate: 56 }}
        sources={[]}
        insightError={<div>Could not load insights.</div>}
        healthMonitor={<div>Latest values vs. rolling average</div>}
      />,
    );

    expect(screen.getByText("Could not load insights.")).toBeTruthy();
    expect(screen.queryByText("Sleep consistency + Heart Rate Variability")).toBeNull();
  });
});
