// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  activity,
  activityListQuery,
  emptyActivityOverviewQuery,
  type MockOverviewQuery,
} from "../../app-fixtures/(tabs)/activities-test-helpers";
import { activityMocks, titleSearchQuery } from "../../app-fixtures/(tabs)/activities-test-setup";

const { default: ActivitiesScreen } = await import("../../app/(tabs)/activities");

describe("Activities browsing and search", () => {
  it("searches all history without persisting the query and clears back to browsing", () => {
    const fetchNextPage = vi.fn();
    titleSearchQuery.mockImplementation((_input, options) => ({
      data: options.enabled
        ? {
            pages: [
              {
                activities: [
                  activity({ id: "older-ride", name: "Golden Hill Ride", date: "2021-05-14" }),
                ],
              },
            ],
          }
        : undefined,
      hasNextPage: true,
      fetchNextPage,
    }));
    render(<ActivitiesScreen />);
    expect(screen.getByRole("button", { name: /^Date range/ })).toBeDefined();
    expect(screen.getByRole("button", { name: /^Training time/ })).toBeDefined();

    fireEvent.change(screen.getByLabelText("Search activity titles"), {
      target: { value: " golden hi " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(titleSearchQuery).toHaveBeenLastCalledWith(
      { title: "golden hi", pageSize: 20 },
      expect.objectContaining({ enabled: true, meta: { persist: false } }),
    );
    expect(screen.getByText("Golden Hill Ride")).toBeDefined();
    expect(screen.queryByRole("button", { name: /^Date range/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Training time/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Sport,/ })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(fetchNextPage).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.queryByText("Golden Hill Ride")).toBeNull();
    expect(screen.getByRole("button", { name: /^Date range/ })).toBeDefined();
    expect(screen.getByRole("button", { name: /^Training time/ })).toBeDefined();
  });

  it("shows a retryable search error when refreshing an empty result fails", () => {
    const refetch = vi.fn();
    titleSearchQuery.mockReturnValue({
      data: { pages: [{ activities: [] }] },
      isError: true,
      error: new Error("Activity search is temporarily unavailable."),
      refetch,
    });
    render(<ActivitiesScreen />);
    fireEvent.change(screen.getByLabelText("Search activity titles"), {
      target: { value: "golden hill" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(screen.queryByText("No matching activities.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("shows activity progress while summaries are updating", () => {
    activityMocks.mockDataHealthQuery = {
      data: {
        overallStatus: "active",
        generatedAt: "2026-06-30T08:00:00.000Z",
        scope: { providerId: null, datasets: ["activity"] },
        operations: [],
        datasets: [
          {
            key: "activity",
            label: "Activities",
            rawRows: 12,
            latestRawAt: "2026-06-30T07:00:00.000Z",
            latestReadModelAt: null,
            cdcLagSeconds: null,
            readModelLagSeconds: null,
            status: "active",
            progressPercentage: 60,
            message: "Activities are updating.",
          },
        ],
      },
      isLoading: false,
      error: null,
    };

    render(<ActivitiesScreen />);

    expect(activityMocks.processingStatusInput).toEqual({ datasets: ["activity"] });
    expect(screen.getByText("Recomputing activities")).toBeDefined();
  });

  it("loads a server-owned, labeled activity heatmap for the selected weeks", () => {
    activityMocks.mockCalendarQuery = {
      data: [
        {
          date: "2026-03-18",
          activityCount: 1,
          totalMinutes: 72,
          activityTypes: ["running"],
          trainingTimeBand: "high",
          trainingTimeMeaning: "High training volume; compare with recovery.",
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesScreen />);

    expect(activityMocks.calendarDataInput).toEqual({ days: 28 });
    expect(activityMocks.calendarDataOptions?.placeholderData?.([])).toBeUndefined();
    const previousCalendarData = [{ date: "2026-03-10" }];
    expect(activityMocks.calendarDataOptions?.placeholderData?.(previousCalendarData)).toBe(
      previousCalendarData,
    );
    expect(screen.queryByText("Training time (minutes per day)")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Training time/ }));
    expect(screen.getByText("Training time (minutes per day)")).toBeTruthy();
    expect(screen.getByRole("button", { name: /72 min/ })).toBeTruthy();
  });

  it("uses QueryStatePanel for overview loading state", () => {
    activityMocks.mockOverviewQuery = {
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    };

    render(<ActivitiesScreen />);

    expect(screen.getByTestId("query-state-loading")).toBeDefined();
  });

  it("renders server-provided stat labels and values", () => {
    activityMocks.mockQuery = activityListQuery([activity()]);

    render(<ActivitiesScreen />);

    expect(screen.getByText("Training Stress Score")).toBeDefined();
    expect(screen.getByText("100")).toBeDefined();
    expect(screen.queryByText("TSS")).toBeNull();
  });

  it("keeps placeholder activity data visible during background refetch errors", () => {
    activityMocks.mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity({ name: "Cached Ride" })] }],
      isLoading: false,
      isError: true,
      error: new Error("Refetch failed"),
    };

    render(<ActivitiesScreen />);

    expect(screen.getByText("Cached Ride")).toBeDefined();
    expect(screen.getByText("Refetch failed")).toBeDefined();
  });

  it("renders server-provided overview totals", () => {
    activityMocks.mockOverviewQuery = {
      data: {
        activityCount: 12,
        totalMinutes: 615,
        totalDistanceMeters: 42300,
        totalDistanceState: { status: "available" },
        totalElevationGainM: 520,
        totalElevationState: { status: "available" },
        activityTypes: ["running", "cycling"],
      },
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesScreen />);

    fireEvent.click(screen.getByRole("button", { name: /^Training time/ }));
    expect(screen.getByText("12")).toBeDefined();
    expect(screen.getByText("10h 15m")).toBeDefined();
    expect(screen.getByText("42.3 km")).toBeDefined();
    expect(screen.getByText("520 m")).toBeDefined();
  });

  it("waits for matching training totals after a sport change", () => {
    const overview = emptyActivityOverviewQuery();
    const previousTotals = {
      activityCount: 12,
      totalMinutes: 615,
      totalDistanceMeters: null,
      totalDistanceState: { status: "missing", reason: "No distance recorded" },
      totalElevationGainM: null,
      totalElevationState: { status: "missing", reason: "No elevation recorded" },
      activityTypes: ["running"],
    } satisfies NonNullable<MockOverviewQuery["data"]>;
    activityMocks.mockOverviewQuery = {
      ...overview,
      data: previousTotals,
    };
    const { rerender } = render(<ActivitiesScreen />);
    const trainingTime = () => screen.getByRole("button", { name: /^Training time/ });
    expect(trainingTime().textContent).toContain("12 activities");

    fireEvent.click(screen.getByRole("button", { name: /^Sport,/ }));
    activityMocks.mockOverviewQuery = {
      ...activityMocks.mockOverviewQuery,
      isPlaceholderData: true,
    };
    fireEvent.click(screen.getByText("Running"));
    expect(trainingTime().textContent).toContain("Updating");
    expect(trainingTime().textContent).not.toContain("12 activities");

    activityMocks.mockOverviewQuery = {
      ...activityMocks.mockOverviewQuery,
      data: { ...previousTotals, activityCount: 1, totalMinutes: 60 },
      isPlaceholderData: false,
    };
    rerender(<ActivitiesScreen />);
    expect(trainingTime().textContent).toContain("1 activity");
  });

  it("renders server-computed changes from the previous comparable period", () => {
    activityMocks.mockOverviewQuery = {
      data: {
        activityCount: 12,
        totalMinutes: 615,
        totalDistanceMeters: 42300,
        totalDistanceState: { status: "available" },
        totalElevationGainM: 520,
        totalElevationState: { status: "available" },
        activityTypes: ["running", "cycling"],
        comparison: {
          periodLabel: "previous 4 weeks",
          activityCount: { magnitude: 1, trend: "higher" },
          totalMinutes: { magnitude: 90, trend: "lower" },
          totalDistanceMeters: {
            magnitude: 0,
            trend: "unchanged",
            state: { status: "available" },
          },
          totalElevationGainM: {
            magnitude: null,
            trend: "unavailable",
            state: { status: "missing", reason: "Previous period: Elevation gain not recorded" },
          },
        },
      },
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesScreen />);

    fireEvent.click(screen.getByRole("button", { name: /^Training time/ }));
    expect(screen.getByText("1 more vs previous 4 weeks")).toBeDefined();
    expect(screen.getByText("1h 30m less vs previous 4 weeks")).toBeDefined();
    expect(screen.getByText("No change vs previous 4 weeks")).toBeDefined();
    expect(
      screen.getByText("Comparison unavailable: Previous period: Elevation gain not recorded"),
    ).toBeDefined();
    expect(screen.getByLabelText("Activities 12. 1 more vs previous 4 weeks")).toBeDefined();
    expect(screen.getByLabelText("Time 10h 15m. 1h 30m less vs previous 4 weeks")).toBeDefined();
  });

  it("distinguishes unavailable overview measurements from measured zero", () => {
    activityMocks.mockOverviewQuery = {
      data: {
        activityCount: 2,
        totalMinutes: 90,
        totalDistanceMeters: null,
        totalDistanceState: { status: "missing", reason: "Distance not recorded" },
        totalElevationGainM: null,
        totalElevationState: { status: "missing", reason: "Elevation not recorded" },
        activityTypes: ["running"],
      },
      isLoading: false,
      isError: false,
      error: null,
    };

    const { rerender } = render(<ActivitiesScreen />);

    fireEvent.click(screen.getByRole("button", { name: /^Training time/ }));
    expect(screen.getByText("Distance not recorded")).toBeDefined();
    expect(screen.getByText("Elevation unavailable")).toBeDefined();
    expect(screen.queryByText("0.0 km")).toBeNull();
    expect(screen.queryByText("0 m")).toBeNull();

    activityMocks.mockOverviewQuery.data = {
      activityCount: 2,
      totalMinutes: 90,
      totalDistanceMeters: 0,
      totalDistanceState: { status: "available" },
      totalElevationGainM: 0,
      totalElevationState: { status: "available" },
      activityTypes: ["running"],
    };
    rerender(<ActivitiesScreen />);

    expect(screen.getByText("0.0 km")).toBeDefined();
    expect(screen.getByText("0 m")).toBeDefined();
  });

  it("renders available partial overview measurements and comparisons", () => {
    activityMocks.mockOverviewQuery = {
      data: {
        activityCount: 4,
        totalMinutes: 280,
        totalDistanceMeters: 12500,
        totalDistanceState: { status: "available" },
        totalElevationGainM: 180,
        totalElevationState: { status: "available" },
        activityTypes: ["running", "cycling"],
        comparison: {
          periodLabel: "previous 4 weeks",
          activityCount: { magnitude: 1, trend: "higher" },
          totalMinutes: { magnitude: 60, trend: "higher" },
          totalDistanceMeters: {
            magnitude: 2500,
            trend: "higher",
            state: { status: "available" },
          },
          totalElevationGainM: {
            magnitude: 50,
            trend: "higher",
            state: { status: "available" },
          },
        },
      },
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesScreen />);

    fireEvent.click(screen.getByRole("button", { name: /^Training time/ }));
    expect(screen.getByText("12.5 km")).toBeDefined();
    expect(screen.getByText("180 m")).toBeDefined();
    expect(screen.getByText("2.5 km more vs previous 4 weeks")).toBeDefined();
    expect(screen.getByText("50 m more vs previous 4 weeks")).toBeDefined();
    expect(
      screen.getByLabelText("Distance 12.5 km. 2.5 km more vs previous 4 weeks"),
    ).toBeDefined();
    expect(screen.getByLabelText("Elevation 180 m. 50 m more vs previous 4 weeks")).toBeDefined();
  });

  it("passes selected activity type to the activity list query", () => {
    activityMocks.mockOverviewQuery = {
      data: {
        activityCount: 1,
        totalMinutes: 60,
        totalDistanceMeters: 5000,
        totalDistanceState: { status: "available" },
        totalElevationGainM: 120,
        totalElevationState: { status: "available" },
        activityTypes: ["running"],
      },
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesScreen />);
    fireEvent.click(screen.getByRole("button", { name: /^Sport,/ }));
    fireEvent.click(screen.getByText("Running"));

    expect(activityMocks.weekListInput).toEqual({
      weeks: 4,
      endDate: expect.any(String),
      activityType: "running",
      page: 0,
      pageSize: 20,
    });
    expect(activityMocks.overviewInput).toEqual({
      weeks: 4,
      endDate: expect.any(String),
      activityType: "running",
    });
    const previousOverview = { activityTypes: ["running"] };
    expect(activityMocks.overviewOptions?.placeholderData?.(previousOverview)).toBe(
      previousOverview,
    );
    const previousWeekList = [{ date: "2026-03-18", activities: [] }];
    expect(activityMocks.weekListOptions?.placeholderData?.(previousWeekList)).toBe(
      previousWeekList,
    );
  });
});
