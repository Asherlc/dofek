// @vitest-environment jsdom

import { climbingBestOnsightFixture } from "@dofek/training/fixtures/climbing-best-onsight";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { Alert } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultMockTrainingData,
  noPolarizationWeeks,
  recentCyclingActivityFixture,
  sectionExpectations,
} from "../../app-fixtures/(tabs)/strain-test-helpers";
import { demonstratedGradeFixture } from "../../components/climbing-demonstrated-grade-fixture";
import { climbingProgressionFixture } from "../../components/climbing-progression-test-helpers";
import { routeComparisonFixture } from "../../components/route-comparison-fixtures";
import { intervalRun, runningData } from "../../components/running-training-test-helpers";
import { trainingSections } from "../../lib/training-sections";
import {
  mockAttemptIncreaseQuery,
  mockBestOnsightInvalidate,
  mockBestOnsightQuery,
  mockBestOnsightRefetch,
  mockCaptureException,
  mockCyclingPowerProfileQuery,
  mockDecouplingInvalidate,
  mockDecouplingQuery,
  mockDemonstratedGradeInvalidate,
  mockDemonstratedGradeQuery,
  mockHrZonesInvalidate,
  mockHrZonesState,
  mockLocationMapInvalidate,
  mockPolarizationInvalidate,
  mockPolarizationState,
  mockProcessingStatusInvalidate,
  mockQueryState,
  mockRouteComparisonInvalidate,
  mockRouteComparisonQuery,
  mockRouterPush,
  mockRunningInvalidate,
  mockStrengthsState,
  mockTrainingInvalidate,
  mockTrainingState,
  mockVolumeIncreaseQuery,
  resetStrainMocks,
} from "./strain-test-helpers";

