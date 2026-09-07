/** @vitest-environment jsdom */
import { formatDateYmd } from "@dofek/format/format";
import { duration } from "@dofek/scoring/tokens";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DailyOverview } from "./DailyOverview.tsx";

const mockUseCountUp = vi.hoisted(() => vi.fn((val: number | null) => val ?? 0));

vi.mock("../lib/chartTheme.ts", () => ({
  chartThemeColors: { gridLine: "#333" },
}));

vi.mock("../hooks/useCountUp.ts", () => ({
  useCountUp: mockUseCountUp,
}));

const today = formatDateYmd();

const mockReadiness = [
  {
    date: today,
    readinessScore: 75,
    components: { hrvScore: 80, restingHrScore: 70, sleepScore: 72, respiratoryRateScore: 65 },
    weights: { hrv: 0.5, restingHr: 0.2, sleep: 0.15, respiratoryRate: 0.15 },
  },
];

const mockWorkloadRatio = {
  context: {
    label: "Recent-to-baseline workload ratio",
    description:
      "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days. This is descriptive context, not a safe range or an injury prediction.",
    recentDays: 7,
    baselineDays: 28,
  },
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
  providerId: "whoop",
  sourceName: null,
  sourceProviders: ["whoop"],
  summaryDateContext: {
    effectiveDate: today,
    timezone: "America/Los_Angeles",
  },
};

/** Find the closest <button> ancestor of an element. */
function findButton(element: HTMLElement): HTMLElement {
  const button = element.closest("button");
  if (!button) throw new Error("No button ancestor found");
  return button;
}

