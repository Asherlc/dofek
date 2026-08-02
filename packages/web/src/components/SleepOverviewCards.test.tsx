/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { MISSING_PREVIOUS_NIGHT_MESSAGE } from "dofek-server/sleep-need-contract";
import type { SleepPerformanceInfo } from "dofek-server/types";
import { describe, expect, it, vi } from "vitest";
import { SleepOverviewCards } from "./SleepOverviewCards.tsx";

vi.mock("./SleepNeedCard.tsx", () => ({
  SleepNeedCard: () => <div data-testid="sleep-need-card" />,
}));

vi.mock("./SleepPerformanceCard.tsx", () => ({
  SleepPerformanceCard: () => <div data-testid="sleep-performance-card" />,
}));

const sleepPerformance: SleepPerformanceInfo = {
  score: 88,
  tier: "Good",
  actualMinutes: 462,
  neededMinutes: 480,
  efficiency: 92,
  recommendedBedtime: "10:30 PM",
  sleepDate: "2026-04-02",
  providerId: "whoop",
  sourceName: "WHOOP 4.0",
  sourceProviders: ["whoop"],
  summaryDateContext: { effectiveDate: "2026-04-02", timezone: "UTC" },
};

describe("SleepOverviewCards", () => {
  it("keeps both card positions stable when prior-night sleep is missing", () => {
    render(
      <SleepOverviewCards
        sleepNeed={{
          availability: "missing_previous_night",
          epistemicStatus: { kind: "unavailable", label: "Unavailable" },
          message: MISSING_PREVIOUS_NIGHT_MESSAGE,
        }}
        sleepPerformance={null}
      />,
    );

    expect(screen.getByTestId("sleep-overview-cards").className).toContain("lg:grid-cols-2");
    expect(screen.getByTestId("sleep-need-card")).toBeDefined();
    expect(screen.getByTestId("sleep-performance-card")).toBeDefined();
  });

  it("shows both sleep cards when the recommendation is available", () => {
    render(
      <SleepOverviewCards
        sleepNeed={{
          availability: "available",
          epistemicStatus: { kind: "estimated", label: "Estimated" },
          baselineMinutes: 480,
          strainDebtMinutes: 12,
          accumulatedDebtMinutes: 85,
          debtRecoveryMinutes: 21,
          totalNeedMinutes: 513,
          estimateMetadata: {
            basis: "personalized_high_hrv_average",
            baselineQualifyingNightCount: 12,
            debtObservedNightCount: 11,
            methodVersion: "sleep-need-heuristic-v1",
            uncertainty: "not_established",
            valueQualifier: "About",
            summaryLabel: "Heuristic estimate",
            componentLabels: {
              baseline: "Baseline estimate",
              strainDebt: "Previous-day load adjustment",
              debtRecovery: "Debt recovery",
            },
            basisLabel:
              "Baseline uses the average of 12 qualifying nights followed by at-or-above-median heart rate variability.",
            coverageLabel:
              "Sleep-debt input uses 11 observed nights from the model's recent-night window.",
            methodLabel: "Method: sleep-need-heuristic-v1",
            uncertaintyLabel: "Uncertainty: not established",
            limitationLabel:
              "This is a descriptive heuristic estimate, not a sleep recommendation. Its uncertainty has not been established.",
          },
          recentNights: [],
        }}
        sleepPerformance={sleepPerformance}
      />,
    );

    expect(screen.getByTestId("sleep-overview-cards").className).toContain("lg:grid-cols-2");
    expect(screen.getByTestId("sleep-need-card")).toBeDefined();
    expect(screen.getByTestId("sleep-performance-card")).toBeDefined();
  });

  it("keeps valid sleep performance visible with insufficient sleep need data", () => {
    render(
      <SleepOverviewCards
        sleepNeed={{
          availability: "insufficient_data",
          epistemicStatus: { kind: "unavailable", label: "Unavailable" },
          reason: "missing_previous_day_load",
          message: "Sync yesterday's activity data to include training load in sleep need.",
          nextAction: "Sync activity data for the previous day.",
        }}
        sleepPerformance={sleepPerformance}
      />,
    );

    expect(screen.getByTestId("sleep-overview-cards").className).toContain("lg:grid-cols-2");
    expect(screen.getByTestId("sleep-performance-card")).toBeDefined();
  });
});