describe("StrainScreen", () => {
  it("requests the power profile for the selected Cycling range", async () => {
    mockQueryState.timeRangePreference.days = 30;
    const { TrainingAnalysis } = await import("../../app/strain");
    render(<TrainingAnalysis section="cycling" isFocused />);
    expect(mockCyclingPowerProfileQuery).toHaveBeenLastCalledWith(
      { days: 30 },
      expect.objectContaining({ enabled: true }),
    );
    expect(screen.getByText("Cycling power profile")).toBeTruthy();
  });
  it("shows an explicit error when the power profile response is malformed", async () => {
    mockCyclingPowerProfileQuery.mockReturnValue({
      data: { range: "invalid" },
      isLoading: false,
      error: null,
    });
    const { TrainingAnalysis } = await import("../../app/strain");
    render(<TrainingAnalysis section="cycling" isFocused />);
    expect(screen.getByTestId("query-state-error")).toBeTruthy();
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Cycling power profile: Zod parse failed"),
      }),
      expect.objectContaining({ context: "Cycling power profile" }),
    );
  });
  it("requests current running response for the selected range", async () => {
    mockQueryState.timeRangePreference.days = 30;
    const { default: StrainScreen } = await import("../../app/strain");
    render(<StrainScreen />);
    expect(mockQueryState.rangeQueryCalls.running.at(-1)?.input).toEqual({
      days: 30,
      responseVersion: 2,
    });
  });
  it("reports malformed restored running data once and shows the actionable error", async () => {
    mockQueryState.runningData = { data: runningData.data, availability: runningData.availability };
    const { default: StrainScreen } = await import("../../app/strain");
    const view = render(<StrainScreen />);
    expect(
      screen.getByText(
        "Running data has an unexpected format. Refresh and try again. If it continues, contact support.",
      ),
    ).toBeTruthy();
    expect(mockCaptureException).toHaveBeenCalledOnce();
    view.rerender(<StrainScreen />);
    expect(mockCaptureException).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText("Running cadence trend, steps per minute")).toBeNull();
  });
  it("preserves valid stale running rows and exact refetch error", async () => {
    mockQueryState.runningData = runningData;
    mockQueryState.runningLoading = true;
    mockQueryState.runningError = new Error("Running sync is still processing. Try again shortly.");
    const { default: StrainScreen } = await import("../../app/strain");
    render(<StrainScreen />);
    expect(screen.getByText(mockQueryState.runningError.message)).toBeTruthy();
    expect(screen.getByLabelText("Running cadence trend, steps per minute")).toBeTruthy();
    expect(screen.queryByText("Running Form")).toBeNull();
  });
  it("shows the running cadence trend on the training screen", async () => {
    mockQueryState.runningData = { ...runningData, data: [intervalRun] };
    const { default: StrainScreen } = await import("../../app/strain");
    render(<StrainScreen />);
    expect(screen.getByLabelText("Running cadence trend, steps per minute")).toBeTruthy();
    expect(screen.queryByText("Running Form")).toBeNull();
  });

  beforeEach(resetStrainMocks);

  it.each(trainingSections.map(({ id }) => [id, sectionExpectations[id]] as const))(
    "shows only the training panels and enables only the queries for %s",
    async (section, { queries, cards }) => {
      mockPolarizationState.data = noPolarizationWeeks;
      const unrelatedError = new Error("Unrelated data failed");
      if (section === "endurance") {
        mockQueryState.runningError = unrelatedError;
      } else {
        Object.assign(mockHrZonesState, { isError: true, error: unrelatedError });
      }
      const { TrainingAnalysis } = await import("../../app/strain");
      render(<TrainingAnalysis section={section} isFocused />);

      const enabled = Object.entries(mockQueryState.rangeQueryCalls)
        .filter(([, calls]) => calls.at(-1)?.options.enabled)
        .map(([name]) => name);
      expect(enabled.sort()).toEqual([...queries].sort());
      expect(mockVolumeIncreaseQuery.mock.lastCall?.[1]?.enabled).toBe(section === "climbing");
      expect(mockAttemptIncreaseQuery.mock.lastCall?.[1]?.enabled).toBe(section === "climbing");
      expect(mockBestOnsightQuery.mock.lastCall?.[1]?.enabled).toBe(section === "climbing");
      if (section === "hiking") {
        expect(mockRouteComparisonQuery).toHaveBeenCalledWith(
          { days: 90 },
          expect.objectContaining({ enabled: true }),
        );
      } else {
        expect(mockRouteComparisonQuery).not.toHaveBeenCalled();
      }
      const allCards = new Set(Object.values(sectionExpectations).flatMap((entry) => entry.cards));
      for (const card of allCards) {
        expect(screen.queryAllByText(card).length > 0, card).toBe(cards.includes(card));
      }
      expect(screen.queryByText(unrelatedError.message)).toBeNull();
    },
  );

  it("does not consume cached default-range data during preference hydration", async () => {
    mockQueryState.timeRangePreference.isHydrated = false;

    const { default: StrainScreen } = await import("../../app/strain");
    const view = render(<StrainScreen />);

    const { durability, sportVolume, ...rangeQueries } = mockQueryState.rangeQueryCalls;
    expect(durability).toHaveLength(0);
    expect(sportVolume).toHaveLength(0);
    for (const calls of Object.values(rangeQueries)) {
      expect(calls.at(-1)?.options.enabled).toBe(false);
    }
    expect(screen.queryByText("16.0")).toBeNull();

    mockQueryState.timeRangePreference.days = 30;
    mockQueryState.timeRangePreference.isHydrated = true;
    view.rerender(<StrainScreen />);

    expect(sportVolume.at(-1)?.input.days).toBe(30);
    expect(sportVolume.at(-1)?.options.enabled).toBe(true);
    for (const calls of Object.values(rangeQueries)) {
      expect(calls.at(-1)?.input.days).toBe(30);
      expect(calls.at(-1)?.options.enabled).toBe(true);
      expect(calls.at(-1)?.options.placeholderData).toBeUndefined();
    }
    expect(screen.queryByText("16.0")).toBeNull();

    mockQueryState.trainingDataDays = 30;
    view.rerender(<StrainScreen />);
    mockQueryState.timeRangePreference.days = 90;
    view.rerender(<StrainScreen />);

    for (const calls of [sportVolume, ...Object.values(rangeQueries)]) {
      expect(calls.at(-1)?.options.placeholderData).toBeTypeOf("function");
    }
  });

  it("toggles area metadata and polls pending enrichment without losing previous data", async () => {
    const { default: StrainScreen } = await import("../../app/strain");
    render(<StrainScreen />);
    expect(mockQueryState.rangeQueryCalls.strengths.at(-1)?.input).toMatchObject({
      includeAreaMetadata: true,
      responseVersion: 2,
    });
    fireEvent.click(screen.getByRole("switch", { name: "Include area metadata" }));
    expect(mockQueryState.rangeQueryCalls.strengths.at(-1)?.input).toMatchObject({
      includeAreaMetadata: false,
      responseVersion: 2,
    });
    const options = mockQueryState.rangeQueryCalls.strengths.at(-1)?.options;
    expect(options?.refetchInterval?.({ state: { data: { enrichmentPending: true } } })).toBe(1500);
    expect(options?.refetchInterval?.({ state: { data: { enrichmentPending: false } } })).toBe(
      false,
    );
  });
  it("offers all time for strengths without changing the other training ranges", async () => {
    const { default: StrainScreen } = await import("../../app/strain");
    render(<StrainScreen />);
    fireEvent.click(screen.getByRole("radio", { name: "All time" }));
    expect(mockQueryState.rangeQueryCalls.strengths.at(-1)?.input).toEqual({
      days: null,
      endDate: "2026-03-28",
      includeAreaMetadata: true,
      responseVersion: 2,
    });
    expect(mockQueryState.rangeQueryCalls.training.at(-1)?.input.days).toBe(90);
    fireEvent.click(screen.getByRole("radio", { name: "90 days" }));
    expect(mockQueryState.rangeQueryCalls.strengths.at(-1)?.input.days).toBe(90);
  });
  it("updates the strengths query anchor at local midnight and retains explicit date anchors", async () => {
    const { default: StrainScreen } = await import("../../app/strain");
    const { rerender } = render(<StrainScreen />);
    expect(mockQueryState.rangeQueryCalls.strengths.at(-1)?.input).toEqual({
      days: 90,
      endDate: "2026-03-28",
      includeAreaMetadata: true,
      responseVersion: 2,
    });
    mockQueryState.todayQueryDate = "2026-03-29";
    rerender(<StrainScreen />);
    expect(mockQueryState.rangeQueryCalls.strengths.at(-1)?.input).toEqual({
      days: 90,
      endDate: "2026-03-29",
      includeAreaMetadata: true,
      responseVersion: 2,
    });
    mockQueryState.todayQueryDate = "2025-12-31";
    rerender(<StrainScreen />);
    expect(mockQueryState.rangeQueryCalls.strengths.at(-1)?.input).toEqual({
      days: 90,
      endDate: "2025-12-31",
      includeAreaMetadata: true,
      responseVersion: 2,
    });
  });

  it("shows transient climbing refresh progress only while fetching, leaving no idle gap", async () => {
    mockStrengthsState.isFetching = false;
    const { default: StrainScreen } = await import("../../app/strain");
    const { rerender } = render(<StrainScreen />);
    expect(screen.queryByTestId("climbing-refresh-status")).toBeNull();
    expect(screen.getByRole("button", { name: /^Slab: Sent 2 of 7 climbs/ })).toBeTruthy();

    mockStrengthsState.isFetching = true;
    rerender(<StrainScreen />);
    const status = screen.getByTestId("climbing-refresh-status");
    expect(status.textContent).toBe("Updating climbing strengths…");
    expect(status.getAttribute("accessibilityliveregion")).toBe("polite");
    expect(screen.getByText("Climbing strengths").nextElementSibling).toBe(status);
    expect(screen.getByRole("button", { name: /^Slab: Sent 2 of 7 climbs/ })).toBeTruthy();

    mockStrengthsState.isFetching = false;
    rerender(<StrainScreen />);
    expect(screen.queryByTestId("climbing-refresh-status")).toBeNull();
  });

  it("keeps cached strengths visible with an updating indicator while a new population loads", async () => {
    mockStrengthsState.isFetching = true;
    const { default: StrainScreen } = await import("../../app/strain");
    render(<StrainScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Filters ⌄" }));
    fireEvent.click(screen.getByRole("button", { name: "More filters" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "All climbing" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Lead" }));
    expect(screen.getByText("Updating climbing strengths…")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Slab: Sent 2 of 7 climbs/ })).toBeTruthy();
    expect(mockQueryState.rangeQueryCalls.strengths.at(-1)?.input).toEqual({
      days: 90,
      endDate: "2026-03-28",
      includeAreaMetadata: true,
      responseVersion: 2,
      types: ["lead"],
    });
  });

  it("rejects malformed restored strengths with a visible error and reports it once per payload", async () => {
    mockStrengthsState.data = { panels: [{}] };
    const { default: StrainScreen } = await import("../../app/strain");
    const { rerender } = render(<StrainScreen />);
    expect(
      screen.getByText("Climbing strengths data could not be read. Pull to refresh to reload it."),
    ).toBeTruthy();
    expect(mockCaptureException).toHaveBeenCalledOnce();
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Climbing strengths: Zod parse failed"),
      }),
      expect.objectContaining({ context: "Climbing strengths" }),
    );
    rerender(<StrainScreen />);
    expect(mockCaptureException).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: /^Slab:/ })).toBeNull();
  });

  it("sends climbing selections to the server while keeping other training queries unchanged", async () => {
    const { default: StrainScreen } = await import("../../app/strain");
    render(<StrainScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Filters ⌄" }));
    fireEvent.click(screen.getByRole("button", { name: "More filters" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "All climbing" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Lead" }));
    expect(mockQueryState.rangeQueryCalls.training.at(-1)?.input).toMatchObject({
      climbingFilters: { types: ["lead"] },
    });
    expect(mockQueryState.rangeQueryCalls.locationMap.at(-1)?.input).toEqual({
      days: 90,
      types: ["lead"],
    });
    expect(mockQueryState.rangeQueryCalls.locationMap.at(-1)?.options.placeholderData).toBeTypeOf(
      "function",
    );
    expect(mockQueryState.rangeQueryCalls.strengths.at(-1)?.input).toEqual({
      days: 90,
      endDate: "2026-03-28",
      includeAreaMetadata: true,
      responseVersion: 2,
      types: ["lead"],
    });
    expect(screen.getByRole("button", { name: /^Slab: Sent 2 of 7 climbs/ })).toBeTruthy();
    expect(screen.getByText("Climbing strengths")).toBeTruthy();
    expect(screen.getByText("Climbing locations")).toBeTruthy();
  });

  it("anchors demonstrated grade to the shared date and filters, not the chart range", async () => {
    const { default: StrainScreen } = await import("../../app/strain");
    render(<StrainScreen />);
    expect(mockDemonstratedGradeQuery).toHaveBeenLastCalledWith(
      { endDate: "2026-03-28", filters: {} },
      expect.any(Object),
    );

    mockQueryState.timeRangePreference.days = 30;
    fireEvent.click(screen.getByRole("button", { name: "Filters ⌄" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "All climbing" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Lead" }));
    expect(mockDemonstratedGradeQuery).toHaveBeenLastCalledWith(
      { endDate: "2026-03-28", filters: { types: ["lead"] } },
      expect.any(Object),
    );
    expect(mockQueryState.rangeQueryCalls.training.at(-1)?.input.days).toBe(30);
  });

  it("shows demonstrated grade when trainingV2 fails without cached climbing data", async () => {
    mockTrainingState.data = undefined;
    mockTrainingState.isError = true;
    mockTrainingState.error = new Error("Training unavailable");
    mockDemonstratedGradeQuery.mockReturnValue({
      data: demonstratedGradeFixture,
      isLoading: false,
      isFetching: false,
      error: null,
    });
    const { default: StrainScreen } = await import("../../app/strain");
    render(<StrainScreen />);

    expect(screen.getByRole("button", { name: "Indoor bouldering, V5, 3 climbs" })).toBeTruthy();
    expect(screen.queryByRole("image", { name: /^Grade progression/ })).toBeNull();
    expect(screen.getByText("Could not load training data")).toBeTruthy();
  });

  it("refreshes training, intensity, polarization, and processing status together", async () => {
    const { default: StrainScreen } = await import("../../app/strain");
    render(<StrainScreen />);

    expect(mockQueryState.refreshInvalidate).toBeTypeOf("function");
    await mockQueryState.refreshInvalidate?.();

    expect(mockDecouplingInvalidate).toHaveBeenCalled();
    expect(mockTrainingInvalidate).toHaveBeenCalledOnce();
    expect(mockLocationMapInvalidate).toHaveBeenCalledOnce();
    expect(mockDemonstratedGradeInvalidate).toHaveBeenCalledOnce();
    expect(mockHrZonesInvalidate).toHaveBeenCalledOnce();
    expect(mockPolarizationInvalidate).toHaveBeenCalledOnce();
    expect(mockProcessingStatusInvalidate).toHaveBeenCalledOnce();
    expect(mockRouteComparisonInvalidate).toHaveBeenCalledOnce();
    expect(mockRunningInvalidate).toHaveBeenCalledOnce();
    expect(mockBestOnsightInvalidate).toHaveBeenCalledOnce();
  });

  it("renders the route comparison with the selected training period and opens attempts", async () => {
    mockRouteComparisonQuery.mockReturnValue({
      data: routeComparisonFixture,
      isLoading: false,
      isFetching: false,
      error: null,
    });
    mockQueryState.timeRangePreference.days = 30;
    const { default: StrainScreen } = await import("../../app/strain");
    render(<StrainScreen />);
    expect(screen.getByText("Route comparison")).toBeTruthy();
    expect(mockRouteComparisonQuery.mock.calls.at(-1)?.[0]).toEqual({ days: 30 });
    expect(mockRouteComparisonQuery.mock.calls.at(-1)?.[1].enabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "View Route comparison data" }));
    fireEvent.click(screen.getByRole("button", { name: /Morning river run:/ }));
    expect(mockRouterPush).toHaveBeenCalledWith("/activity/22222222-2222-4222-8222-222222222222");
  });

  it("renders model labels, values, and calculation details", async () => {
    mockHrZonesState.data = {
      maxHr: 190,
      weeks: [],
      intensityDistribution: {
        model: "karvonen-five-zone",
        activityScope: "endurance",
        totalSeconds: 3600,
        zones: [{ zone: 2, label: "Aerobic", seconds: 3600, percent: 100 }],
        explanation: "Mobile descriptive intensity explanation.",
      },
    };
    mockPolarizationState.data = {
      model: "treff-three-zone",
      activityScope: "cycling",
      threshold: 2,
      maxHr: 190,
      explanation: "Mobile cycling polarization explanation.",
      method: {
        formula: "Mobile Treff formula.",
        zoneBasis: "Mobile Treff zones.",
        calculationChoice: "Mobile calculation choice.",
        interpretation: "Mobile descriptive PI interpretation.",
        source: {
          title: "Treff source",
          url: "https://doi.org/10.3389/fphys.2019.00707",
        },
      },
      weeks: [
        {
          week: "2026-07-20",
          z1Seconds: 4800,
          z2Seconds: 600,
          z3Seconds: 600,
          polarizationIndex: 2,
          totalSeconds: 6000,
          zonePercentages: { z1: 80, z2: 10, z3: 10 },
          status: "not_polarized",
          statusLabel: "Not polarized",
          explanation: "Server says exactly 2.00 is not polarized.",
        },
      ],
    };

    const { default: StrainScreen } = await import("../../app/strain");
    const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
    render(<StrainScreen />);

    expect(screen.getByText("Heart-rate zone distribution")).toBeTruthy();
    expect(screen.getByText("Not polarized")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: "About How this is calculated for Easy-to-hard training balance",
      }),
    );
    expect(alertSpy).toHaveBeenCalledWith(
      "How this is calculated for Easy-to-hard training balance",
      expect.stringContaining("Mobile Treff formula."),
      [{ text: "Close" }],
    );
    alertSpy.mockRestore();
  });

  it("renders intensity and polarization query failures separately", async () => {
    mockHrZonesState.isError = true;
    mockHrZonesState.error = new Error("Intensity distribution failed");
    mockPolarizationState.isError = true;
    mockPolarizationState.error = new Error("Cycling polarization failed");

    const { default: StrainScreen } = await import("../../app/strain");
    render(<StrainScreen />);

    expect(screen.getByText("Intensity distribution failed")).toBeTruthy();
    expect(screen.getByText("Cycling polarization failed")).toBeTruthy();
    expect(screen.getByText("Could not load easy-to-hard training balance")).toBeTruthy();
    expect(mockCaptureException).toHaveBeenCalledWith(mockHrZonesState.error);
    expect(mockCaptureException).toHaveBeenCalledWith(mockPolarizationState.error);
  });

  it("does not report transient or cancelled training query errors", async () => {
    mockHrZonesState.isError = true;
    mockHrZonesState.error = new Error("User canceled");
    mockPolarizationState.isError = true;
    mockPolarizationState.error = new Error("User cancelled");

    const { default: StrainScreen } = await import("../../app/strain");
    render(<StrainScreen />);

    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("keeps cached server models visible with background query failures", async () => {
    mockHrZonesState.data = {
      maxHr: 190,
      weeks: [],
      intensityDistribution: {
        model: "karvonen-five-zone",
        activityScope: "endurance",
        totalSeconds: 3600,
        zones: [{ zone: 2, label: "Aerobic", seconds: 3600, percent: 100 }],
        explanation: "Cached mobile intensity distribution.",
      },
    };
    mockHrZonesState.isError = true;
    mockHrZonesState.error = new Error("Intensity refresh failed");
    mockPolarizationState.data = noPolarizationWeeks;
    mockPolarizationState.isError = true;
    mockPolarizationState.error = new Error("Polarization refresh failed");

    const { default: StrainScreen } = await import("../../app/strain");
    render(<StrainScreen />);

    expect(screen.getByText("Intensity refresh failed")).toBeTruthy();
    expect(screen.getByText("Polarization refresh failed")).toBeTruthy();
    expect(screen.getByText("No easy-to-hard training balance data in this period")).toBeTruthy();
  });

  it("keeps day selector visible while training data is loading", async () => {
    mockTrainingState.isLoading = true;
    mockTrainingState.data = undefined;

    const { default: StrainScreen } = await import("../../app/strain");
    render(<StrainScreen />);

    expect(screen.getByText("30d")).toBeTruthy();
    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    expect(screen.queryByText("Loading strain data...")).toBeNull();
  });

  it("does not report response parse errors before training data loads", async () => {
    mockTrainingState.isLoading = true;
    mockTrainingState.data = undefined;

    const { default: StrainScreen } = await import("../../app/strain");
    render(<StrainScreen />);

    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("keeps cached training data visible while refreshing", async () => {
    mockTrainingState.isLoading = true;
    mockTrainingState.isFetching = true;
    mockTrainingState.data = {
      ...defaultMockTrainingData(),
      activities: [recentCyclingActivityFixture()],
    };

    const { default: StrainScreen } = await import("../../app/strain");
    render(<StrainScreen />);

    expect(screen.queryByTestId("query-state-loading")).toBeNull();
    expect(screen.getByText("Training Load")).toBeTruthy();
    expect(screen.getByText("27")).toBeTruthy();
  });

  it("shows the neutral server-owned workload comparison", async () => {
    mockTrainingState.data = {
      workloadRatio: {
        context: {
          label: "Recent-to-baseline workload ratio",
          description:
            "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days.",
          recentDays: 5,
          baselineDays: 20,
        },
        displayedDate: "2026-03-28",
        timeSeries: [
          {
            date: "2026-03-28",
            dailyLoad: 0,
            acuteLoad: 133,
            chronicLoad: 33,
            workloadRatio: 4,
          },
        ],
      },
      activities: [],
      weeklyVolume: [],
      verticalAscent: [],
    };

    const { default: StrainScreen } = await import("../../app/strain");
    render(<StrainScreen />);

    expect(screen.getByText("Recent-to-baseline workload ratio")).toBeTruthy();
    expect(screen.getByText("Recent 5-day load")).toBeTruthy();
    expect(screen.getByText("20-day baseline load")).toBeTruthy();
    expect(
      screen.getByText(
        "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("4.00")).toBeTruthy();
  });

  it("constrains training load metrics to equal columns with centered wrapping labels", async () => {
    const { default: StrainScreen } = await import("../../app/strain");
    render(<StrainScreen />);

    for (const label of [
      "Recent 7-day load",
      "28-day baseline load",
      "Recent-to-baseline workload ratio",
    ]) {
      const labelElement = screen.getByText(label);

      expect(labelElement.parentElement?.style.flex).toBe("1 1 0%");
      expect(labelElement.style.textAlign).toBe("center");
    }
  });

  it("preserves cached Hangboarding data during a failed training refresh", async () => {
    mockTrainingState.data = defaultMockTrainingData();
    mockTrainingState.isError = true;
    mockTrainingState.error = new Error("Training refresh failed");

    const { default: StrainScreen } = await import("../../app/strain");
    render(<StrainScreen />);

    expect(screen.getByText("No Hangboarding sessions to display.")).toBeTruthy();
    expect(screen.queryByText("Training refresh failed")).toBeNull();
  });

  it("renders server-authored exercise trend evidence", async () => {
    mockTrainingState.data = {
      ...defaultMockTrainingData(),
      progressiveOverload: [
        {
          exerciseName: "Back Squat",
          equipment: "BARBELL",
          observations: [
            { week: "2026-03-09", totalVolumeKg: 1_000 },
            { week: "2026-03-23", totalVolumeKg: 1_200 },
          ],
          period: {
            startWeek: "2026-03-09",
            endWeek: "2026-03-23",
            observationCount: 2,
            elapsedWeekCount: 3,
          },
          slopeKgPerWeek: 100,
          trend: "increasing",
          uncertainty: {
            availability: "unavailable",
            level: 0.95,
            method: "residual_circular_moving_block_bootstrap",
            methodLabel: "95% moving-block interval",
            reason: "insufficient_observations",
            statement: "Uncertainty needs at least 4 recorded weeks; this estimate has 2.",
          },
          interpretation: "Recorded weekly volume increased over this period.",
          deloadContext:
            "Recorded volume cannot distinguish a planned deload from missed training or incomplete data.",
        },
      ],
    };

    const { default: StrainScreen } = await import("../../app/strain");
    render(<StrainScreen />);

    expect(screen.getByText("Back Squat")).toBeTruthy();
    expect(screen.getByText("Increasing 100.0 kg/week")).toBeTruthy();
  });

  it("shows one server error notice for a failed composite training query", async () => {
    mockTrainingState.data = undefined;
    mockTrainingState.isError = true;
    mockTrainingState.error = new Error("Training data failed to load");

    const { default: StrainScreen } = await import("../../app/strain");
    render(<StrainScreen />);

    expect(screen.getAllByText("Training data failed to load")).toHaveLength(1);
    expect(screen.getAllByTestId("query-state-error")).toHaveLength(1);
    expect(screen.queryByText("Training Load")).toBeNull();
    expect(screen.queryByRole("image", { name: /^Grade progression/ })).toBeNull();
    expect(screen.getByText("Weekly Volume")).toBeTruthy();
    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error));
  });

  it("keeps successful companion analytics visible beside a training query failure", async () => {
    mockTrainingState.data = undefined;
    mockTrainingState.isError = true;
    mockTrainingState.error = new Error("Training data failed to load");
    mockHrZonesState.data = {
      maxHr: 190,
      weeks: [],
      intensityDistribution: {
        model: "karvonen-five-zone",
        activityScope: "endurance",
        totalSeconds: 3600,
        zones: [{ zone: 2, label: "Aerobic", seconds: 3600, percent: 100 }],
        explanation: "Independent intensity data remains available.",
      },
    };

    const { default: StrainScreen } = await import("../../app/strain");
    render(<StrainScreen />);

    expect(screen.getAllByText("Training data failed to load")).toHaveLength(1);
    expect(
      screen
        .getByRole("button", {
          name: "About How this is calculated for Heart-rate zone distribution",
        })
        .getAttribute("aria-description"),
    ).toContain("Karvonen");
  });

  it("keeps equal messages separate when training and companion queries both fail", async () => {
    mockTrainingState.data = undefined;
    mockTrainingState.isError = true;
    mockTrainingState.error = new Error("Training analytics unavailable");
    mockHrZonesState.isError = true;
    mockHrZonesState.error = new Error("Training analytics unavailable");

    const { default: StrainScreen } = await import("../../app/strain");
    render(<StrainScreen />);

    expect(screen.getAllByText("Training analytics unavailable")).toHaveLength(2);
    expect(screen.getAllByTestId("query-state-error")).toHaveLength(2);
  });

  it("keeps cached climbing data visible during background refetch failures", async () => {
    mockStrengthsState.data = undefined;
    mockTrainingState.data = {
      ...defaultMockTrainingData(),
      climbing: {
        gradeProgression: climbingProgressionFixture(),
        volumeByGrade: [],
        sessionSummary: [],
      },
    };
    mockTrainingState.isError = true;
    mockTrainingState.error = new Error("Climbing refresh failed");

    const { default: StrainScreen } = await import("../../app/strain");
    render(<StrainScreen />);

    expect(screen.queryByText("Climbing refresh failed")).toBeNull();
    expect(screen.getAllByText("Bouldering")[0]).toBeTruthy();
    expect(screen.getByText("V4")).toBeTruthy();
  });

  it("reports the same cached training query error only once across remounts", async () => {
    const cachedError = new Error("Cached climbing data failed to load");
    mockTrainingState.data = undefined;
    mockTrainingState.isError = true;
    mockTrainingState.error = cachedError;

    const { default: StrainScreen } = await import("../../app/strain");
    const firstRender = render(<StrainScreen />);
    firstRender.unmount();
    render(<StrainScreen />);

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledWith(cachedError);
  });

  it("queries the annual onsight result independently of filters and the selected period", async () => {
    const { default: StrainScreen } = await import("../../app/strain");
    const view = render(<StrainScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Filters ⌄" }));
    fireEvent.click(screen.getByRole("button", { name: "More filters" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "All climbing" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Lead" }));
    mockQueryState.timeRangePreference.days = 30;
    view.rerender(<StrainScreen />);

    expect(mockBestOnsightQuery.mock.calls.length).toBeGreaterThan(0);
    expect(mockBestOnsightQuery.mock.calls.every(([input]) => input === undefined)).toBe(true);
    expect(mockBestOnsightQuery.mock.lastCall?.[1]?.enabled).toBe(true);
    expect(mockQueryState.rangeQueryCalls.training.at(-1)?.input).toMatchObject({
      days: 30,
      climbingFilters: { types: ["lead"] },
    });
  });

  it("refetches only the annual onsight result when the query date advances at midnight", async () => {
    const { default: StrainScreen } = await import("../../app/strain");
    const view = render(<StrainScreen />);

    expect(mockBestOnsightRefetch).not.toHaveBeenCalled();
    view.rerender(<StrainScreen />);
    expect(mockBestOnsightRefetch).not.toHaveBeenCalled();

    mockQueryState.todayQueryDate = "2026-03-29";
    view.rerender(<StrainScreen />);

    expect(mockBestOnsightRefetch).toHaveBeenCalledTimes(1);
    expect(mockBestOnsightQuery.mock.calls.every(([input]) => input === undefined)).toBe(true);
    expect(mockBestOnsightQuery.mock.lastCall?.[1]?.enabled).toBe(true);
  });

  it("skips the midnight annual refetch while the iOS query is disabled", async () => {
    mockQueryState.focused = false;
    const { default: StrainScreen } = await import("../../app/strain");
    const view = render(<StrainScreen />);

    expect(mockBestOnsightQuery.mock.lastCall?.[1]?.enabled).toBe(false);
    mockQueryState.todayQueryDate = "2026-03-29";
    view.rerender(<StrainScreen />);
    expect(mockBestOnsightRefetch).not.toHaveBeenCalled();

    mockQueryState.focused = true;
    view.rerender(<StrainScreen />);
    expect(mockBestOnsightRefetch).not.toHaveBeenCalled();
  });

  it("opens the selected onsight send in the existing viewer and closes back to the matrix", async () => {
    mockBestOnsightQuery.mockReturnValue({
      data: climbingBestOnsightFixture(),
      isLoading: false,
      error: null,
    });
    const { default: StrainScreen } = await import("../../app/strain");
    render(<StrainScreen />);

    expect(screen.getByText("Best recorded onsight")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Climb detail" })).toBeNull();

    fireEvent.click(screen.getByLabelText("5.11a, open Gym Lead send"));

    const dialog = screen.getByRole("dialog", { name: "Climb detail" });
    expect(within(dialog).getByTestId("record-detail-input").textContent).toBe(
      JSON.stringify({
        providerId: "kaya",
        dataType: "climbingLogEntries",
        recordId: "44444444-4444-4444-8444-000000000003",
      }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Close detail" }));
    expect(screen.queryByRole("dialog", { name: "Climb detail" })).toBeNull();
    expect(screen.getByLabelText("5.11a, open Gym Lead send")).toBeTruthy();
  });

  it("keeps both independent insights exactly once when trainingV2 fails without cache", async () => {
    mockTrainingState.data = undefined;
    mockTrainingState.isError = true;
    mockTrainingState.error = new Error("Training data failed to load");
    mockBestOnsightQuery.mockReturnValue({
      data: climbingBestOnsightFixture(),
      isLoading: false,
      error: null,
    });
    mockDemonstratedGradeQuery.mockReturnValue({
      data: demonstratedGradeFixture,
      isLoading: false,
      isFetching: false,
      error: null,
    });

    const { default: StrainScreen } = await import("../../app/strain");
    render(<StrainScreen />);

    expect(screen.getAllByText("Training data failed to load")).toHaveLength(1);
    expect(screen.getAllByText("Best recorded onsight")).toHaveLength(1);
    expect(screen.getByLabelText("5.11a, open Gym Lead send")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Indoor bouldering, V5, 3 climbs" })).toHaveLength(
      1,
    );
    expect(screen.queryByRole("image", { name: /^Grade progression/ })).toBeNull();
    expect(screen.queryByText("Volume by Grade")).toBeNull();
  });

  it("shows the standalone annual loading state once when trainingV2 fails without cache", async () => {
    mockTrainingState.data = undefined;
    mockTrainingState.isError = true;
    mockTrainingState.error = new Error("Training data failed to load");
    mockBestOnsightQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });

    const { TrainingAnalysis } = await import("../../app/strain");
    render(<TrainingAnalysis section="climbing" isFocused />);

    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    expect(screen.queryByText("Volume by Grade")).toBeNull();
  });

  it("shows the standalone annual error once when trainingV2 fails without cache", async () => {
    mockTrainingState.data = undefined;
    mockTrainingState.isError = true;
    mockTrainingState.error = new Error("Training data failed to load");
    mockBestOnsightQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("Annual onsights unavailable"),
    });

    const { TrainingAnalysis } = await import("../../app/strain");
    render(<TrainingAnalysis section="climbing" isFocused />);

    expect(screen.getByText("Annual onsights unavailable")).toBeTruthy();
    expect(screen.queryByText("Volume by Grade")).toBeNull();
  });

  it("keeps the open onsight detail when training finishes loading", async () => {
    mockTrainingState.data = undefined;
    mockTrainingState.isLoading = true;
    mockBestOnsightQuery.mockReturnValue({
      data: climbingBestOnsightFixture(),
      isLoading: false,
      error: null,
    });

    const { TrainingAnalysis } = await import("../../app/strain");
    const view = render(<TrainingAnalysis section="climbing" isFocused />);

    expect(screen.getAllByText("Best recorded onsight")).toHaveLength(1);
    expect(screen.getByLabelText("5.11a, open Gym Lead send")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("5.11a, open Gym Lead send"));
    const dialog = screen.getByRole("dialog", { name: "Climb detail" });
    const detailBefore = within(dialog).getByTestId("record-detail-input").textContent;
    mockTrainingState.data = structuredClone(defaultMockTrainingData());
    mockTrainingState.isLoading = false;
    view.rerender(<TrainingAnalysis section="climbing" isFocused />);
    expect(
      within(screen.getByRole("dialog", { name: "Climb detail" })).getByTestId(
        "record-detail-input",
      ).textContent,
    ).toBe(detailBefore);
    expect(screen.getAllByText("Best recorded onsight")).toHaveLength(1);
    expect(screen.getByText("Volume by Grade")).toBeTruthy();
  });
});

it("requests decoupling for the selected Cycling range and shows the empty state", async () => {
  mockQueryState.timeRangePreference.days = 30;
  const { TrainingAnalysis } = await import("../../app/strain");
  render(<TrainingAnalysis section="cycling" isFocused />);
  expect(mockDecouplingQuery).toHaveBeenLastCalledWith(
    { days: 30 },
    expect.objectContaining({ enabled: true }),
  );
  expect(screen.getByText("No repeat rides in this date range")).toBeTruthy();
});

it("selects a repeat ride from chart data and opens that activity", async () => {
  mockDecouplingQuery.mockReturnValue({
    data: {
      workoutName: "Endurance",
      rides: [
        {
          activityId: "ride-1",
          name: "Endurance",
          date: "2026-03-15T12:00:00Z",
          elapsedSeconds: 3600,
          modality: null,
          percent: 4,
          method: "equal_elapsed_time_halves_power_to_heart_rate",
          powerMeasurementKind: "direct",
          heartRateMeasurementKind: "unknown",
          firstHalf: { meanWatts: 200, meanBpm: 130, coveragePct: 99, pairedSeconds: 1782 },
          secondHalf: { meanWatts: 195, meanBpm: 135, coveragePct: 98, pairedSeconds: 1764 },
        },
        {
          activityId: "ride-2",
          name: "Endurance",
          date: "2026-03-15T12:00:00Z",
          elapsedSeconds: 3600,
          modality: null,
          percent: 4,
          method: "equal_elapsed_time_halves_power_to_heart_rate",
          powerMeasurementKind: "direct",
          heartRateMeasurementKind: "unknown",
          firstHalf: { meanWatts: 200, meanBpm: 130, coveragePct: 99, pairedSeconds: 1782 },
          secondHalf: { meanWatts: 195, meanBpm: 135, coveragePct: 98, pairedSeconds: 1764 },
        },
      ],
    },
  });
  try {
    const { TrainingAnalysis } = await import("../../app/strain");
    render(<TrainingAnalysis section="cycling" isFocused />);
    expect(screen.queryByText(/200 W.*130 bpm/)).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /View Power-to-heart-rate decoupling data/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Endurance.*Ride 2.*4.0%/ }));
    expect(screen.getByText(/200 W.*130 bpm.*99%/)).toBeTruthy();
    expect(screen.getByText(/195 W.*135 bpm.*98%/)).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Endurance" }));
    expect(mockRouterPush).toHaveBeenCalledWith("/activity/ride-2");
  } finally {
    mockDecouplingQuery.mockReset();
  }
});
