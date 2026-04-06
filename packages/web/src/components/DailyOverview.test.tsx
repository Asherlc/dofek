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
    components: { hrvScore: 80, restingHrScore: 70, sleepScore: 72, respiratoryRateScore: 65 },
    weights: { hrv: 0.5, restingHr: 0.2, sleep: 0.15, respiratoryRate: 0.15 },
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
    // "Sleep" appears both in the ring label and the always-mounted recovery breakdown
    expect(screen.getAllByText("Sleep").length).toBeGreaterThanOrEqual(1);
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

  it("shows explanation when empty recovery ring is clicked", () => {
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

    // Click the empty recovery ring
    fireEvent.click(findButton(screen.getByText("Recovery")));

    // Should show an explanation of what data is needed
    expect(screen.getByText(/Recovery score needs HRV/)).toBeTruthy();
  });

  it("shows explanation when empty sleep ring is clicked", () => {
    render(
      <DailyOverview
        readiness={mockReadiness}
        workloadRatio={mockWorkloadRatio}
        sleepPerformance={null}
        readinessLoading={false}
        workloadLoading={false}
        sleepLoading={false}
      />,
    );

    // Click the empty sleep ring (use aria-label since "Sleep" appears in breakdown too)
    fireEvent.click(screen.getByRole("button", { name: "Sleep score breakdown" }));

    // Should show an explanation
    expect(screen.getByText(/Sleep score combines/)).toBeTruthy();
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
    // Sleep ring should render (use getAllByText since "Sleep" appears in recovery breakdown too)
    expect(screen.getAllByText("Sleep").length).toBeGreaterThanOrEqual(1);
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

    const recoveryButton = screen.getByRole("button", { name: "Recovery score breakdown" });

    // Recovery ring should not be expanded initially
    expect(recoveryButton.getAttribute("aria-expanded")).toBe("false");

    // Click the recovery ring button
    fireEvent.click(recoveryButton);

    // Recovery ring should now be expanded
    expect(recoveryButton.getAttribute("aria-expanded")).toBe("true");
    // Breakdown content should be in the DOM with component labels and weight percentages
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

    const strainButton = screen.getByRole("button", { name: "Strain score breakdown" });

    // Strain ring should not be expanded initially
    expect(strainButton.getAttribute("aria-expanded")).toBe("false");

    // Click the strain ring
    fireEvent.click(strainButton);

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

    // Click the sleep ring (use aria-label since "Sleep" appears in recovery breakdown too)
    fireEvent.click(screen.getByRole("button", { name: "Sleep score breakdown" }));

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

    const recoveryButton = screen.getByRole("button", { name: "Recovery score breakdown" });
    fireEvent.click(recoveryButton);
    expect(recoveryButton.getAttribute("aria-expanded")).toBe("true");

    // Click again to collapse
    fireEvent.click(recoveryButton);
    expect(recoveryButton.getAttribute("aria-expanded")).toBe("false");
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

    const recoveryButton = screen.getByRole("button", { name: "Recovery score breakdown" });
    const strainButton = screen.getByRole("button", { name: "Strain score breakdown" });

    // Expand recovery
    fireEvent.click(recoveryButton);
    expect(recoveryButton.getAttribute("aria-expanded")).toBe("true");

    // Click strain — recovery should collapse, strain should expand
    fireEvent.click(strainButton);
    expect(recoveryButton.getAttribute("aria-expanded")).toBe("false");
    expect(strainButton.getAttribute("aria-expanded")).toBe("true");
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
              sleepScore: 72,
              respiratoryRateScore: 65,
            },
            weights: { hrv: 0.5, restingHr: 0.2, sleep: 0.15, respiratoryRate: 0.15 },
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
              sleepScore: 72,
              respiratoryRateScore: 65,
            },
            weights: { hrv: 0.5, restingHr: 0.2, sleep: 0.15, respiratoryRate: 0.15 },
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