describe("DailyOverview", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    mockUseCountUp.mockClear();
  });

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

  it.each([
    ["readiness", "Recovery", { readinessError: new Error("Readiness unavailable") }],
    ["workload", "Strain", { workloadError: new Error("Workload unavailable") }],
    [
      "strain target",
      "Strain target",
      { strainTargetError: new Error("Strain target unavailable") },
    ],
    ["sleep", "Sleep", { sleepError: new Error("Sleep performance unavailable") }],
  ])(
    "shows the exact %s query failure instead of hiding the summary",
    (_name, label, errorProps) => {
      render(
        <DailyOverview
          readiness={undefined}
          workloadRatio={undefined}
          sleepPerformance={undefined}
          readinessLoading={false}
          workloadLoading={false}
          strainTargetLoading={false}
          sleepLoading={false}
          {...errorProps}
        />,
      );

      expect(screen.getByRole("region", { name: "Daily health summary" })).toBeTruthy();
      const contextHeading = `${label}: Could not load this section`;
      const alert = screen.getByRole("heading", { name: contextHeading }).closest('[role="alert"]');
      expect(alert).not.toBeNull();
      expect(alert).toHaveTextContent(Object.values(errorProps)[0]?.message ?? "");
      expect(screen.getByTestId("query-state-error")).toBeTruthy();
    },
  );

  it("shows all core query failures together", () => {
    render(
      <DailyOverview
        readiness={undefined}
        workloadRatio={undefined}
        sleepPerformance={undefined}
        readinessError={new Error("Readiness unavailable")}
        workloadError={new Error("Workload unavailable")}
        strainTargetError={new Error("Strain target unavailable")}
        sleepError={new Error("Sleep performance unavailable")}
      />,
    );

    expect(screen.getByText("Readiness unavailable")).toBeTruthy();
    expect(screen.getByText("Workload unavailable")).toBeTruthy();
    expect(screen.getByText("Strain target unavailable")).toBeTruthy();
    expect(screen.getByText("Sleep performance unavailable")).toBeTruthy();
    expect(screen.getAllByRole("alert")).toHaveLength(4);
    expect(
      screen.getByRole("heading", { name: "Recovery: Could not load this section" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Strain: Could not load this section" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Strain target: Could not load this section" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Sleep: Could not load this section" }),
    ).toBeTruthy();
  });

  it("keeps cached ring data visible during background failures", () => {
    render(
      <DailyOverview
        readiness={mockReadiness}
        workloadRatio={mockWorkloadRatio}
        sleepPerformance={mockSleepPerformance}
        readinessError={new Error("Readiness refresh unavailable")}
        workloadError={new Error("Workload refresh unavailable")}
        strainTargetError={new Error("Strain target refresh unavailable")}
        sleepError={new Error("Sleep refresh unavailable")}
      />,
    );

    expect(screen.getByText("75")).toBeTruthy();
    expect(screen.getByText("Readiness refresh unavailable")).toBeTruthy();
    expect(screen.getByText("Workload refresh unavailable")).toBeTruthy();
    expect(screen.getByText("Strain target refresh unavailable")).toBeTruthy();
    expect(screen.getByText("Sleep refresh unavailable")).toBeTruthy();
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

  it("uses the evidence desk summary panel styling", () => {
    const { container } = render(
      <DailyOverview
        readiness={mockReadiness}
        workloadRatio={mockWorkloadRatio}
        sleepPerformance={mockSleepPerformance}
        readinessLoading={false}
        workloadLoading={false}
        sleepLoading={false}
      />,
    );
    const panel = container.firstElementChild;
    expect(panel).toBeTruthy();
    expect(panel instanceof HTMLElement).toBe(true);
    if (panel instanceof HTMLElement) {
      expect(panel.getAttribute("aria-label")).toBe("Daily health summary");
      expect(panel.className).toContain("dashboard-hero");
      expect(panel.className).toContain("card");
    }
  });

  it("can render as an embedded panel without a nested card", () => {
    const { container } = render(
      <DailyOverview
        embedded
        readiness={mockReadiness}
        workloadRatio={mockWorkloadRatio}
        sleepPerformance={mockSleepPerformance}
        readinessLoading={false}
        workloadLoading={false}
        sleepLoading={false}
      />,
    );
    const panel = container.firstElementChild;
    expect(panel).toBeTruthy();
    expect(panel instanceof HTMLElement).toBe(true);
    if (panel instanceof HTMLElement) {
      expect(panel.className).not.toContain("dashboard-hero");
      expect(panel.classList.contains("card")).toBe(false);
      expect(panel.className).toContain("bg-surface");
    }
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

  it("renders the server-authored date and timezone for the daily and sleep summaries", () => {
    render(
      <DailyOverview
        endDate="2026-08-02"
        summaryDateContext={{
          effectiveDate: "2026-08-02",
          timezone: "America/Los_Angeles",
        }}
        readiness={mockReadiness}
        workloadRatio={mockWorkloadRatio}
        sleepPerformance={{ ...mockSleepPerformance, sleepDate: "2026-08-01" }}
        readinessLoading={false}
        workloadLoading={false}
        sleepLoading={false}
      />,
    );

    expect(screen.getByText("Sun, Aug 2, 2026 · America/Los_Angeles")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Sleep score breakdown" }));

    expect(screen.getByText("Night of Sat, Aug 1, 2026 · America/Los_Angeles")).toBeTruthy();
  });

  it("renders contextual descriptions below each score ring", () => {
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
    // Recovery description
    expect(screen.getByText(/ready for high-intensity/)).toBeTruthy();
    // Strain description (moderate strain = productive)
    expect(screen.getByText(/productive training day/)).toBeTruthy();
    // Sleep description (Good tier)
    expect(screen.getByText(/most of what your body needed/)).toBeTruthy();
  });

  it("uses the standard count-up duration for recovery, strain, and sleep rings", () => {
    const { container } = render(
      <DailyOverview
        readiness={mockReadiness}
        workloadRatio={mockWorkloadRatio}
        sleepPerformance={mockSleepPerformance}
        readinessLoading={false}
        workloadLoading={false}
        sleepLoading={false}
      />,
    );

    expect(mockUseCountUp).toHaveBeenCalledWith(75, duration.countUp);
    expect(mockUseCountUp).toHaveBeenCalledWith(12.5, duration.countUp, 1);
    expect(mockUseCountUp).toHaveBeenCalledWith(82, duration.countUp);

    const animatedCircles = Array.from(container.querySelectorAll("circle")).filter((circle) =>
      circle.getAttribute("style")?.includes("stroke-dashoffset"),
    );
    expect(animatedCircles.length).toBeGreaterThanOrEqual(3);
    for (const circle of animatedCircles) {
      expect(circle.getAttribute("style")).toContain(`${duration.countUp}ms`);
    }
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
    expect(screen.getByText(/Recovery score needs heart rate variability/)).toBeTruthy();
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

  it("shows the strain skeleton while the strain target is loading", () => {
    render(
      <DailyOverview
        endDate="2026-03-31"
        readiness={mockReadiness}
        workloadRatio={{
          context: {
            label: "Recent-to-baseline workload ratio",
            description:
              "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days. This is descriptive context, not a safe range or an injury prediction.",
            recentDays: 7,
            baselineDays: 28,
          },
          displayedStrain: 10.2,
          displayedDate: "2026-03-30",
          timeSeries: [
            {
              date: "2026-03-30",
              dailyLoad: 100,
              strain: 10.2,
              acuteLoad: 80,
              chronicLoad: 70,
              workloadRatio: 1.14,
            },
          ],
        }}
        sleepPerformance={mockSleepPerformance}
        readinessLoading={false}
        workloadLoading={false}
        strainTargetLoading={true}
        sleepLoading={false}
      />,
    );

    expect(screen.queryByRole("button", { name: "Strain score breakdown" })).toBeNull();
    const skeletons = document.querySelectorAll(".shimmer");
    expect(skeletons.length).toBe(2);
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
      dailyLoad: 100,
      acuteLoad: 80,
      chronicLoad: 70,
      workloadRatio: 1.14,
      readinessScore: 75,
    };

    render(
      <DailyOverview
        readiness={mockReadiness}
        workloadRatio={{
          ...mockWorkloadRatio,
          context: {
            ...mockWorkloadRatio.context,
            recentDays: 5,
            baselineDays: 20,
          },
        }}
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
    expect(screen.getByText("Recent 5-day load")).toBeTruthy();
    expect(screen.getByText("20-day baseline load")).toBeTruthy();
    expect(screen.getByText("Recent-to-baseline workload ratio")).toBeTruthy();
    expect(
      screen.getByText(
        "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days. This is descriptive context, not a safe range or an injury prediction.",
      ),
    ).toBeTruthy();
  });

  it("explains current strain from today's load separately from rolling training load", () => {
    const mockStrainTarget = {
      targetStrain: 12,
      currentStrain: 0,
      progressPercent: 0,
      zone: "Maintain" as const,
      explanation: "Moderate recovery (50). Aim for a steady training day.",
      dailyLoad: 0,
      acuteLoad: 133,
      chronicLoad: 33,
      workloadRatio: 4,
      readinessScore: 50,
    };

    render(
      <DailyOverview
        readiness={mockReadiness}
        workloadRatio={{
          context: {
            label: "Recent-to-baseline workload ratio",
            description:
              "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days. This is descriptive context, not a safe range or an injury prediction.",
            recentDays: 7,
            baselineDays: 28,
          },
          displayedStrain: 0,
          displayedDate: today,
          timeSeries: [
            {
              date: today,
              dailyLoad: 0,
              strain: 0,
              acuteLoad: 133,
              chronicLoad: 33,
              workloadRatio: 4,
            },
          ],
        }}
        sleepPerformance={mockSleepPerformance}
        strainTarget={mockStrainTarget}
        readinessLoading={false}
        workloadLoading={false}
        sleepLoading={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Strain score breakdown" }));

    expect(screen.getByText("Recent-to-baseline workload ratio")).toBeTruthy();
    expect(screen.getByText("4.00")).toBeTruthy();
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
    const yesterdayStr = formatDateYmd(yesterday);

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
          context: {
            label: "Recent-to-baseline workload ratio",
            description:
              "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days. This is descriptive context, not a safe range or an injury prediction.",
            recentDays: 7,
            baselineDays: 28,
          },
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
          providerId: "whoop",
          sourceName: null,
          sourceProviders: ["whoop"],
          summaryDateContext: {
            effectiveDate: today,
            timezone: "America/Los_Angeles",
          },
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

  it("uses the dashboard query date to decide whether recovery data is fresh", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T10:00:00"));

    render(
      <DailyOverview
        endDate="2026-03-21"
        readiness={[
          {
            date: "2026-03-20",
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
          context: {
            label: "Recent-to-baseline workload ratio",
            description:
              "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days. This is descriptive context, not a safe range or an injury prediction.",
            recentDays: 7,
            baselineDays: 28,
          },
          displayedStrain: 12.5,
          displayedDate: "2026-03-20",
          timeSeries: [
            {
              date: "2026-03-20",
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

    expect(screen.getByText("75")).toBeTruthy();
    expect(screen.getByText("Recovered")).toBeTruthy();
  });

  it("shows placeholder when readiness data is 2+ days old", () => {
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const twoDaysAgoStr = formatDateYmd(twoDaysAgo);

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
          context: {
            label: "Recent-to-baseline workload ratio",
            description:
              "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days. This is descriptive context, not a safe range or an injury prediction.",
            recentDays: 7,
            baselineDays: 28,
          },
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
