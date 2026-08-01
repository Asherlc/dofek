/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { MISSING_PREVIOUS_NIGHT_MESSAGE } from "dofek-server/sleep-need-contract";
import { describe, expect, it, vi } from "vitest";
import { SleepOverviewCards } from "./SleepOverviewCards.tsx";

vi.mock("./SleepNeedCard.tsx", () => ({
  SleepNeedCard: () => <div data-testid="sleep-need-card" />,
}));

vi.mock("./SleepPerformanceCard.tsx", () => ({
  SleepPerformanceCard: () => <div data-testid="sleep-performance-card" />,
}));

describe("SleepOverviewCards", () => {
  it("shows one full-width prerequisite card when prior-night sleep is missing", () => {
    render(
      <SleepOverviewCards
        sleepNeed={{
          availability: "missing_previous_night",
          message: MISSING_PREVIOUS_NIGHT_MESSAGE,
        }}
        sleepPerformance={null}
      />,
    );

    expect(screen.getByTestId("sleep-overview-cards").className).not.toContain("lg:grid-cols-2");
    expect(screen.getByTestId("sleep-need-card")).toBeDefined();
    expect(screen.queryByTestId("sleep-performance-card")).toBeNull();
  });

  it("shows both sleep cards when the recommendation is available", () => {
    render(
      <SleepOverviewCards
        sleepNeed={{
          availability: "available",
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
        sleepPerformance={null}
      />,
    );

    expect(screen.getByTestId("sleep-overview-cards").className).toContain("lg:grid-cols-2");
    expect(screen.getByTestId("sleep-need-card")).toBeDefined();
    expect(screen.getByTestId("sleep-performance-card")).toBeDefined();
  });

  it("keeps insufficient-data sleep need full width", () => {
    render(
      <SleepOverviewCards
        sleepNeed={{
          availability: "insufficient_data",
          reason: "missing_previous_day_load",
          message: "Sync yesterday's activity data to include training load in sleep need.",
          nextAction: "Sync activity data for the previous day.",
        }}
        sleepPerformance={null}
      />,
    );

    expect(screen.getByTestId("sleep-overview-cards").className).not.toContain("lg:grid-cols-2");
    expect(screen.queryByTestId("sleep-performance-card")).toBeNull();
  });
});
