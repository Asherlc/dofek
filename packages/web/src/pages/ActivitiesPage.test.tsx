/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface MockQuery {
  data: unknown[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
}

let mockQuery: MockQuery;
let mockOverviewQuery: {
  data:
    | {
        activityCount: number;
        totalMinutes: number;
        totalDistanceMeters: number | null;
        totalDistanceState: { status: "available" } | { status: "missing"; reason: string };
        totalElevationGainM: number | null;
        totalElevationState: { status: "available" } | { status: "missing"; reason: string };
        activityTypes: string[];
        comparison?: {
          periodLabel: string;
          activityCount: { magnitude: number; trend: "higher" | "lower" | "unchanged" };
          totalMinutes: { magnitude: number; trend: "higher" | "lower" | "unchanged" };
          totalDistanceMeters: {
            magnitude: number | null;
            trend: "higher" | "lower" | "unchanged" | "unavailable";
            state: { status: "available" } | { status: "missing"; reason: string };
          };
          totalElevationGainM: {
            magnitude: number | null;
            trend: "higher" | "lower" | "unchanged" | "unavailable";
            state: { status: "available" } | { status: "missing"; reason: string };
          };
        };
      }
    | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
};
let weekListInput: unknown;
let weekListOptions: { placeholderData?: (previousData: unknown) => unknown } | undefined;
let overviewInput: unknown;
let overviewOptions: { placeholderData?: (previousData: unknown) => unknown } | undefined;
let bulkDeleteMutate: ReturnType<typeof vi.fn>;
let restoreProviderAbsentMutate: ReturnType<typeof vi.fn>;
let invalidateWeekList: ReturnType<typeof vi.fn>;
let invalidateActivityOverview: ReturnType<typeof vi.fn>;
let invalidateActivityList: ReturnType<typeof vi.fn>;
let mockBulkDeleteShouldFail: boolean;
let mockDataHealthQuery: {
  data: unknown;
  isLoading: boolean;
  error: Error | null;
};
let processingStatusInput: unknown;

interface BulkDeleteVariables {
  ids: string[];
}

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
  }: {
    children: ReactNode;
    to: string;
    params?: { id: string };
  }) => <a href={params?.id ? to.replace("$id", params.id) : to}>{children}</a>,
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    calendar: {
      weekList: {
        useQuery: (
          input: unknown,
          options: { placeholderData?: (previousData: unknown) => unknown } | undefined,
        ) => {
          weekListInput = input;
          weekListOptions = options;
          return mockQuery;
        },
      },
      activityOverview: {
        useQuery: (
          input: unknown,
          options: { placeholderData?: (previousData: unknown) => unknown } | undefined,
        ) => {
          overviewInput = input;
          overviewOptions = options;
          return mockOverviewQuery;
        },
      },
    },
    activity: {
      bulkDelete: {
        useMutation: (options?: {
          onSuccess?: () => Promise<void> | void;
          onError?: (error: Error, variables: BulkDeleteVariables) => void;
        }) => ({
          mutate: bulkDeleteMutate.mockImplementation(async (variables: BulkDeleteVariables) => {
            if (mockBulkDeleteShouldFail) {
              options?.onError?.(new Error("Delete failed"), variables);
              return;
            }
            await options?.onSuccess?.();
          }),
          isPending: false,
          error: null,
        }),
      },
      restoreProviderAbsent: {
        useMutation: (options?: { onSuccess?: () => Promise<void> | void }) => ({
          mutate: restoreProviderAbsentMutate.mockImplementation(async () => {
            await options?.onSuccess?.();
          }),
          isPending: false,
          error: null,
        }),
      },
    },
    processing: {
      status: {
        useQuery: (input: unknown) => {
          processingStatusInput = input;
          return mockDataHealthQuery;
        },
      },
    },
    useUtils: () => ({
      calendar: {
        weekList: { invalidate: invalidateWeekList },
        activityOverview: { invalidate: invalidateActivityOverview },
      },
      activity: {
        list: { invalidate: invalidateActivityList },
      },
    }),
  },
}));

vi.mock("../lib/unitContext.ts", () => ({
  useUnitConverter: () => ({
    formatDistance: (km: number) => ({ text: `${km.toFixed(1)} km`, parts: [] }),
    formatElevation: (meters: number) => ({ text: `${meters} m`, parts: [] }),
    convertDistance: (km: number) => km,
    distanceLabel: "km",
  }),
}));

import { ActivitiesPage } from "./ActivitiesPage.tsx";

