/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DailyOverview } from "./DailyOverview.tsx";

vi.mock("../lib/chartTheme.ts", () => ({
  chartThemeColors: { gridLine: "#333" },
}));

vi.mock("../hooks/useCountUp.ts", () => ({
  useCountUp: (val: number | null) => val ?? 0,
}));

const mockReadiness = [
  {
    date: "2026-03-22",
    readinessScore: 75,
    components: { hrvScore: 80, restingHrScore: 70, sleepScore: 75, respiratoryRateScore: 65 },
  },
];

const mockWorkloadRatio = {
  displayedStrain: 12.5,
  displayedDate: "2026-03-22",
  timeSeries: [
    { date: "2026-03-22", dailyLoad: 100, acuteLoad: 80, chronicLoad: 70, workloadRatio: 1.14 },
  ],
};

const mockSleepNeed = {
  totalNeedMinutes: 480,
  baselineMinutes: 450,
  strainDebtMinutes: 10,
  accumulatedDebtMinutes: 30,
  recentNights: [{ date: "2026-03-21", actualMinutes: 420, neededMinutes: 480, debtMinutes: 60 }],
};

describe("DailyOverview", () => {
  it("renders loading skeletons when loading", () => {
    render(
      <DailyOverview
        readiness={undefined}
        workloadRatio={undefined}
        sleepNeed={undefined}
        loading={true}
      />,
    );
    const skeletons = document.querySelectorAll(".animate-pulse");
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("renders nothing when no data", () => {
    const { container } = render(
      <DailyOverview
        readiness={undefined}
        workloadRatio={undefined}
        sleepNeed={undefined}
        loading={false}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders recovery ring with score", () => {
    render(
      <DailyOverview
        readiness={mockReadiness}
        workloadRatio={mockWorkloadRatio}
        sleepNeed={mockSleepNeed}
        loading={false}
      />,
    );
    expect(screen.getByText("75")).toBeTruthy();
    expect(screen.getByText("Recovery")).toBeTruthy();
    expect(screen.getByText("Recovered")).toBeTruthy();
  });

  it("renders strain ring", () => {
    render(
      <DailyOverview
        readiness={mockReadiness}
        workloadRatio={mockWorkloadRatio}
        sleepNeed={mockSleepNeed}
        loading={false}
      />,
    );
    expect(screen.getByText("Strain")).toBeTruthy();
  });

  it("renders sleep ring", () => {
    render(
      <DailyOverview
        readiness={mockReadiness}
        workloadRatio={mockWorkloadRatio}
        sleepNeed={mockSleepNeed}
        loading={false}
      />,
    );
    expect(screen.getByText("Sleep")).toBeTruthy();
  });

  it("shows placeholder for missing readiness data", () => {
    render(
      <DailyOverview
        readiness={[]}
        workloadRatio={mockWorkloadRatio}
        sleepNeed={mockSleepNeed}
        loading={false}
      />,
    );
    const noDatas = screen.getAllByText("No data");
    expect(noDatas.length).toBeGreaterThanOrEqual(1);
  });
});
