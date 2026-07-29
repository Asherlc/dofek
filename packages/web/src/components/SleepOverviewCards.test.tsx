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
          recentNights: [],
        }}
        sleepPerformance={null}
      />,
    );

    expect(screen.getByTestId("sleep-overview-cards").className).toContain("lg:grid-cols-2");
    expect(screen.getByTestId("sleep-need-card")).toBeDefined();
    expect(screen.getByTestId("sleep-performance-card")).toBeDefined();
  });
});