function activity(overrides: Record<string, unknown> = {}) {
  return {
    id: "activity-1",
    name: "Trainer Ride",
    activityType: "indoor_cycling",
    startedAt: "2026-03-18T07:00:00.000Z",
    endedAt: "2026-03-18T08:00:00.000Z",
    localTimeContext: {
      timezone: null,
      startUtcOffsetMinutes: null,
      endUtcOffsetMinutes: null,
      source: "unknown",
    },
    durationMin: 60,
    source: {
      primarySourceLabel: "Wahoo",
      sourceCount: 1,
      overlapSummary: null,
    },
    lastProcessedAt: "2026-03-18T08:05:00.000Z",
    distanceMeters: null,
    distanceState: { status: "missing", reason: "Distance not recorded" },
    elevationGainM: null,
    elevationState: { status: "missing", reason: "Elevation not recorded" },
    location: null,
    tss: 100,
    stats: [{ status: "available", label: "Training Stress Score", value: "100" }],
    ...overrides,
  };
}

const mapPreview = {
  width: 1024,
  height: 576,
  tiles: [
    {
      url: "https://tile.openstreetmap.org/15/5241/12665.png",
      x: 0,
      y: 0,
      width: 256,
      height: 256,
    },
  ],
  routePath: [
    { x: 278.54, y: 379.51 },
    { x: 292.2, y: 370.88 },
  ],
};

