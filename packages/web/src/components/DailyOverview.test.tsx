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

const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD

const mockReadiness = [
  {
    date: today,
    readinessScore: 75,
    components: { hrvScore: 80, restingHrScore: 70, sleepScore: 75, respiratoryRateScore: 65 },
  },
];

const mockWorkloadRatio = {
  displayedStrain: 12.5,
  displayedDate: today,
  timeSeries: [
    {
      date: today,
      dailyLoad: 100,
      strain: 12.5,
      acuteLoad: 80,
      chronicLoad: 70,
      workloadRatio: 1.14,
    },
  ],
};

const mockSleepPerformance = {
  score: 82,
  tier: "Perform" as const,
  actualMinutes: 420,
  neededMinutes: 480,
  efficiency: 88,
  recommendedBedtime: "22:30",
  sleepDate: today,
};

describe("DailyOverview", () => {
  it("renders loading skeletons when loading", () => {
    render(
      <DailyOverview
        readiness={undefined}
        workloadRatio={undefined}
        sleepPerformance={undefined}
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
        sleepPerformance={undefined}
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
        sleepPerformance={mockSleepPerformance}
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
        sleepPerformance={mockSleepPerformance}
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
        sleepPerformance={mockSleepPerformance}
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
        sleepPerformance={mockSleepPerformance}
        loading={false}
      />,
    );
    const noDatas = screen.getAllByText("No data");
    expect(noDatas.length).toBeGreaterThanOrEqual(1);
  });

  it("shows placeholders when data is from yesterday (not synced today)", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toLocaleDateString("en-CA");

    render(
      <DailyOverview
        readiness={[
          {
            date: yesterdayStr,
            readinessScore: 75,
            components: {
              hrvScore: 80,
              restingHrScore: 70,
              sleepScore: 75,
              respiratoryRateScore: 65,
            },
          },
        ]}
        workloadRatio={{
          displayedStrain: 12.5,
          displayedDate: yesterdayStr,
          timeSeries: [
            {
              date: yesterdayStr,
              dailyLoad: 100,
              strain: 12.5,
              acuteLoad: 80,
              chronicLoad: 70,
              workloadRatio: 1.14,
            },
          ],
        }}
        sleepPerformance={{
          score: 82,
          tier: "Perform" as const,
          actualMinutes: 420,
          neededMinutes: 480,
          efficiency: 88,
          recommendedBedtime: "22:30",
          sleepDate: yesterdayStr,
        }}
        loading={false}
      />,
    );
    // Recovery should show "No data" since readiness is from yesterday
    const noDatas = screen.getAllByText("No data");
    expect(noDatas.length).toBeGreaterThanOrEqual(1);
    // Score "75" should NOT appear since readiness data is stale
    expect(screen.queryByText("75")).toBeNull();
  });
});
