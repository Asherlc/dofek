// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AccessibilityInfo, Alert, Platform } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activity,
  activityListQuery,
  climbingSourceLocation,
  recordedGpsLocation,
} from "../../app-fixtures/(tabs)/activities-test-helpers";
import {
  activityMocks,
  locationSearchQuery,
  mockActivityImages,
  mockImagesQuery,
  placeLookupQuery,
  routerPush,
  titleSearchQuery,
} from "../../app-fixtures/(tabs)/activities-test-setup";
import { branchingActivitySourceTree } from "../../app-fixtures/activity-source-tree";
import { activityImageFixture } from "../../components/activity-images-test-helpers";
import { samplePlannedWorkout } from "../../components/PlannedWorkoutCard.fixtures.ts";

const { default: ActivitiesScreen } = await import("../../app/(tabs)/activities");
const connectionMessage = "We couldn't reach the server. Check your connection and try again.";

function renderLiveActivityList(fetch: NonNullable<typeof activityMocks.livePageFetch>) {
  activityMocks.liveQueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  activityMocks.livePageFetch = fetch;
  return render(
    <QueryClientProvider client={activityMocks.liveQueryClient}>
      <ActivitiesScreen />
    </QueryClientProvider>,
  );
}

describe("ActivitiesScreen", () => {
  it("renders planned rows in the workout calendar beside an empty completed list", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-11-24T15:00:00.000Z"));
    activityMocks.mockUpcomingQuery = {
      ...activityMocks.mockUpcomingQuery,
      data: [
        {
          date: "2026-11-26",
          workouts: [samplePlannedWorkout],
        },
      ],
    };

    render(<ActivitiesScreen />);

    expect(screen.getByText("Workout calendar")).toBeDefined();
    expect(screen.getByText("Threshold intervals")).toBeDefined();
    expect(screen.getByText("Planned")).toBeDefined();
    expect(activityMocks.upcomingQueryInput).toMatchObject({
      dateRange: { startDate: "2026-11-23", endDate: "2026-11-29" },
    });
    vi.useRealTimers();
  });

  it("searches recorded locations, chooses a nearby place, and loads more results", () => {
    const fetchNextPage = vi.fn();
    if (activityMocks.mockOverviewQuery.data) {
      activityMocks.mockOverviewQuery.data.activityTypes = ["running"];
    }
    locationSearchQuery.mockImplementation((input, options) => ({
      data: options.enabled
        ? {
            pages: [
              {
                activities: [
                  activity({
                    name: input.location.kind === "nearby" ? "Oakland Run" : "Gym Session",
                    date: "2026-03-18",
                  }),
                ],
              },
            ],
          }
        : undefined,
      hasNextPage: true,
      fetchNextPage,
    }));
    placeLookupQuery.mockImplementation((_input, options) => ({
      data: options.enabled
        ? [
            { id: "ca", label: "Oakland, CA", latitude: 37.8, longitude: -122.3 },
            { id: "or", label: "Oakland, OR", latitude: 43.4, longitude: -123.3 },
          ]
        : undefined,
    }));
    render(<ActivitiesScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Location" }));
    fireEvent.change(screen.getByLabelText("Search activity locations"), {
      target: { value: "Oakland" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(screen.getByText("Gym Session")).toBeDefined();
    expect(placeLookupQuery.mock.lastCall?.[1].enabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Look up a place" }));
    fireEvent.click(screen.getByRole("button", { name: "Oakland, CA" }));
    expect(screen.getByText("Oakland Run")).toBeDefined();
    expect(locationSearchQuery).toHaveBeenLastCalledWith(
      {
        location: { kind: "nearby", latitude: 37.8, longitude: -122.3 },
        pageSize: 20,
      },
      expect.objectContaining({ enabled: true }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(fetchNextPage).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Sport, All activities" }));
    fireEvent.click(screen.getByRole("button", { name: "Running" }));
    expect(locationSearchQuery).toHaveBeenLastCalledWith(
      {
        location: { kind: "nearby", latitude: 37.8, longitude: -122.3 },
        activityType: "running",
        pageSize: 20,
      },
      expect.objectContaining({ enabled: true }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.queryByText("Oakland Run")).toBeNull();
  });

  it("keeps named search available when public place lookup fails", () => {
    const refetch = vi.fn();
    placeLookupQuery.mockImplementation((_input, options) =>
      options.enabled
        ? { isError: true, error: new Error("Place lookup is temporarily unavailable."), refetch }
        : {},
    );
    locationSearchQuery.mockImplementation((_input, options) => ({
      data: options.enabled
        ? { pages: [{ activities: [activity({ name: "Gym Session", date: "2026-03-18" })] }] }
        : undefined,
    }));
    render(<ActivitiesScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Location" }));
    fireEvent.change(screen.getByLabelText("Search activity locations"), {
      target: { value: "East Bay" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Look up a place" }));
    expect(screen.getByText("Gym Session")).toBeDefined();
    expect(screen.getByText("Place lookup is temporarily unavailable.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry place lookup" }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("groups a visible place lookup failure with other connection failures and retries it", () => {
    const placesRefetch = vi.fn();
    const processingRefetch = vi.fn();
    placeLookupQuery.mockImplementation((_input, options) =>
      options.enabled
        ? { isError: true, error: new Error(connectionMessage), refetch: placesRefetch }
        : {},
    );
    activityMocks.mockDataHealthQuery = {
      ...activityMocks.mockDataHealthQuery,
      error: new Error(connectionMessage),
      refetch: processingRefetch,
    };

    render(<ActivitiesScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Location" }));
    fireEvent.change(screen.getByLabelText("Search activity locations"), {
      target: { value: "East Bay" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Look up a place" }));

    expect(screen.getAllByText(connectionMessage)).toHaveLength(1);
    expect(screen.queryByText("Place lookup is temporarily unavailable.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(placesRefetch).toHaveBeenCalledOnce();
    expect(processingRefetch).toHaveBeenCalledOnce();
  });

  it("excludes an inactive place lookup failure from the shared connection group", () => {
    const placesRefetch = vi.fn();
    placeLookupQuery.mockImplementation(() => ({
      isError: true,
      error: new Error(connectionMessage),
      refetch: placesRefetch,
    }));
    activityMocks.mockDataHealthQuery = {
      ...activityMocks.mockDataHealthQuery,
      error: new Error(connectionMessage),
      refetch: vi.fn(),
    };

    render(<ActivitiesScreen />);

    expect(screen.getAllByText(connectionMessage)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(placesRefetch).not.toHaveBeenCalled();
  });

  it("shows one notice when activity and processing status queries fail from the same offline condition", () => {
    activityMocks.mockOverviewQuery = {
      ...activityMocks.mockOverviewQuery,
      isError: true,
      error: new Error("Failed to fetch"),
    };
    activityMocks.mockQuery = {
      ...activityMocks.mockQuery,
      isError: true,
      error: new Error("Network request failed"),
    };
    activityMocks.mockDataHealthQuery = {
      ...activityMocks.mockDataHealthQuery,
      error: new Error("Failed to fetch"),
    };

    render(<ActivitiesScreen />);

    expect(screen.getAllByText(connectionMessage)).toHaveLength(1);
    expect(screen.queryByText(/No activities in the last/)).toBeNull();
  });

  it("shared connection retry refetches every failed visible query including the activity list", () => {
    const overviewRefetch = vi.fn();
    const listRefetch = vi.fn();
    const processingRefetch = vi.fn();
    activityMocks.mockOverviewQuery = {
      ...activityMocks.mockOverviewQuery,
      isError: true,
      error: new Error(connectionMessage),
      refetch: overviewRefetch,
    };
    activityMocks.mockQuery = {
      ...activityMocks.mockQuery,
      isError: true,
      error: new Error(connectionMessage),
      refetch: listRefetch,
    };
    activityMocks.mockDataHealthQuery = {
      ...activityMocks.mockDataHealthQuery,
      error: new Error(connectionMessage),
      refetch: processingRefetch,
    };

    render(<ActivitiesScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(overviewRefetch).toHaveBeenCalledOnce();
    expect(listRefetch).toHaveBeenCalledOnce();
    expect(processingRefetch).toHaveBeenCalledOnce();
  });

  it("does not count hidden overview and calendar failures while searching", () => {
    const searchRefetch = vi.fn();
    titleSearchQuery.mockReturnValue({
      data: undefined,
      isError: true,
      error: new Error(connectionMessage),
      isFetching: false,
      hasNextPage: false,
      refetch: searchRefetch,
    });
    activityMocks.mockOverviewQuery = {
      ...activityMocks.mockOverviewQuery,
      isError: true,
      error: new Error(connectionMessage),
    };
    activityMocks.mockCalendarQuery = {
      ...activityMocks.mockCalendarQuery,
      isError: true,
      error: new Error(connectionMessage),
    };

    render(<ActivitiesScreen />);
    fireEvent.change(screen.getByLabelText("Search activity titles"), {
      target: { value: "Ride" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(searchRefetch).toHaveBeenCalledOnce();
  });

  it("uses the primary climbing source for the icon over a cardio representative", () => {
    activityMocks.mockQuery = activityListQuery([
      activity({ name: "Kaya climbing", activityType: "cardio", primaryActivityType: "climbing" }),
    ]);
    render(<ActivitiesScreen />);
    expect(screen.getByLabelText("Climbing activity")).toBeDefined();
    expect(screen.getByText("Climbing")).toBeDefined();
    expect(screen.getByRole("button", { name: /^Open Kaya climbing,.*Climbing/ })).toBeDefined();
  });

  it("uses the primary activity type for unnamed activity titles and accessible actions", () => {
    activityMocks.mockQuery = activityListQuery([
      activity({ name: null, activityType: "walking", primaryActivityType: "running" }),
    ]);

    render(<ActivitiesScreen />);

    expect(screen.getByText("Running")).toBeDefined();
    expect(screen.getByRole("button", { name: /^Open Running,/ })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    expect(screen.getByRole("button", { name: /^Select Running,/ })).toBeDefined();
  });

  it("labels an unknown duration as unavailable in the text and the accessible name", () => {
    activityMocks.mockQuery = activityListQuery([
      activity({ name: "Kilter climbing", activityType: "climbing", durationMin: null }),
    ]);

    render(<ActivitiesScreen />);

    expect(screen.getByText(/· Duration unavailable$/)).toBeDefined();
    expect(screen.queryByText(/· --$/)).toBeNull();
    const row = screen.getByRole("button", { name: /^Open Kilter climbing,/ });
    expect(row.getAttribute("aria-label")).toContain(", Duration unavailable,");
    expect(row.getAttribute("aria-label")).not.toContain("--");
  });

  it("shows one downloaded photo for activities without a map", () => {
    activityMocks.mockQuery = activityListQuery([activity({ location: null })]);
    mockActivityImages([activityImageFixture, { ...activityImageFixture, id: "photo-2" }]);
    render(<ActivitiesScreen />);
    expect(screen.getAllByLabelText("View from the summit")).toHaveLength(1);
    expect(mockImagesQuery).toHaveBeenCalledWith(
      { id: "activity-1" },
      expect.objectContaining({ meta: { persist: false } }),
    );
  });

  it("keeps provider-removed activities visible without requesting their retired photos", () => {
    activityMocks.mockQuery = activityListQuery([
      activity({ location: null, isProviderAbsent: true }),
    ]);
    render(<ActivitiesScreen />);
    expect(screen.getByText("Trainer Ride")).toBeTruthy();
    expect(mockImagesQuery).not.toHaveBeenCalled();
  });

  it.each([recordedGpsLocation(), climbingSourceLocation(), { kind: "processing" }])(
    "keeps map cards focused on their map rather than fetching a photo",
    (location) => {
      activityMocks.mockQuery = activityListQuery([activity({ location })]);
      render(<ActivitiesScreen />);
      expect(mockImagesQuery).not.toHaveBeenCalled();
      expect(screen.queryByLabelText("View from the summit")).toBeNull();
    },
  );
  it.each([null, recordedGpsLocation()])(
    "keeps activity identity leading with a resolved source and location %j",
    (location) => {
      activityMocks.mockQuery = activityListQuery([
        activity({
          location,
          source: {
            tree: branchingActivitySourceTree,
            origin: {
              status: "resolved",
              memberActivityId: "00000000-0000-4000-8000-000000000001",
              providerId: "apple_health",
              sourceName: "Hang Ten Training",
            },
            primarySourceLabel: "Hang Ten (via Apple Health)",
            sourceCount: 2,
            overlapSummary: "2 matched source records",
          },
        }),
      ]);
      render(<ActivitiesScreen />);
      const icon = screen.getByTestId("activity-type-icon");
      const title = screen.getByText("Trainer Ride");
      expect(icon.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      const sources = screen.getByRole("button", { name: "Lineage: Hang Ten" });
      expect(
        title.compareDocumentPosition(sources) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      if (location) {
        const map = screen.getByTestId("activity-route-viewport");
        expect(
          map.compareDocumentPosition(sources) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
    },
  );

  it("keeps a Garmin model thumbnail in its inline source disclosure", () => {
    activityMocks.mockQuery = activityListQuery([
      activity({
        source: {
          origin: {
            status: "resolved",
            memberActivityId: "00000000-0000-4000-8000-000000000001",
            providerId: "garmin",
            sourceName: "Forerunner 965",
          },
          primarySourceLabel: "Garmin · Forerunner 965",
          tree: {
            primary: {
              id: "garmin-record",
              providerId: "garmin",
              sourceName: "Forerunner 965",
              label: "Forerunner 965",
              description: null,
              url: null,
              children: [],
            },
            otherSources: [],
          },
          sourceCount: 1,
          overlapSummary: null,
        },
      }),
    ]);
    render(<ActivitiesScreen />);
    const source = screen.getByRole("button", { name: "Lineage: Forerunner 965" });
    const thumbnail = source.querySelector("Image");
    expect(thumbnail).toBeTruthy();
    expect(thumbnail?.getAttribute("resizeMode")).toBe("contain");
    expect(thumbnail?.getAttribute("style")).toContain("width: 20px");
    expect(thumbnail?.getAttribute("style")).toContain("height: 20px");
    expect(screen.getByTestId("activity-type-icon")).toBeDefined();
  });

  it.each([false, true])(
    "keeps photos and source details independent of card action in selection mode %s",
    (selectMode) => {
      activityMocks.mockQuery = activityListQuery([
        activity({
          source: {
            tree: branchingActivitySourceTree,
            origin: {
              status: "resolved",
              memberActivityId: "00000000-0000-4000-8000-000000000001",
              providerId: "whoop",
              sourceName: null,
            },
            primarySourceLabel: "WHOOP",
            sourceCount: 1,
            overlapSummary: null,
          },
        }),
      ]);
      mockActivityImages([activityImageFixture]);
      render(<ActivitiesScreen />);
      if (selectMode) fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
      const sourceButton = screen.getByRole("button", { name: "Lineage: Hang Ten" });
      const cardAction = screen.getByRole("button", {
        name: selectMode ? /^Select Trainer Ride/ : /^Open Trainer Ride/,
      });
      expect(cardAction.contains(sourceButton)).toBe(false);
      expect(sourceButton.parentElement?.closest("button")).toBeNull();
      const photo = screen.getByLabelText("View from the summit");
      expect(photo.closest('[pointer-events="none"]')).not.toBeNull();

      fireEvent.click(sourceButton);
      expect(screen.getByText("Apple Health")).toBeDefined();
      expect(routerPush).not.toHaveBeenCalled();
      if (selectMode) expect(screen.getByText("0 activities selected")).toBeDefined();
      fireEvent.click(sourceButton);
      fireEvent.click(cardAction);
      if (selectMode) {
        expect(screen.getByText("1 activity selected")).toBeDefined();
        expect(routerPush).not.toHaveBeenCalled();
      } else {
        expect(routerPush).toHaveBeenCalledWith("/activity/activity-1");
      }
    },
  );
  it("navigates to activity detail when not selecting activities", () => {
    activityMocks.mockQuery = activityListQuery([activity()]);

    render(<ActivitiesScreen />);
    fireEvent.click(screen.getByRole("button", { name: /^(Open|Select|Deselect) Trainer Ride,/ }));

    expect(routerPush).toHaveBeenCalledWith("/activity/activity-1");
  });

  it("includes visible activity context in each accessible action name", () => {
    activityMocks.mockQuery = activityListQuery([activity()]);

    render(<ActivitiesScreen />);

    const activityButton = screen.getByRole("button", { name: /^Open Trainer Ride/ });
    expect(activityButton?.getAttribute("aria-label")).toContain("Open Trainer Ride");
    expect(activityButton?.getAttribute("aria-label")).toContain("1h");
    expect(activityButton?.getAttribute("aria-label")).toContain("Indoor Cycling");
  });

  it("includes available route measurements in each accessible action name", () => {
    activityMocks.mockQuery = activityListQuery([
      activity({
        activityType: "cycling",
        modality: "road",
        distanceMeters: 5000,
        distanceState: { status: "available" },
        elevationGainM: 120,
        elevationState: { status: "available" },
        location: null,
      }),
    ]);

    render(<ActivitiesScreen />);

    const activityButton = screen.getByRole("button", { name: /^Open Trainer Ride/ });
    expect(activityButton?.getAttribute("aria-label")).toContain("Distance 5.0 km");
    expect(activityButton?.getAttribute("aria-label")).toContain("Elevation 120 m");
  });

  it.each([
    { modality: "indoor", distanceMeters: 0, elevationGainM: null },
    { modality: "virtual", distanceMeters: 0, elevationGainM: null },
    { modality: "indoor", distanceMeters: 25_000, elevationGainM: 400 },
    { modality: "virtual", distanceMeters: 25_000, elevationGainM: 400 },
  ])(
    "uses training stats in visible and accessible $modality cycling cards with distance $distanceMeters",
    ({ modality, distanceMeters, elevationGainM }) => {
      activityMocks.mockQuery = activityListQuery([
        activity({
          activityType: "cycling",
          modality,
          distanceMeters,
          distanceState: { status: "available" },
          elevationGainM,
          elevationState:
            elevationGainM === null
              ? { status: "missing", reason: "Elevation not recorded" }
              : { status: "available" },
          stats: [
            { status: "available", label: "Training Stress Score", value: "100" },
            { status: "missing", label: "Average Power", reason: "Power not recorded" },
          ],
        }),
      ]);

      render(<ActivitiesScreen />);

      const activityButton = screen.getByRole("button", { name: /^Open Trainer Ride/ });
      expect(
        within(activityButton.parentElement ?? activityButton).getByText("Training Stress Score"),
      ).toBeDefined();
      expect(within(activityButton.parentElement ?? activityButton).getByText("100")).toBeDefined();
      expect(
        within(activityButton.parentElement ?? activityButton).queryByText("Distance"),
      ).toBeNull();
      expect(
        within(activityButton.parentElement ?? activityButton).queryByText(/Elevation/),
      ).toBeNull();
      expect(activityButton.getAttribute("aria-label")).toContain("Training Stress Score 100");
      expect(activityButton.getAttribute("aria-label")).toContain(
        "Average Power unavailable: Power not recorded",
      );
      expect(activityButton.getAttribute("aria-label")).not.toMatch(/Distance|Elevation/);
    },
  );

  it.each([
    { activityType: "cycling", modality: "road" },
    { activityType: "running", modality: "indoor" },
  ])("keeps measured zero in accessible $modality $activityType cards", (classification) => {
    activityMocks.mockQuery = activityListQuery([
      activity({
        ...classification,
        distanceMeters: 0,
        distanceState: { status: "available" },
        elevationGainM: 0,
        elevationState: { status: "available" },
      }),
    ]);

    render(<ActivitiesScreen />);

    const activityButton = screen.getByRole("button", { name: /^Open Trainer Ride/ });
    expect(activityButton.getAttribute("aria-label")).toContain("Distance 0.0 km");
    expect(activityButton.getAttribute("aria-label")).toContain("Elevation 0 m");
    expect(
      within(activityButton.parentElement ?? activityButton).getByText("Distance"),
    ).toBeDefined();
    expect(
      within(activityButton.parentElement ?? activityButton).getByText("Elevation"),
    ).toBeDefined();
  });

  it.each([null, "Indoor Cycling"])(
    "labels an activity named %s without repeating its type",
    (name) => {
      activityMocks.mockQuery = activityListQuery([activity({ name })]);

      render(<ActivitiesScreen />);

      const openButton = screen.getByRole("button", { name: /^Open Indoor Cycling/ });
      expect(openButton.getAttribute("aria-label")?.match(/Indoor Cycling/g)).toHaveLength(1);
      expect(
        within(openButton.parentElement ?? openButton).getAllByText("Indoor Cycling"),
      ).toHaveLength(1);

      fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
      const selectButton = screen.getByRole("button", { name: /^Select Indoor Cycling/ });
      expect(selectButton.getAttribute("aria-label")?.match(/Indoor Cycling/g)).toHaveLength(1);
    },
  );

  it("toggles selected activities instead of navigating in select mode", () => {
    activityMocks.mockQuery = activityListQuery([activity()]);

    render(<ActivitiesScreen />);
    expect(screen.queryByText("Choose activities to merge or delete.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    expect(screen.getByText("Choose activities to merge or delete.")).toBeDefined();
    expect(screen.getByText("0 activities selected").getAttribute("accessibilityliveregion")).toBe(
      "polite",
    );
    fireEvent.click(screen.getByRole("button", { name: /^(Open|Select|Deselect) Trainer Ride,/ }));

    expect(routerPush).not.toHaveBeenCalled();
    expect(screen.getByText("1 activity selected").getAttribute("accessibilityliveregion")).toBe(
      "polite",
    );
  });

  it("announces selected activity count changes on iOS", async () => {
    activityMocks.mockQuery = activityListQuery([activity()]);
    vi.spyOn(Platform, "OS", "get").mockReturnValue("ios");
    const announceForAccessibility = vi
      .spyOn(AccessibilityInfo, "announceForAccessibility")
      .mockImplementation(() => undefined);

    render(<ActivitiesScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    await waitFor(() =>
      expect(announceForAccessibility).toHaveBeenLastCalledWith("0 activities selected"),
    );
    fireEvent.click(screen.getByRole("button", { name: /^(Open|Select|Deselect) Trainer Ride,/ }));

    await waitFor(() =>
      expect(announceForAccessibility).toHaveBeenLastCalledWith("1 activity selected"),
    );
  });

  it("bulk deletes selected activities after confirmation", async () => {
    activityMocks.mockQuery = activityListQuery([activity()]);
    vi.spyOn(Alert, "alert").mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.text === "Delete")?.onPress?.();
    });

    render(<ActivitiesScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    fireEvent.click(screen.getByRole("button", { name: /^(Open|Select|Deselect) Trainer Ride,/ }));
    fireEvent.click(screen.getByText("Delete"));

    await waitFor(() => {
      expect(activityMocks.bulkDeleteMutateAsync).toHaveBeenCalledWith({ ids: ["activity-1"] });
      expect(activityMocks.invalidateWeekList).toHaveBeenCalled();
      expect(activityMocks.invalidateActivityOverview).toHaveBeenCalled();
      expect(activityMocks.invalidateCalendarData).toHaveBeenCalled();
      expect(activityMocks.invalidateActivityList).toHaveBeenCalled();
      expect(activityMocks.resetTrainingProgressionStrength).toHaveBeenCalledOnce();
      expect(activityMocks.resetTrainingProgressionCycling).toHaveBeenCalledOnce();
    });
  });

  it("merges selected same-type activities after native confirmation", async () => {
    activityMocks.mockQuery = activityListQuery([
      activity(),
      activity({ id: "activity-2", name: "Second Ride" }),
    ]);
    vi.spyOn(Alert, "alert").mockImplementation((_title, _message, buttons) => {
      expect(_title).toBe("Merge Activities");
      buttons?.find((button) => button.text === "Merge")?.onPress?.();
    });
    render(<ActivitiesScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    fireEvent.click(screen.getByRole("button", { name: /^(Open|Select|Deselect) Trainer Ride,/ }));
    fireEvent.click(screen.getByRole("button", { name: /^(Open|Select|Deselect) Second Ride,/ }));
    fireEvent.click(screen.getByText("Merge"));
    await waitFor(() => {
      expect(activityMocks.mergeMutateAsync).toHaveBeenCalledWith({
        ids: ["activity-1", "activity-2"],
      });
      expect(activityMocks.invalidateWeekList).toHaveBeenCalled();
      expect(activityMocks.invalidateActivityOverview).toHaveBeenCalled();
      expect(activityMocks.invalidateCalendarData).toHaveBeenCalled();
      expect(activityMocks.invalidateActivityList).toHaveBeenCalled();
      expect(activityMocks.resetTrainingProgressionStrength).toHaveBeenCalledOnce();
      expect(activityMocks.resetTrainingProgressionCycling).toHaveBeenCalledOnce();
    });
  });

  it("disables merge when fewer than two activities or mixed types are selected", () => {
    activityMocks.mockQuery = activityListQuery([
      activity(),
      activity({ id: "activity-2", name: "Run", activityType: "running" }),
    ]);
    render(<ActivitiesScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    const merge = screen.getByRole("button", { name: "Merge selected activities" });
    expect(merge.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^(Open|Select|Deselect) Trainer Ride,/ }));
    expect(merge.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^(Open|Select|Deselect) Run,/ }));
    expect(merge.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Select activities of one type to merge.")).toBeDefined();
  });

  it("keeps selected activities selected when merge fails", async () => {
    activityMocks.mockMergeShouldFail = true;
    activityMocks.mockQuery = activityListQuery([
      activity(),
      activity({ id: "activity-2", name: "Second Ride" }),
    ]);
    vi.spyOn(Alert, "alert").mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.text === "Merge")?.onPress?.();
    });
    render(<ActivitiesScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    fireEvent.click(screen.getByRole("button", { name: /^(Open|Select|Deselect) Trainer Ride,/ }));
    fireEvent.click(screen.getByRole("button", { name: /^(Open|Select|Deselect) Second Ride,/ }));
    fireEvent.click(screen.getByText("Merge"));
    await waitFor(() => {
      expect(activityMocks.mergeMutateAsync).toHaveBeenCalledWith({
        ids: ["activity-1", "activity-2"],
      });
      expect(screen.getByText("2 activities selected")).toBeDefined();
      expect(Alert.alert).toHaveBeenCalledWith("Unable to merge activities", "Merge failed");
    });
  });

  it("clears selected activities when the activity type filter changes", () => {
    activityMocks.mockQuery = activityListQuery([activity()]);
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
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    fireEvent.click(screen.getByRole("button", { name: /^(Open|Select|Deselect) Trainer Ride,/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Sport,/ }));
    fireEvent.click(screen.getByText("Running"));

    expect(screen.queryByText("1 activity selected")).toBeNull();
    expect(screen.getByRole("button", { name: "Select activities" })).toBeDefined();
  });

  it("clears selected activities when the date range changes", () => {
    activityMocks.mockQuery = activityListQuery([activity()]);

    render(<ActivitiesScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    fireEvent.click(screen.getByRole("button", { name: /^(Open|Select|Deselect) Trainer Ride,/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Date range/ }));
    fireEvent.click(screen.getByText("8 weeks"));

    expect(screen.queryByText("1 activity selected")).toBeNull();
    expect(screen.getByRole("button", { name: "Select activities" })).toBeDefined();
  });

  it("keeps cached cards and navigation after an uncached server page fails", async () => {
    let failPage = true;
    renderLiveActivityList(async (input) => {
      if (input.page === 1 && failPage)
        throw new Error("Page two is unavailable. Retry the request.");
      return {
        days: [
          {
            date: "2026-03-18",
            activities: [activity({ name: input.page === 1 ? "Next Ride" : "Cached Ride" })],
          },
        ],
        totalCount: 21,
        page: input.page ?? 0,
        pageSize: 20,
      };
    });
    await screen.findByText("Cached Ride");
    fireEvent.click(screen.getByRole("button", { name: "Next activities page" }));
    await screen.findByText("Page two is unavailable. Retry the request.");
    expect(screen.getByText("Cached Ride")).toBeDefined();
    expect(screen.getByRole("button", { name: "Next activities page" })).toBeDefined();
    failPage = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Next Ride");
    expect(screen.queryByText("Page two is unavailable. Retry the request.")).toBeNull();
  });

  it("does not label another range's cached cards as the failed selected range", async () => {
    renderLiveActivityList(async (input) => {
      if (input.weeks === 8) throw new Error("Selected range is unavailable.");
      return {
        days: [{ date: "2026-03-18", activities: [activity({ name: "Previous Range Ride" })] }],
        totalCount: 1,
        page: 0,
        pageSize: 20,
      };
    });
    await screen.findByText("Previous Range Ride");
    fireEvent.click(screen.getByRole("button", { name: /^Date range/ }));
    fireEvent.click(screen.getByText("8 weeks"));
    await screen.findByText("Selected range is unavailable.");
    expect(screen.queryByText("Previous Range Ride")).toBeNull();
  });

  it("keeps selected activity types across server pages when checking merge eligibility", () => {
    activityMocks.mockQuery = activityListQuery(
      Array.from({ length: 21 }, (_, index) =>
        activity({
          id: `ride-${index}`,
          name: `Ride ${index}`,
          activityType: index === 20 ? "running" : "cycling",
        }),
      ),
    );
    render(<ActivitiesScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    fireEvent.click(screen.getByRole("button", { name: /^Select Ride 0,/ }));
    fireEvent.click(screen.getByRole("button", { name: "Next activities page" }));
    fireEvent.click(screen.getByRole("button", { name: /^Select Ride 20,/ }));
    expect(
      screen.getByRole("button", { name: "Merge selected activities" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByText("Select activities of one type to merge.")).toBeDefined();
    expect(activityMocks.overviewInput).toEqual({ weeks: 1, endDate: expect.any(String) });
  });

  it("paginates the activity card history", () => {
    activityMocks.mockQuery = activityListQuery(
      Array.from({ length: 21 }, (_, index) =>
        activity({
          id: `activity-${index + 1}`,
          name: `Ride ${index + 1}`,
        }),
      ),
    );

    render(<ActivitiesScreen />);

    expect(screen.getByText("Ride 1")).toBeDefined();
    expect(screen.queryByText("Ride 21")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next activities page" }));

    expect(activityMocks.weekListInput).toMatchObject({ page: 1, pageSize: 20 });
    expect(screen.queryByText("Ride 1")).toBeNull();
    expect(screen.getByText("Ride 21")).toBeDefined();
  });

  it.each([1, 2])("shows %i source climbing points without inventing a route", (pointCount) => {
    activityMocks.mockQuery.data = [
      {
        date: "2026-03-18",
        activities: [
          activity({
            activityType: "climbing",
            name: "Boulder Canyon climbing",
            location: climbingSourceLocation(pointCount),
          }),
        ],
      },
    ];

    render(<ActivitiesScreen />);

    const points = screen.getAllByTestId("activity-source-point");
    expect(points).toHaveLength(pointCount);
    const markers = screen.getAllByTestId("activity-source-marker");
    expect(markers[0]?.style.left).toBe("50%");
    expect(markers[0]?.style.top).toBe("50%");
    expect(screen.queryByTestId("activity-route-path")).toBeNull();
    expect(screen.getByText("Training Stress Score")).toBeDefined();
    const row = screen.getByRole("button", { name: /Open Boulder Canyon climbing/ });
    expect(row.getAttribute("aria-label")).toContain(
      "Area location: Boulder Canyon · Mountain Project",
    );
    expect(row.getAttribute("aria-label")).not.toContain("Distance unavailable");
    if (pointCount === 2) {
      expect(Number.parseFloat(markers[1]?.style.left ?? "")).toBeCloseTo(68.36, 2);
      expect(Number.parseFloat(markers[1]?.style.top ?? "")).toBeCloseTo(34.72, 2);
      expect(row.getAttribute("aria-label")).toContain("Climb location: Second climb · OpenBeta");
    }
    fireEvent.click(row);
    expect(routerPush).toHaveBeenCalledWith("/activity/activity-1");
  });

  it("replaces a failed map snapshot with a fallback", async () => {
    activityMocks.mockQuery = activityListQuery([
      activity({
        location: recordedGpsLocation(),
        distanceMeters: 5000,
        elevationGainM: 120,
        distanceState: { status: "available" },
        elevationState: { status: "available" },
      }),
    ]);

    render(<ActivitiesScreen />);

    fireEvent(
      screen.getByTestId("activity-map-panel"),
      new CustomEvent("layout", { detail: { width: 320, height: 180 } }),
    );
    fireEvent.error(await screen.findByTestId("activity-map-preview"));

    expect(screen.getByLabelText("Activity location unavailable")).toBeDefined();
  });

  it("draws a route overlay using server-projected path points", () => {
    activityMocks.mockQuery = activityListQuery([
      activity({
        location: recordedGpsLocation({
          routePath: [
            { x: 278.54, y: 379.51 },
            { x: 292.2, y: 370.88 },
            { x: 305.85, y: 359.36 },
          ],
        }),
        distanceMeters: 5000,
        elevationGainM: 120,
        distanceState: { status: "available" },
        elevationState: { status: "available" },
      }),
    ]);

    render(<ActivitiesScreen />);

    expect(screen.getByTestId("activity-route-path").getAttribute("points")).toBe(
      "278.54,379.51 292.2,370.88 305.85,359.36",
    );
    expect(screen.getByTestId("activity-route-viewport")).toBeTruthy();
  });

  it("does not duplicate distance and elevation badges over the map", () => {
    activityMocks.mockQuery = activityListQuery([
      activity({
        location: recordedGpsLocation(),
        distanceMeters: 5000,
        elevationGainM: 120,
        distanceState: { status: "available" },
        elevationState: { status: "available" },
      }),
    ]);

    render(<ActivitiesScreen />);

    expect(screen.getAllByText("5.0 km")).toHaveLength(1);
    expect(screen.getAllByText("120 m")).toHaveLength(1);
  });

  it("renders the native preview across the responsive viewport", async () => {
    activityMocks.mockQuery = activityListQuery([
      activity({
        location: recordedGpsLocation({
          routePath: [
            { x: 250, y: 300 },
            { x: 350, y: 400 },
          ],
        }),
        distanceMeters: 5000,
        elevationGainM: 120,
        distanceState: { status: "available" },
        elevationState: { status: "available" },
      }),
    ]);

    render(<ActivitiesScreen />);

    fireEvent(
      screen.getByTestId("activity-map-panel"),
      new CustomEvent("layout", { detail: { width: 320, height: 180 } }),
    );
    const preview = await screen.findByTestId("activity-map-preview");
    fireEvent.load(preview);
    expect(screen.getByLabelText("Activity location map")).toBeTruthy();
  });

  it("shows a full-width map processing state while server map geometry is pending", () => {
    activityMocks.mockQuery.data = [
      { date: "2026-03-18", activities: [activity({ location: { kind: "processing" } })] },
    ];
    render(<ActivitiesScreen />);
    expect(screen.getByRole("progressbar", { name: "Processing map" }).textContent).toBe(
      "Processing map…",
    );
    expect(
      screen.getByRole("button", { name: /Open Trainer Ride/ }).getAttribute("aria-label"),
    ).toContain("Processing map");
  });

  it("polls pending map geometry without polling settled or absent map states", () => {
    render(<ActivitiesScreen />);
    expect(
      activityMocks.weekListOptions?.refetchInterval?.({
        state: {
          data: { days: [{ activities: [activity({ location: { kind: "processing" } })] }] },
        },
      }),
    ).toEqual(expect.any(Number));
    expect(
      activityMocks.weekListOptions?.refetchInterval?.({
        state: { data: { days: [{ activities: [activity({ location: null })] }] } },
      }),
    ).toBe(false);
    expect(activityMocks.weekListOptions?.refetchInterval?.({ state: { data: undefined } })).toBe(
      false,
    );
    const searchInterval = locationSearchQuery.mock.lastCall?.[1].refetchInterval;
    const readyPage = { activities: [activity({ location: null })] };
    const pendingPage = { activities: [activity({ location: { kind: "processing" } })] };
    expect(searchInterval?.({ state: { data: { pages: [readyPage, pendingPage] } } })).toBe(3000);
    expect(searchInterval?.({ state: { data: { pages: [readyPage] } } })).toBe(false);
    expect(searchInterval?.({ state: {} })).toBe(false);
  });

  describe("workout calendar agenda", () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(new Date("2026-11-24T15:00:00.000Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("merges a mixed this-week day with Planned and Completed labels under Workout calendar", () => {
      activityMocks.mockQuery = {
        data: [
          {
            date: "2026-11-24",
            activities: [
              activity({
                id: "ride-1",
                name: "Morning ride",
                activityType: "road_cycling",
                startedAt: "2026-11-24T15:08:00.000Z",
                source: {
                  tree: { primary: null, otherSources: [] },
                  origin: { status: "unresolved", candidateMemberActivityIds: [] },
                  primarySourceLabel: "Garmin Connect",
                  sourceCount: 1,
                  overlapSummary: null,
                },
              }),
            ],
          },
        ],
        isLoading: false,
        isError: false,
        isSuccess: true,
        error: null,
      };
      activityMocks.mockUpcomingQuery = {
        ...activityMocks.mockUpcomingQuery,
        isSuccess: true,
        data: [
          {
            date: "2026-11-24",
            workouts: [
              {
                id: "plan-1",
                providerId: "intervals.icu",
                title: "Tempo intervals",
                description: null,
                sportType: "cycling",
                startTime: "07:00",
                steps: [],
              },
            ],
          },
          {
            date: "2026-11-26",
            workouts: [
              {
                id: "plan-2",
                providerId: "intervals.icu",
                title: "Easy endurance",
                description: null,
                sportType: "cycling",
                startTime: null,
                steps: [],
              },
            ],
          },
        ],
      };

      render(<ActivitiesScreen />);

      expect(screen.getByText("Workout calendar")).toBeDefined();
      expect(screen.getByText(/Nov 23.*29, 2026/)).toBeDefined();
      expect(screen.getByLabelText(/^Date range/)).toBeDefined();
      expect(activityMocks.weekListInput).toMatchObject({
        startDate: "2026-11-23",
        endDate: "2026-11-29",
        weeks: 1,
        dateOrder: "oldest",
        page: 0,
        pageSize: 20,
      });
      expect(activityMocks.upcomingQueryInput).toEqual({
        dateRange: { startDate: "2026-11-23", endDate: "2026-11-29" },
      });
      expect(screen.getByText("Tempo intervals")).toBeDefined();
      expect(screen.getByText("Morning ride")).toBeDefined();
      expect(screen.getByText("Easy endurance")).toBeDefined();
      expect(screen.getAllByText("Planned").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Completed").length).toBeGreaterThanOrEqual(1);
      expect(screen.queryByText("Upcoming workouts")).toBeNull();
      expect(screen.getAllByText("No workouts").length).toBeGreaterThanOrEqual(1);
    });

    it("shows a future-only range without a recorded overview and keeps known sports", () => {
      if (activityMocks.mockOverviewQuery.data) {
        activityMocks.mockOverviewQuery.data.activityTypes = ["cycling", "running"];
      }
      render(<ActivitiesScreen />);
      fireEvent.click(screen.getByRole("button", { name: /^Date range/ }));
      fireEvent.click(screen.getByText("Next 90 days"));

      expect(activityMocks.weekListOptions?.enabled).toBe(false);
      expect(activityMocks.weekListInput).toMatchObject({
        startDate: "2026-11-25",
        endDate: "2027-02-22",
        dateOrder: "oldest",
      });
      expect(activityMocks.overviewOptions?.enabled).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: /^Sport/ }));
      fireEvent.click(screen.getByRole("button", { name: "Cycling" }));
      expect(activityMocks.upcomingQueryInput).toMatchObject({ activityType: "cycling" });
    });

    it("does not show empty weekday copy while a feed is still in flight", () => {
      activityMocks.mockQuery = {
        data: [{ date: "2026-11-24", activities: [activity({ name: "Morning ride" })] }],
        isLoading: false,
        isError: false,
        isSuccess: true,
        error: null,
      };
      activityMocks.mockUpcomingQuery = {
        ...activityMocks.mockUpcomingQuery,
        data: undefined,
        isLoading: true,
        isSuccess: false,
        isError: false,
        error: null,
      };

      render(<ActivitiesScreen />);

      expect(screen.getByText("Morning ride")).toBeDefined();
      expect(screen.queryByText("No workouts")).toBeNull();
      expect(screen.queryByText("No workouts in this date range.")).toBeNull();
    });

    it("shows plans when the completed feed fails before the first load", () => {
      activityMocks.mockQuery = {
        data: undefined,
        isLoading: false,
        isError: true,
        isSuccess: false,
        error: new Error("Activity history is unavailable."),
      };
      activityMocks.mockUpcomingQuery = {
        ...activityMocks.mockUpcomingQuery,
        data: [
          {
            date: "2026-11-26",
            workouts: [
              {
                id: "plan-2",
                providerId: "intervals.icu",
                title: "Easy endurance",
                description: null,
                sportType: "cycling",
                startTime: null,
                steps: [],
              },
            ],
          },
        ],
        isSuccess: true,
      };

      render(<ActivitiesScreen />);

      expect(activityMocks.upcomingQueryInput).toEqual({
        dateRange: { startDate: "2026-11-23", endDate: "2026-11-29" },
      });
      expect(screen.getByText("Easy endurance")).toBeDefined();
      expect(screen.getByText("Activity history is unavailable.")).toBeDefined();
      expect(screen.queryByText("No workouts in this date range.")).toBeNull();
    });

    it("does not mix planned rows across a date-range change", () => {
      activityMocks.mockUpcomingQuery = {
        ...activityMocks.mockUpcomingQuery,
        data: [
          {
            date: "2026-11-26",
            workouts: [
              {
                id: "this-week-plan",
                providerId: "intervals.icu",
                title: "This week plan",
                description: null,
                sportType: "cycling",
                startTime: null,
                steps: [],
              },
            ],
          },
        ],
        isSuccess: true,
      };
      render(<ActivitiesScreen />);
      expect(screen.getByText("This week plan")).toBeDefined();

      activityMocks.mockUpcomingQuery = {
        ...activityMocks.mockUpcomingQuery,
        data: [
          {
            date: "2026-10-30",
            workouts: [
              {
                id: "four-week-plan",
                providerId: "intervals.icu",
                title: "Four week plan",
                description: null,
                sportType: "cycling",
                startTime: null,
                steps: [],
              },
            ],
          },
        ],
        isSuccess: true,
      };
      fireEvent.click(screen.getByRole("button", { name: /^Date range/ }));
      fireEvent.click(screen.getByText("4 weeks"));

      expect(activityMocks.upcomingQueryInput).toEqual({
        dateRange: { startDate: "2026-10-28", endDate: "2026-11-24" },
      });
      expect(activityMocks.upcomingOptions?.placeholderData).toBeUndefined();
      expect(screen.getByText("Four week plan")).toBeDefined();
      expect(screen.queryByText("This week plan")).toBeNull();
    });

    it("keeps showing-page planned ownership while same-range paging uses placeholder data", () => {
      activityMocks.mockQuery = {
        data: [
          {
            date: "2026-11-20",
            activities: [
              activity({ id: "older", name: "Older ride", startedAt: "2026-11-20T15:00:00.000Z" }),
            ],
          },
        ],
        isLoading: false,
        isError: false,
        isSuccess: true,
        isPlaceholderData: false,
        plannedWindow: { startDate: "2026-11-20", endDate: "2026-11-24" },
        totalCount: 40,
        error: null,
      };
      activityMocks.mockUpcomingQuery = {
        ...activityMocks.mockUpcomingQuery,
        isSuccess: true,
        data: [
          {
            date: "2026-11-22",
            workouts: [
              {
                id: "owned-plan",
                providerId: "intervals.icu",
                title: "Owned page plan",
                description: null,
                sportType: "cycling",
                startTime: null,
                steps: [],
              },
            ],
          },
          {
            date: "2026-11-28",
            workouts: [
              {
                id: "outside-plan",
                providerId: "intervals.icu",
                title: "Outside page plan",
                description: null,
                sportType: "cycling",
                startTime: null,
                steps: [],
              },
            ],
          },
        ],
      };

      render(<ActivitiesScreen />);
      activityMocks.mockQuery = { ...activityMocks.mockQuery, isPlaceholderData: true };
      fireEvent.click(screen.getByRole("button", { name: "Next activities page" }));

      expect(activityMocks.weekListInput).toMatchObject({ page: 1 });
      expect(screen.getByText("Owned page plan")).toBeDefined();
      expect(screen.queryByText("Outside page plan")).toBeNull();
    });

    it("groups search, place lookup, and status failures while Next 90 days stays selected", () => {
      const searchRefetch = vi.fn();
      const placesRefetch = vi.fn();
      const processingRefetch = vi.fn();
      locationSearchQuery.mockReturnValue({
        data: undefined,
        isError: true,
        error: new Error(connectionMessage),
        isFetching: false,
        hasNextPage: false,
        refetch: searchRefetch,
      });
      placeLookupQuery.mockImplementation((_input, options) =>
        options.enabled
          ? { isError: true, error: new Error(connectionMessage), refetch: placesRefetch }
          : {},
      );
      activityMocks.mockDataHealthQuery = {
        ...activityMocks.mockDataHealthQuery,
        error: new Error(connectionMessage),
        refetch: processingRefetch,
      };

      render(<ActivitiesScreen />);
      fireEvent.click(screen.getByRole("button", { name: /^Date range/ }));
      fireEvent.click(screen.getByText("Next 90 days"));
      fireEvent.click(screen.getByRole("button", { name: "Location" }));
      fireEvent.change(screen.getByLabelText("Search activity locations"), {
        target: { value: "East Bay" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Look up a place" }));

      expect(screen.getAllByText(connectionMessage)).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(searchRefetch).toHaveBeenCalledOnce();
      expect(placesRefetch).toHaveBeenCalledOnce();
      expect(processingRefetch).toHaveBeenCalledOnce();
    });

    it("keeps completed activities when the planned feed fails", () => {
      activityMocks.mockQuery = {
        data: [{ date: "2026-11-24", activities: [activity({ name: "Morning ride" })] }],
        isLoading: false,
        isError: false,
        isSuccess: true,
        error: null,
      };
      activityMocks.mockUpcomingQuery = {
        ...activityMocks.mockUpcomingQuery,
        data: undefined,
        isError: true,
        isSuccess: false,
        error: new Error("Schedule is temporarily unavailable."),
        refetch: vi.fn(),
      };

      render(<ActivitiesScreen />);

      expect(screen.getByText("Morning ride")).toBeDefined();
      expect(screen.getByText("Schedule is temporarily unavailable.")).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(activityMocks.mockUpcomingQuery.refetch).toHaveBeenCalledOnce();
    });

    it("retains planned rows during a same-range planned refetch", () => {
      const planned = [
        {
          date: "2026-11-26",
          workouts: [
            {
              id: "plan-2",
              providerId: "intervals.icu",
              title: "Easy endurance",
              description: null,
              sportType: "cycling",
              startTime: null,
              steps: [],
            },
          ],
        },
      ];
      activityMocks.mockUpcomingQuery = {
        ...activityMocks.mockUpcomingQuery,
        data: planned,
        isSuccess: true,
        isFetching: true,
        isPlaceholderData: false,
      };

      render(<ActivitiesScreen />);

      expect(screen.getByText("Easy endurance")).toBeDefined();
      expect(activityMocks.upcomingOptions?.placeholderData).toBeUndefined();
    });

    it("shows Snapshot with the import date for a disconnected plan", () => {
      activityMocks.mockUpcomingQuery = {
        ...activityMocks.mockUpcomingQuery,
        data: [
          {
            date: "2026-11-26",
            workouts: [
              {
                id: "snap-1",
                providerId: "intervals.icu",
                title: "Easy endurance",
                description: null,
                sportType: "cycling",
                startTime: null,
                steps: [],
                snapshotImportedAt: "2026-11-20T12:00:00.000Z",
              },
            ],
          },
        ],
      };

      render(<ActivitiesScreen />);

      expect(screen.getByText(/Snapshot/)).toBeDefined();
      expect(screen.getByText(/Nov 20, 2026/)).toBeDefined();
    });
  });
});