describe("ActivitiesPage", () => {
  beforeEach(() => {
    mockQuery = { data: [], isLoading: false, isError: false, error: null };
    mockOverviewQuery = {
      data: {
        activityCount: 0,
        totalMinutes: 0,
        totalDistanceMeters: 0,
        totalDistanceState: { status: "available" },
        totalElevationGainM: 0,
        totalElevationState: { status: "available" },
        activityTypes: [],
      },
      isLoading: false,
      isError: false,
      error: null,
    };
    weekListInput = undefined;
    overviewInput = undefined;
    overviewOptions = undefined;
    bulkDeleteMutate = vi.fn();
    restoreProviderAbsentMutate = vi.fn();
    invalidateWeekList = vi.fn();
    invalidateActivityOverview = vi.fn();
    invalidateActivityList = vi.fn();
    mockBulkDeleteShouldFail = false;
    mockDataHealthQuery = { data: undefined, isLoading: false, error: null };
    processingStatusInput = undefined;
  });

  it("shows activity progress while summaries are updating", () => {
    mockDataHealthQuery = {
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

    render(<ActivitiesPage />);

    expect(processingStatusInput).toEqual({ datasets: ["activity"] });
    expect(screen.getByText("Recomputing activities", { selector: "span" })).toBeDefined();
    expect(screen.getByRole("progressbar")).toBeTruthy();
  });

  it("uses QueryStatePanel for loading state", () => {
    mockQuery = { data: undefined, isLoading: true, isError: false, error: null };

    render(<ActivitiesPage />);

    expect(screen.getByTestId("query-state-loading")).toBeDefined();
  });

  it("uses QueryStatePanel for empty state", () => {
    render(<ActivitiesPage />);

    expect(screen.getByTestId("query-state-empty")).toBeDefined();
    expect(screen.getByText("No activities in the last 4 weeks.")).toBeDefined();
  });

  it("renders server-provided stat labels and values", () => {
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);

    expect(screen.getByText("Training Stress Score")).toBeDefined();
    expect(screen.getByText("100")).toBeDefined();
    expect(screen.queryByText("TSS")).toBeNull();
  });

  it("keeps placeholder activity data visible during background refetch errors", () => {
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity({ name: "Cached Ride" })] }],
      isLoading: false,
      isError: true,
      error: new Error("Refetch failed"),
    };

    render(<ActivitiesPage />);

    expect(screen.getByText("Cached Ride")).toBeDefined();
    expect(screen.getByText("Refetch failed")).toBeDefined();
  });

  it("lays out each day of activities as a responsive card grid", () => {
    mockQuery = {
      data: [
        {
          date: "2026-03-18",
          activities: [
            activity({ id: "activity-1", name: "Trainer Ride" }),
            activity({ id: "activity-2", name: "Morning Run", activityType: "running" }),
          ],
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);

    expect(screen.getByTestId("activity-card-grid").className).toContain("grid");
    expect(screen.getByTestId("activity-card-grid").className).toContain("lg:grid-cols-2");
  });

  it("renders server-provided overview totals", () => {
    mockOverviewQuery = {
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

    render(<ActivitiesPage />);

    expect(screen.getByText("12")).toBeDefined();
    expect(screen.getByText("10h 15m")).toBeDefined();
    expect(screen.getByText("42.3 km")).toBeDefined();
    expect(screen.getByText("520 m")).toBeDefined();
    expect(screen.queryByText(/vs previous/)).toBeNull();
  });

  it("renders server-computed changes from the previous comparable period", () => {
    mockOverviewQuery = {
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

    render(<ActivitiesPage />);

    expect(screen.getByText("1 more vs previous 4 weeks")).toBeDefined();
    expect(screen.getByText("1h 30m less vs previous 4 weeks")).toBeDefined();
    expect(screen.getByText("No change vs previous 4 weeks")).toBeDefined();
    expect(
      screen.getByText("Comparison unavailable: Previous period: Elevation gain not recorded"),
    ).toBeDefined();
  });

  it("distinguishes unavailable overview measurements from measured zero", () => {
    mockOverviewQuery = {
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

    const { rerender } = render(<ActivitiesPage />);

    expect(screen.getByText("Distance not recorded")).toBeDefined();
    expect(screen.getByText("Elevation unavailable")).toBeDefined();
    expect(screen.queryByText("0.0 km")).toBeNull();
    expect(screen.queryByText("0 m")).toBeNull();

    mockOverviewQuery.data = {
      activityCount: 2,
      totalMinutes: 90,
      totalDistanceMeters: 0,
      totalDistanceState: { status: "available" },
      totalElevationGainM: 0,
      totalElevationState: { status: "available" },
      activityTypes: ["running"],
    };
    rerender(<ActivitiesPage />);

    expect(screen.getByText("0.0 km")).toBeDefined();
    expect(screen.getByText("0 m")).toBeDefined();
  });

  it("passes selected filters to the activity list query", () => {
    mockOverviewQuery = {
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

    render(<ActivitiesPage />);
    fireEvent.change(screen.getByLabelText("Date range"), { target: { value: "8" } });
    fireEvent.change(screen.getByLabelText("Activity type"), { target: { value: "running" } });

    expect(weekListInput).toEqual({
      weeks: 8,
      endDate: expect.any(String),
      activityType: "running",
    });
    expect(overviewInput).toEqual({
      weeks: 8,
      endDate: expect.any(String),
      activityType: "running",
    });
    const previousOverview = { activityTypes: ["running"] };
    expect(overviewOptions?.placeholderData?.(previousOverview)).toBe(previousOverview);
    const previousWeekList = [{ date: "2026-03-18", activities: [] }];
    expect(weekListOptions?.placeholderData?.(previousWeekList)).toBe(previousWeekList);
  });

  it("requests hidden activities when the show hidden toggle is enabled", () => {
    render(<ActivitiesPage />);
    fireEvent.click(screen.getByLabelText("Show hidden activities"));

    expect(weekListInput).toEqual({
      weeks: 4,
      endDate: expect.any(String),
      includeProviderAbsent: true,
    });
  });

  it("renders a type icon when an activity has no location data", () => {
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);

    expect(screen.getByTestId("activity-type-icon")).toBeDefined();
    expect(screen.getByLabelText("Indoor Cycling activity")).toBeDefined();
  });

  it("renders a map tile when an activity includes location data", () => {
    mockQuery = {
      data: [
        {
          date: "2026-03-18",
          activities: [
            activity({
              location: {
                centroidLat: 37.7749,
                centroidLng: -122.4194,
                mapPreview,
              },
              distanceMeters: 5000,
              elevationGainM: 120,
              distanceState: { status: "available" },
              elevationState: { status: "available" },
            }),
          ],
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);

    expect(screen.getByLabelText("Activity location map")).toBeDefined();
  });

  it("explains the activity selection action before entering select mode", () => {
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);

    expect(screen.getByRole("button", { name: "Select activities" })).toBeDefined();
    expect(screen.getByText("Choose one or more activities to delete.")).toBeDefined();
  });

  it("associates each selection control with its own guidance", () => {
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(
      <>
        <ActivitiesPage />
        <ActivitiesPage />
      </>,
    );

    const selectionButtons = screen.getAllByRole("button", { name: "Select activities" });
    const guidanceIds = selectionButtons.map((button) => button.getAttribute("aria-describedby"));

    expect(guidanceIds[0]).toBeTruthy();
    expect(guidanceIds[1]).toBeTruthy();
    expect(guidanceIds[0]).not.toBe(guidanceIds[1]);
    for (const guidanceId of guidanceIds) {
      expect(document.getElementById(guidanceId ?? "")).toHaveTextContent(
        "Choose one or more activities to delete.",
      );
    }
  });

  it("exposes the selected activity count as an accessible status", () => {
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    expect(screen.getByRole("status")).toHaveTextContent("0 activities selected");
    fireEvent.click(screen.getByText("Trainer Ride"));

    expect(screen.getByRole("status")).toHaveTextContent("1 activity selected");
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
    expect(screen.getByRole("status").getAttribute("aria-atomic")).toBe("true");
    expect(screen.queryByRole("link", { name: /Trainer Ride/i })).toBeNull();
  });

  it("bulk deletes selected activities after confirmation", async () => {
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    fireEvent.click(screen.getByText("Trainer Ride"));
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByText("Confirm Delete"));

    await waitFor(() => {
      expect(bulkDeleteMutate).toHaveBeenCalledWith({ ids: ["activity-1"] });
      expect(invalidateWeekList).toHaveBeenCalled();
      expect(invalidateActivityOverview).toHaveBeenCalled();
      expect(invalidateActivityList).toHaveBeenCalled();
    });
  });

  it("hides deleted activities immediately after delete confirmation", async () => {
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    fireEvent.click(screen.getByText("Trainer Ride"));
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByText("Confirm Delete"));

    await waitFor(() => {
      expect(bulkDeleteMutate).toHaveBeenCalledWith({ ids: ["activity-1"] });
      expect(screen.queryByText("Trainer Ride")).toBeNull();
    });
  });

  it("restores deleted activities when bulk delete fails", async () => {
    mockBulkDeleteShouldFail = true;
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    fireEvent.click(screen.getByText("Trainer Ride"));
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByText("Confirm Delete"));

    await waitFor(() => {
      expect(bulkDeleteMutate).toHaveBeenCalledWith({ ids: ["activity-1"] });
      expect(screen.getByText("Trainer Ride")).toBeDefined();
    });
  });

  it("clears selected activities when the activity type filter changes", () => {
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: false,
      error: null,
    };
    mockOverviewQuery = {
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

    render(<ActivitiesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    fireEvent.click(screen.getByText("Trainer Ride"));
    fireEvent.change(screen.getByLabelText("Activity type"), { target: { value: "running" } });

    expect(screen.queryByText("1 activity selected")).toBeNull();
    expect(screen.getByRole("button", { name: "Select activities" })).toBeDefined();
  });

  it("paginates the activity card history", () => {
    mockQuery = {
      data: [
        {
          date: "2026-03-18",
          activities: Array.from({ length: 21 }, (_, index) =>
            activity({
              id: `activity-${index + 1}`,
              name: `Ride ${index + 1}`,
            }),
          ),
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);

    expect(screen.getByText("Ride 1")).toBeDefined();
    expect(screen.queryByText("Ride 21")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next activities page" }));

    expect(screen.queryByText("Ride 1")).toBeNull();
    expect(screen.getByText("Ride 21")).toBeDefined();
  });

  it("restores selected hidden activities after confirmation", async () => {
    mockQuery = {
      data: [
        {
          date: "2026-03-18",
          activities: [
            activity({
              id: "hidden-1",
              isProviderAbsent: true,
              providerId: "strava",
              providerAbsentAt: "2026-03-05T14:30:00.000Z",
            }),
          ],
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);
    fireEvent.click(screen.getByLabelText("Show hidden activities"));
    expect(
      screen.getByText("Choose visible activities to delete or hidden activities to restore."),
    ).toBeDefined();
    expect(screen.getByText("Removed")).toBeDefined();
    expect(screen.getByText(/Removed from Strava/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    fireEvent.click(screen.getByText("Trainer Ride"));
    fireEvent.click(screen.getByText("Restore"));
    fireEvent.click(screen.getByText("Confirm Restore"));

    await waitFor(() => {
      expect(restoreProviderAbsentMutate).toHaveBeenCalledWith({ ids: ["hidden-1"] });
      expect(invalidateWeekList).toHaveBeenCalled();
      expect(invalidateActivityOverview).toHaveBeenCalled();
      expect(invalidateActivityList).toHaveBeenCalled();
    });
  });

  it("links tombstoned activities to their detail page", () => {
    mockQuery = {
      data: [
        {
          date: "2026-03-18",
          activities: [
            activity({
              id: "hidden-1",
              isProviderAbsent: true,
              providerId: "strava",
              providerAbsentAt: "2026-03-05T14:30:00.000Z",
            }),
          ],
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);
    fireEvent.click(screen.getByLabelText("Show hidden activities"));

    expect(screen.getByRole("link", { name: /Trainer Ride/i }).getAttribute("href")).toBe(
      "/activity/hidden-1",
    );
  });
});
