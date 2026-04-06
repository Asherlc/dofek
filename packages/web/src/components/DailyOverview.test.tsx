/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
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
  tier: "Good" as const,
  actualMinutes: 420,
  neededMinutes: 480,
  efficiency: 88,
  recommendedBedtime: "22:30",
  sleepDate: today,
};

/** Find the closest <button> ancestor of an element. */
function findButton(element: HTMLElement): HTMLElement {
  const button = element.closest("button");
  if (!button) throw new Error("No button ancestor found");
  return button;
}

describe("DailyOverview", () => {
  it("renders loading skeletons when loading", () => {
    render(
      <DailyOverview
        readiness={undefined}
        workloadRatio={undefined}
        sleepPerformance={undefined}
        readinessLoading={true}
        workloadLoading={true}
        sleepLoading={true}
      />,
    );
    const skeletons = document.querySelectorAll(".shimmer");
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("renders nothing when no data", () => {
    const { container } = render(
      <DailyOverview
        readiness={undefined}
        workloadRatio={undefined}
        sleepPerformance={undefined}
        readinessLoading={false}
        workloadLoading={false}
        sleepLoading={false}
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
        readinessLoading={false}
        workloadLoading={false}
        sleepLoading={false}
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
        readinessLoading={false}
        workloadLoading={false}
        sleepLoading={false}
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
        readinessLoading={false}
        workloadLoading={false}
        sleepLoading={false}
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
        readinessLoading={false}
        workloadLoading={false}
        sleepLoading={false}
      />,
    );
    const noDatas = screen.getAllByText("No data");
    expect(noDatas.length).toBeGreaterThanOrEqual(1);
  });

  it("renders data for ready rings while still-loading rings show skeleton", () => {
    render(
      <DailyOverview
        readiness={mockReadiness}
        workloadRatio={undefined}
        sleepPerformance={mockSleepPerformance}
        readinessLoading={false}
        workloadLoading={true}
        sleepLoading={false}
      />,
    );
    // Recovery ring should render its score
    expect(screen.getByText("75")).toBeTruthy();
    // Sleep ring should render
    expect(screen.getByText("Sleep")).toBeTruthy();
    // Strain ring should show a skeleton pulse
    const skeletons = document.querySelectorAll(".shimmer");
    expect(skeletons.length).toBe(2); // circle + label skeleton
  });

  it("expands recovery breakdown when recovery ring is clicked", () => {
    render(
      <DailyOverview
        readiness={mockReadiness}
        workloadRatio={mockWorkloadRatio}
        sleepPerformance={mockSleepPerformance}
        readinessLoading={false}
        workloadLoading={false}
        sleepLoading={false}
      />,
    );

    // Breakdown should not be visible initially
    expect(screen.queryByText("Heart Rate Variability")).toBeNull();

    // Click the recovery ring button
    fireEvent.click(findButton(screen.getByText("75")));

    // Breakdown should now be visible with component labels and weight percentages
    expect(screen.getByText("Heart Rate Variability")).toBeTruthy();
    expect(screen.getByText("Resting Heart Rate")).toBeTruthy();
    expect(screen.getByText("(50%)")).toBeTruthy(); // HRV weight
    expect(screen.getByText("Respiratory Rate")).toBeTruthy();
  });

  it("expands strain breakdown when strain ring is clicked", () => {
    const mockStrainTarget = {
      targetStrain: 14,
      currentStrain: 12.5,
      progressPercent: 89,
      zone: "Push" as const,
      explanation: "Recovery is strong (75). Push for a high-strain day to build fitness.",
    };

    render(
      <DailyOverview
        readiness={mockReadiness}
        workloadRatio={mockWorkloadRatio}
        sleepPerformance={mockSleepPerformance}
        strainTarget={mockStrainTarget}
        readinessLoading={false}
        workloadLoading={false}
        sleepLoading={false}
      />,
    );

    // Breakdown should not be visible initially
    expect(screen.queryByText("Daily target:")).toBeNull();

    // Click the strain ring
    fireEvent.click(findButton(screen.getByText("Strain")));

    // Breakdown should show target and load stats
    expect(screen.getByText("14")).toBeTruthy(); // target strain value
    expect(screen.getByText("Push")).toBeTruthy();
    expect(screen.getByText("Acute (7d)")).toBeTruthy();
    expect(screen.getByText("Chronic (28d)")).toBeTruthy();
    expect(screen.getByText("Workload Ratio")).toBeTruthy();
  });

  it("expands sleep breakdown when sleep ring is clicked", () => {
    render(
      <DailyOverview
        readiness={mockReadiness}
        workloadRatio={mockWorkloadRatio}
        sleepPerformance={mockSleepPerformance}
        readinessLoading={false}
        workloadLoading={false}
        sleepLoading={false}
      />,
    );

    // Click the sleep ring
    fireEvent.click(findButton(screen.getByText("Sleep", { selector: "span" })));

    // Breakdown should show sufficiency and efficiency labels
    expect(screen.getByText("Sufficiency")).toBeTruthy();
    expect(screen.getByText("Efficiency")).toBeTruthy();
    expect(screen.getByText(/Bedtime: 22:30/)).toBeTruthy();
  });

  it("collapses breakdown when same ring is clicked again", () => {
    render(
      <DailyOverview
        readiness={mockReadiness}
        workloadRatio={mockWorkloadRatio}
        sleepPerformance={mockSleepPerformance}
        readinessLoading={false}
        workloadLoading={false}
        sleepLoading={false}
      />,
    );

    const recoveryButton = findButton(screen.getByText("75"));
    fireEvent.click(recoveryButton);
    expect(screen.getByText("Heart Rate Variability")).toBeTruthy();

    // Click again to collapse
    fireEvent.click(recoveryButton);
    expect(screen.queryByText("Heart Rate Variability")).toBeNull();
  });

  it("switches breakdown when a different ring is clicked", () => {
    render(
      <DailyOverview
        readiness={mockReadiness}
        workloadRatio={mockWorkloadRatio}
        sleepPerformance={mockSleepPerformance}
        readinessLoading={false}
        workloadLoading={false}
        sleepLoading={false}
      />,
    );

    // Expand recovery
    fireEvent.click(findButton(screen.getByText("75")));
    expect(screen.getByText("Heart Rate Variability")).toBeTruthy();

    // Click strain — recovery breakdown should disappear, strain should appear
    fireEvent.click(findButton(screen.getByText("Strain")));
    expect(screen.queryByText("Heart Rate Variability")).toBeNull();
    expect(screen.getByText("Acute (7d)")).toBeTruthy();
  });

  it("shows yesterday's readiness as fresh (recovery reflects last night)", () => {
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
          tier: "Good" as const,
          actualMinutes: 420,
          neededMinutes: 480,
          efficiency: 88,
          recommendedBedtime: "22:30",
          sleepDate: yesterdayStr,
        }}
        readinessLoading={false}
        workloadLoading={false}
        sleepLoading={false}
      />,
    );
    // Recovery should show yesterday's score (recovery reflects last night's data)
    expect(screen.getByText("75")).toBeTruthy();
    expect(screen.getByText("Recovered")).toBeTruthy();
  });

  it("shows placeholder when readiness data is 2+ days old", () => {
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const twoDaysAgoStr = twoDaysAgo.toLocaleDateString("en-CA");

    render(
      <DailyOverview
        readiness={[
          {
            date: twoDaysAgoStr,
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
          displayedDate: twoDaysAgoStr,
          timeSeries: [
            {
              date: twoDaysAgoStr,
              dailyLoad: 100,
              strain: 12.5,
              acuteLoad: 80,
              chronicLoad: 70,
              workloadRatio: 1.14,
            },
          ],
        }}
        sleepPerformance={null}
        readinessLoading={false}
        workloadLoading={false}
        sleepLoading={false}
      />,
    );
    // Recovery should show "No data" since readiness is 2+ days old
    const noDatas = screen.getAllByText("No data");
    expect(noDatas.length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("75")).toBeNull();
  });
});
