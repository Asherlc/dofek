/** @vitest-environment jsdom */

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ClimbingLogEntryDetail } from "../../../server/src/contracts/climbing-log-contracts.ts";
import { sourceHardware } from "../components/ActivitySourceDisclosure.fixtures.ts";
import { UnitContext } from "../lib/unitContext.ts";
import {
  detailPageActivityTitleCases,
  detailPageAvailableArete,
  detailPageCachedHrZone,
  detailPageCachedPowerZones,
  detailPageCachedRouteSuggestion,
  detailPageCachedTimedClimb,
  detailPageClimbingHeartRateContext,
  detailPageClimbingLocations,
  detailPageClimbingRouteStates,
  detailPageCorner,
  detailPageHangboardDetails,
  detailPageMetricSources,
  detailPageNullStreamPoint,
  detailPageRidgeTraverse,
  detailPageRouteBoundsPoints,
  detailPageStrengthExercises,
  detailPageSuggestedClimb,
  detailPageSummitOuting,
  detailPageUnavailablePowerZones,
  detailPageWithFirstHeartRate,
  detailSourceTree,
} from "./ActivityDetailPage.fixtures.ts";
import {
  activityRouteParams,
  capturedEvents,
  capturedOptions,
  maps,
  markers,
  mockActivity,
  mockActivityByIdUseQuery,
  mockActivityInvalidate,
  mockAttachEntryMutate,
  mockAttachShouldFail,
  mockClimbingEntriesInvalidate,
  mockClimbingEntriesUseQuery,
  mockEntrySuggestionsUseQuery,
  mockHangboardDetailsUseQuery,
  mockHardwareUseQuery,
  mockHeartRateContextQuery,
  mockHrZonesUseQuery,
  mockImagesUseQuery,
  mockMetricSourcesUseQuery,
  mockPowerWorkUseQuery,
  mockPowerZonesUseQuery,
  mockRestoreProviderAbsentMutate,
  mockRestoreResult,
  mockRestoreStatus,
  mockRouteUseQuery,
  mockStreamPoints,
  mockStreamUseQuery,
  mockStrengthExercisesUseQuery,
  queryResult,
  renderWithUnits,
  resetActivityDetailPageMocks,
  setCyclingPowerActivity,
  setCyclingPowerZoneResult,
} from "./ActivityDetailPage.test-helpers.tsx";

function getQueryEnabledFlag(value: unknown): boolean | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const enabled = Reflect.get(value, "enabled");
  return typeof enabled === "boolean" ? enabled : undefined;
}

let ActivityDetailPage: ComponentType;
beforeAll(async () => {
  ActivityDetailPage = (await import("./ActivityDetailPage.tsx")).ActivityDetailPage;
});

afterEach(resetActivityDetailPageMocks);

describe("ActivityDetailPage", () => {
  it("uses the server's surrounding HR observations for a climbing activity", async () => {
    mockActivityByIdUseQuery.mockReturnValue(
      queryResult({ ...mockActivity, activityType: "climbing" }),
    );
    mockHeartRateContextQuery.mockReturnValue(queryResult(detailPageClimbingHeartRateContext));
    renderWithUnits(<ActivityDetailPage />);
    await waitFor(() =>
      expect(
        capturedOptions.some(
          (option) =>
            Array.isArray(option.series) &&
            option.series.some(
              (series) => series.name === "Heart Rate" && series.data?.[0]?.value?.[1] === 91,
            ),
        ),
      ).toBe(true),
    );
  });

  it.each(detailPageActivityTitleCases)(
    "uses the readable title and breadcrumb for $activityType",
    async ({ activityType, primaryActivityType, title, occurrences }) => {
      mockActivityByIdUseQuery.mockReturnValue(
        queryResult({ ...mockActivity, name: null, activityType, primaryActivityType }),
      );
      renderWithUnits(<ActivityDetailPage />);
      expect(screen.getByRole("heading", { level: 1, name: title })).toBeDefined();
      expect(screen.getAllByText(title)).toHaveLength(occurrences);
      if (activityType === "walking") expect(screen.getByText("Walking")).toBeDefined();
    },
  );

  it("requests downloaded photos for the current activity with signed-link renewal", async () => {
    renderWithUnits(<ActivityDetailPage />);
    expect(mockImagesUseQuery).toHaveBeenCalledWith(
      { id: "test-123" },
      expect.objectContaining({ refetchOnMount: "always", refetchOnWindowFocus: true }),
    );
  });
  it("shows a loading skeleton before activity details resolve", async () => {
    mockActivityByIdUseQuery.mockReturnValue(
      queryResult<typeof mockActivity>(undefined, { isLoading: true }),
    );
    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByTestId("chart-loading-skeleton")).toBeTruthy();
    expect(screen.queryByText("Activity not found")).toBeNull();
  });

  it("shows the primary server error instead of reporting a missing activity", async () => {
    mockActivityByIdUseQuery.mockReturnValue(
      queryResult<typeof mockActivity>(undefined, {
        error: Object.assign(new Error("Activity database is unavailable."), {
          data: { code: "INTERNAL_SERVER_ERROR" },
        }),
        isError: true,
      }),
    );

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByText("Activity database is unavailable.")).toBeDefined();
    expect(screen.queryByText("Activity not found")).toBeNull();
  });

  it("keeps activity details visible while reporting a background refresh failure", async () => {
    mockActivityByIdUseQuery.mockReturnValue(
      queryResult(mockActivity, {
        error: new Error("Activity details refresh failed."),
        isError: true,
      }),
    );

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByRole("heading", { name: "Morning Run" })).toBeDefined();
    expect(screen.getByText("Activity details refresh failed.")).toBeDefined();
  });

  it("uses the not-found state only for a NOT_FOUND response", async () => {
    mockActivityByIdUseQuery.mockReturnValue(
      queryResult<typeof mockActivity>(undefined, {
        error: Object.assign(new Error("Activity not found"), { data: { code: "NOT_FOUND" } }),
        isError: true,
      }),
    );

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByText("Activity not found")).toBeDefined();
  });

  it("shows a sensor section error when the stream query fails without data", async () => {
    mockStreamUseQuery.mockReturnValue(
      queryResult<typeof mockStreamPoints>(undefined, {
        error: new Error("Sensor stream is unavailable."),
        isError: true,
      }),
    );

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByText("Sensor stream is unavailable.")).toBeDefined();
  });

  it("keeps cached stream charts visible during a background refresh error", async () => {
    mockStreamUseQuery.mockReturnValue(
      queryResult(mockStreamPoints, {
        error: new Error("Sensor stream refresh failed."),
        isError: true,
      }),
    );

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByText("Performance")).toBeDefined();
    expect(screen.getByText("Sensor stream refresh failed.")).toBeDefined();
  });

  it("renders loading placeholders for cached sensor charts during an active fetch", async () => {
    mockStreamUseQuery.mockReturnValue(queryResult(mockStreamPoints, { isLoading: true }));

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getAllByTestId("chart-loading-skeleton")).toHaveLength(2);
  });
  it("does not bind chart hover events when stream points have no GPS coordinates", async () => {
    mockStreamUseQuery.mockReturnValue(
      queryResult(mockStreamPoints.map((point) => ({ ...point, lat: null, lng: null }))),
    );
    mockRouteUseQuery.mockReturnValue(queryResult({ status: "ready", points: [] }));
    renderWithUnits(<ActivityDetailPage />);

    expect(screen.queryByText("Route Map")).toBeNull();
    const metricEvents = capturedEvents.find((events) => events.legendselectchanged != null);
    expect(metricEvents?.updateAxisPointer).toBeUndefined();
  });

  it("shows route processing instead of drawing cached partial GPS", async () => {
    mockRouteUseQuery.mockReturnValue(queryResult({ status: "processing" }));

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByText("Processing route map…")).toBeDefined();
    expect(screen.getByRole("status").parentElement).toHaveClass("h-[400px]");
    expect(screen.getByRole("status").querySelector(".animate-spin")).not.toBeNull();
    expect(maps).toHaveLength(0);
    const routeOptions = mockRouteUseQuery.mock.calls[0]?.[1];
    if (
      !routeOptions ||
      typeof routeOptions !== "object" ||
      !("refetchInterval" in routeOptions) ||
      typeof routeOptions.refetchInterval !== "function"
    ) {
      throw new Error("Expected activity route polling option");
    }
    expect(routeOptions.refetchInterval({ state: { data: { status: "processing" } } })).toBe(3000);
    expect(routeOptions.refetchInterval({ state: { data: { status: "ready" } } })).toBe(false);
  });
  it.each(detailPageClimbingRouteStates)(
    "shows canonical climbing locations when the recorded route is %s",
    async (state) => {
      mockActivityByIdUseQuery.mockReturnValue(
        queryResult({ ...mockActivity, activityType: "climbing" }),
      );
      mockRouteUseQuery.mockReturnValue(
        queryResult(
          state.startsWith("cached")
            ? { status: "ready", points: [{ lat: 7, lng: 8 }] }
            : { status: state === "processing" ? "processing" : "unavailable" },
          {
            error: state.endsWith("error") ? new Error("Recorded route refresh failed") : null,
            isLoading: state.endsWith("loading"),
          },
        ),
      );
      mockClimbingEntriesUseQuery.mockReturnValue(
        queryResult(detailPageClimbingLocations.entries, {
          error: new Error("Climbing refresh failed"),
          isError: true,
        }),
      );
      mockEntrySuggestionsUseQuery.mockReturnValue(
        queryResult(detailPageClimbingLocations.suggestions),
      );
      renderWithUnits(<ActivityDetailPage />);

      expect(screen.getAllByRole("region", { name: "Climbing locations" })).toHaveLength(1);
      expect(screen.getByText("Climbing refresh failed")).toBeDefined();
      const climbPoint = await screen.findByRole("button", {
        name: "Located climb · Climb location: Located climb · Mountain Project",
      });
      const createdMaps = maps.length;
      act(() => climbPoint.focus());
      fireEvent.keyDown(climbPoint, { key: "Enter" });
      expect(screen.getByRole("button", { name: "Select entry 2, Located climb" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      const details = screen.getByRole("button", {
        name: "Log details for entry 2, Located climb",
      });
      details.focus();
      fireEvent.click(details);
      const dialog = await screen.findByRole("dialog");
      expect(
        within(dialog).getByRole("region", { name: "Climbing log details" }),
      ).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
      await waitFor(() => expect(details).toHaveFocus());
      fireEvent.click(details);
      expect(
        within(await screen.findByRole("dialog")).getByRole("region", {
          name: "Climbing log details",
        }),
      ).toBeInTheDocument();
      expect(maps).toHaveLength(createdMaps);
      if (state.startsWith("cached")) {
        await waitFor(() =>
          expect(
            markers.some((marker) => marker.coordinates?.[0] === 8 && marker.coordinates[1] === 7),
          ).toBe(true),
        );
      }
      if (state.endsWith("error")) {
        expect(screen.getByText("Recorded route refresh failed")).toBeDefined();
      }
    },
  );
  it("fits a cycling route to its own points when climbing suggestions remain cached", async () => {
    mockActivityByIdUseQuery.mockReturnValue(
      queryResult({ ...mockActivity, activityType: "cycling" }),
    );
    mockRouteUseQuery.mockReturnValue(
      queryResult({
        status: "ready",
        points: detailPageRouteBoundsPoints,
      }),
    );
    mockEntrySuggestionsUseQuery.mockReturnValue(queryResult([detailPageCachedRouteSuggestion]));
    renderWithUnits(<ActivityDetailPage />);
    await waitFor(() => expect(maps).toHaveLength(1));
    expect(maps[0]?.fitBounds).toHaveBeenCalledWith(
      [
        [8, 7],
        [10, 9],
      ],
      { padding: 30, duration: 0 },
    );
  });

  it("shows a loading state before route freshness is known", async () => {
    mockRouteUseQuery.mockReturnValue(queryResult({ status: "unavailable" }, { isLoading: true }));

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByText("Loading route map…")).toBeDefined();
    expect(maps).toHaveLength(0);
  });

  it("shows a route-specific error instead of drawing cached partial GPS", async () => {
    mockRouteUseQuery.mockReturnValue(
      queryResult({ status: "unavailable" }, { error: new Error("Route freshness query failed.") }),
    );

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByText("Route freshness query failed.")).toBeDefined();
    expect(maps).toHaveLength(0);
  });

  it("draws the ready route endpoint even when the cached sensor stream ends early", async () => {
    mockRouteUseQuery.mockReturnValue(
      queryResult({
        status: "ready",
        points: [
          { lat: 1, lng: 1 },
          { lat: 9, lng: 9 },
        ],
      }),
    );

    renderWithUnits(<ActivityDetailPage />);

    await waitFor(() =>
      expect(
        markers.some((marker) => marker.coordinates?.[0] === 9 && marker.coordinates[1] === 9),
      ).toBe(true),
    );
  });

  it("creates a route hover marker from valid chart pointer events", async () => {
    renderWithUnits(<ActivityDetailPage />);

    await waitFor(() => expect(maps).toHaveLength(1));
    await waitFor(() => expect(markers).toHaveLength(2));
    const metricEvents = capturedEvents.find((events) => events.updateAxisPointer != null);
    if (!metricEvents?.updateAxisPointer || !metricEvents.globalout) {
      throw new Error("Metrics chart pointer events were not registered");
    }

    metricEvents.updateAxisPointer({
      axesInfo: [{ value: Date.parse(mockStreamPoints[0]?.recordedAt ?? "") }],
    });
    await waitFor(() => expect(markers).toHaveLength(3));

    metricEvents.updateAxisPointer({});
    metricEvents.updateAxisPointer({ axesInfo: [] });
    metricEvents.updateAxisPointer({ axesInfo: [{ value: -1 }] });
    metricEvents.updateAxisPointer({
      axesInfo: [{ value: Date.parse(mockStreamPoints.at(-1)?.recordedAt ?? "") + 1 }],
    });

    expect(markers).toHaveLength(3);

    metricEvents.updateAxisPointer({
      axesInfo: [{ value: Date.parse(mockStreamPoints[1]?.recordedAt ?? "") }],
    });
    await waitFor(() => expect(markers).toHaveLength(4));
    metricEvents.globalout();
  });

  it.each([
    { stream: "empty", points: [], cyclingWithoutPower: false },
    {
      stream: "all-null",
      points: [detailPageNullStreamPoint],
      cyclingWithoutPower: true,
    },
  ])("hides sensor sections for an $stream stream", async ({ points, cyclingWithoutPower }) => {
    if (cyclingWithoutPower) Object.assign(mockActivity, { activityType: "cycling" });
    mockStreamUseQuery.mockReturnValue(queryResult(points));
    mockRouteUseQuery.mockReturnValue(queryResult({ status: "unavailable" }));
    renderWithUnits(<ActivityDetailPage />);

    expect(screen.queryByText("Route Map")).toBeNull();
    expect(screen.queryByText("Performance")).toBeNull();
    expect(screen.queryByText("Elevation Profile")).toBeNull();
    expect(screen.queryByText("Heart Rate Zones")).toBeNull();
    if (cyclingWithoutPower) expect(screen.queryByRole("link", { name: "Set FTP" })).toBeNull();
  });

  it("shows a strength exercise section error", async () => {
    Object.assign(mockActivity, { activityType: "strength" });
    mockStrengthExercisesUseQuery.mockReturnValue(
      queryResult<typeof detailPageStrengthExercises>(undefined, {
        error: new Error("Strength exercises are unavailable."),
        isError: true,
      }),
    );

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByText("Strength exercises are unavailable.")).toBeDefined();
  });

  it("shows a loading exercise section while a strength workout is still resolving", async () => {
    Object.assign(mockActivity, { activityType: "strength" });
    mockStrengthExercisesUseQuery.mockReturnValue(
      queryResult<typeof detailPageStrengthExercises>(undefined, { isLoading: true }),
    );

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByText("Exercises")).toBeDefined();
  });

  it("keeps cached strength exercises visible while reporting a refresh failure", async () => {
    Object.assign(mockActivity, { activityType: "strength" });
    mockStrengthExercisesUseQuery.mockReturnValue(
      queryResult(detailPageStrengthExercises, {
        error: new Error("Strength exercise refresh failed."),
        isError: true,
      }),
    );

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByText("Pull-up")).toBeDefined();
    expect(screen.getByText("Strength exercise refresh failed.")).toBeDefined();
  });

  it("clears the route hover marker for an intermittent GPS sample", async () => {
    mockStreamUseQuery.mockReturnValue(
      queryResult(
        mockStreamPoints.map((point, index) =>
          index === 1 ? { ...point, lat: null, lng: null, speed: null } : point,
        ),
      ),
    );

    renderWithUnits(<ActivityDetailPage />);

    await waitFor(() => expect(maps).toHaveLength(1));
    const metricEvents = capturedEvents.find((events) => events.updateAxisPointer != null);
    if (!metricEvents?.updateAxisPointer) {
      throw new Error("Metrics chart pointer events were not registered");
    }

    metricEvents.updateAxisPointer({
      axesInfo: [{ value: Date.parse(mockStreamPoints[1]?.recordedAt ?? "") }],
    });

    expect(markers).toHaveLength(2);
  });
  it("shows a climbing-entry query failure for a climbing activity", async () => {
    mockActivityByIdUseQuery.mockReturnValue(
      queryResult({ ...mockActivity, activityType: "climbing", name: "Morning Climb" }),
    );
    mockClimbingEntriesUseQuery.mockReturnValue(
      queryResult<ClimbingLogEntryDetail[]>(undefined, {
        error: new Error("Climbing entries are unavailable."),
        isError: true,
      }),
    );
    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByText("Climbs")).toBeDefined();
    expect(screen.getByText("Climbing entries are unavailable.")).toBeDefined();
  });

  it("shows a power zone section error", async () => {
    setCyclingPowerZoneResult(undefined, {
      error: new Error("Power zones are unavailable."),
      isError: true,
    });

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByText("Power zones are unavailable.")).toBeDefined();
    expect(screen.queryByRole("link", { name: "Set FTP" })).toBeNull();
  });

  it("shows Set FTP for a power activity with no applicable FTP", async () => {
    setCyclingPowerZoneResult(detailPageUnavailablePowerZones);
    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByText("No FTP setting applies to this activity.")).toBeDefined();
    const setFtpLink = screen.getByRole("link", { name: "Set FTP" });
    expect(setFtpLink.getAttribute("href")).toBe("/settings");
    expect(setFtpLink.getAttribute("data-search")).toBe(
      JSON.stringify({ tab: "models-units", section: "cycling-ftp", date: "2026-03-18" }),
    );
  });

  it("hides the missing-FTP explanation and link while cached null FTP is refetching", async () => {
    setCyclingPowerZoneResult(detailPageUnavailablePowerZones, { isFetching: true });
    renderWithUnits(<ActivityDetailPage />);

    expect(screen.queryByText("No FTP setting applies to this activity.")).toBeNull();
    expect(screen.queryByRole("link", { name: "Set FTP" })).toBeNull();
  });

  it("shows Set FTP for zero-watt rides even with incomplete normalized-power coverage", async () => {
    mockPowerWorkUseQuery.mockReturnValue(
      queryResult({ workKilojoules: null, coverage: { coveredSeconds: 30, coveragePct: 1 } }),
    );
    setCyclingPowerZoneResult(detailPageUnavailablePowerZones);
    setCyclingPowerActivity(0);
    Object.assign(mockActivity, {
      avgPower: 0,
      avgPowerState: { status: "available" },
      maxPower: 0,
      maxPowerState: { status: "available" },
    });
    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByRole("link", { name: "Set FTP" }).getAttribute("data-search")).toContain(
      "2026-03-18",
    );
  });

  it("shows a compact Running Form subsection in Performance without an empty metrics chart", () => {
    mockActivityByIdUseQuery.mockReturnValue(
      queryResult({
        ...mockActivity,
        runningForm: {
          cadence: null,
          cadenceBasis: "unknown",
          cadenceObservedSeconds: null,
          cadenceCoveragePercent: null,
          strideLengthMeters: null,
          stanceTimeMs: 240,
          verticalOscillationMm: null,
        },
      }),
    );
    mockStreamUseQuery.mockReturnValue(queryResult<typeof mockStreamPoints>([]));

    renderWithUnits(<ActivityDetailPage />);

    const performance = screen.getByRole("heading", { name: "Performance" }).closest("section");
    if (!performance) throw new Error("Performance section is missing");
    within(performance).getByRole("heading", { name: "Running Form" });
    expect(within(performance).getByText("Ground contact time")).toBeTruthy();
    expect(within(performance).getByText("240 ms")).toBeTruthy();
    expect(within(performance).queryByText("Cadence")).toBeNull();
    expect(within(performance).queryByText(/km|mi/)).toBeNull();
    expect(capturedOptions).toHaveLength(0);
  });

  it("shows cadence coverage in Running Form without a duplicate header cadence", () => {
    mockActivityByIdUseQuery.mockReturnValue(
      queryResult({
        ...mockActivity,
        avgCadence: 170,
        avgCadenceState: { status: "available" },
        runningForm: {
          cadence: 170,
          cadenceBasis: "step_intervals",
          cadenceObservedSeconds: 2400,
          cadenceCoveragePercent: 92,
          strideLengthMeters: null,
          stanceTimeMs: null,
          verticalOscillationMm: null,
        },
      }),
    );

    renderWithUnits(<ActivityDetailPage />);

    const heading = screen.getByRole("heading", { name: "Running Form" });
    const section = heading.closest("section");
    if (!section) throw new Error("Running Form section is missing");
    expect(within(section).getByText("170 spm")).toBeTruthy();
    expect(within(section).getByText("Steps · 92% coverage")).toBeTruthy();
    expect(screen.queryByText(/Avg Cadence/)).toBeNull();
    expect(screen.queryByText("170 steps/min")).toBeNull();
  });

  it("keeps multi-trace chart controls when the run also has form readings", () => {
    mockActivityByIdUseQuery.mockReturnValue(
      queryResult({
        ...mockActivity,
        runningForm: {
          cadence: 170,
          cadenceBasis: "step_intervals",
          cadenceObservedSeconds: 2400,
          cadenceCoveragePercent: 92,
          strideLengthMeters: null,
          stanceTimeMs: null,
          verticalOscillationMm: null,
        },
      }),
    );
    mockMetricSourcesUseQuery.mockReturnValue(
      queryResult(detailPageMetricSources.filter((source) => source.key === "heartRate")),
    );

    renderWithUnits(<ActivityDetailPage />);

    const performance = screen.getByRole("heading", { name: "Performance" }).closest("section");
    if (!performance) throw new Error("Performance section is missing");
    expect(within(performance).getByText("Chart controls")).toBeTruthy();
    within(performance).getByRole("heading", { name: "Running Form" });
    expect(within(performance).getByText("170 spm")).toBeTruthy();
  });

  it("does not reserve an empty metrics status slot outside an active update", () => {
    mockMetricSourcesUseQuery.mockReturnValue(
      queryResult(detailPageMetricSources.filter((source) => source.key === "power")),
    );
    renderWithUnits(<ActivityDetailPage />);

    const performance = screen.getByRole("heading", { name: "Performance" }).closest("section");
    if (!performance) throw new Error("Performance section is missing");
    const emptyStatus = Array.from(performance.querySelectorAll('[role="status"]')).find(
      (node) => node.textContent === "",
    );
    expect(emptyStatus).toBeUndefined();
    expect(screen.queryByText("Updating metrics…")).toBeNull();
  });

  it("does not show a transient power zone section before a nullable result resolves", async () => {
    setCyclingPowerZoneResult(undefined, { isLoading: true });

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.queryByText("Power Zones")).toBeNull();
    expect(screen.queryByRole("link", { name: "Set FTP" })).toBeNull();
  });
  it.each([
    { isFetching: true, error: null },
    { isFetching: false, error: null },
    { isFetching: false, error: new Error("Power samples are unavailable. Retry this activity.") },
  ])(
    "keeps the work state visible during fetching and refresh errors (%s)",
    async ({ isFetching, error }) => {
      mockActivityByIdUseQuery.mockReturnValue(
        queryResult({ ...mockActivity, activityType: "cycling" }),
      );
      mockMetricSourcesUseQuery.mockReturnValue(
        queryResult(detailPageMetricSources.filter((source) => source.key === "power")),
      );
      const workState = {
        data: { workKilojoules: 478, coverage: { coveredSeconds: 2700, coveragePct: 100 } },
        error,
        isError: error !== null,
        isLoading: false,
        isFetching,
      };
      mockPowerWorkUseQuery.mockReturnValue(workState);
      const { rerender } = renderWithUnits(<ActivityDetailPage />);
      expect(screen.getByText("478 kJ")).toBeVisible();
      if (error) expect(screen.getByText(error.message)).toBeVisible();
      if (!isFetching) expect(screen.queryByText("Updating metrics…")).toBeNull();
      else {
        const status = screen.getByText("Updating metrics…");
        workState.isFetching = false;
        rerender(
          <UnitContext.Provider value={{ unitSystem: "metric", setUnitSystem: () => {} }}>
            <ActivityDetailPage />
          </UnitContext.Provider>,
        );
        expect(status).not.toBeInTheDocument();
        expect(screen.queryByText("Updating metrics…")).toBeNull();
        expect(screen.getByText("478 kJ")).toBeVisible();
      }
    },
  );

  describe("provider tombstone status", () => {
    it("keeps restore completion tracking mounted after PostgreSQL makes the activity visible", async () => {
      mockActivity.providerAbsentAt = "2026-03-05T14:30:00.000Z";
      mockRestoreResult.mockReturnValue({ analyticsJobId: "restore-job-1" });
      mockRestoreStatus.mockReturnValue({ data: { status: "pending", error: null }, error: null });
      const { rerender } = renderWithUnits(<ActivityDetailPage />);
      mockActivity.providerAbsentAt = null;
      rerender(
        <UnitContext.Provider value={{ unitSystem: "metric", setUnitSystem: () => {} }}>
          <ActivityDetailPage />
        </UnitContext.Provider>,
      );
      expect(screen.getByText("Refreshing restored activity charts…")).toBeDefined();
      const invalidations = mockActivityInvalidate.mock.calls.length;
      mockRestoreStatus.mockReturnValue({
        data: { status: "completed", error: null },
        error: null,
      });
      rerender(
        <UnitContext.Provider value={{ unitSystem: "metric", setUnitSystem: () => {} }}>
          <ActivityDetailPage />
        </UnitContext.Provider>,
      );
      await waitFor(() => expect(mockActivityInvalidate).toHaveBeenCalledTimes(invalidations + 1));
    });

    it("restores the canonical activity while refreshing detail cached under its route alias", async () => {
      activityRouteParams.id = "legacy-member-alias";
      mockActivity.providerAbsentAt = "2026-03-05T14:30:00.000Z";
      mockActivity.id = "canonical-group-id";
      mockActivity.providerId = "strava";

      renderWithUnits(<ActivityDetailPage />);

      fireEvent.click(screen.getByRole("button", { name: "Restore activity" }));

      expect(mockRestoreProviderAbsentMutate).toHaveBeenCalledWith({ ids: ["canonical-group-id"] });
      expect(mockActivityInvalidate).toHaveBeenCalledWith();
    });
  });

  it("keeps the HR source picker available to recover from a failed source switch", async () => {
    const previousPoints = detailPageWithFirstHeartRate(mockStreamPoints, 177);
    const recoveredPoints = detailPageWithFirstHeartRate(previousPoints, 121);
    let requestState: "placeholder" | "error" = "placeholder";
    mockMetricSourcesUseQuery.mockReturnValue(queryResult(detailPageMetricSources));
    mockStreamUseQuery.mockImplementation((input?: unknown) => {
      const selected =
        typeof input === "object" && input !== null && "sources" in input
          ? input.sources
          : undefined;
      const heartRateSource =
        typeof selected === "object" && selected !== null && "heartRate" in selected
          ? selected.heartRate
          : undefined;
      if (heartRateSource === "hr-b") {
        return requestState === "placeholder"
          ? queryResult(previousPoints, { isPlaceholderData: true, isFetching: true })
          : queryResult<typeof mockStreamPoints>(undefined, {
              error: new Error("Garmin samples could not be read"),
              isError: true,
            });
      }
      return queryResult(
        heartRateSource === "hr-a" && requestState === "error" ? recoveredPoints : previousPoints,
      );
    });
    const view = renderWithUnits(<ActivityDetailPage />);
    expect(screen.getByRole("button", { name: "Heart Rate source: Heart rate A" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Heart Rate source:/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Heart rate B" }));
    expect(screen.getByRole("button", { name: "Heart Rate source: Heart rate B" })).toBeVisible();
    expect(screen.getByText("Showing previous readings from Heart rate A")).toBeVisible();
    const series = [...capturedOptions]
      .reverse()
      .find(
        (candidate) =>
          Array.isArray(candidate.series) &&
          candidate.series.some(
            (item) =>
              typeof item === "object" &&
              item !== null &&
              "name" in item &&
              item.name === "Heart Rate",
          ),
      )?.series;
    if (!Array.isArray(series)) throw new Error("Expected metrics chart series");
    const heartRate = series.find(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && Reflect.get(item, "name") === "Heart Rate",
    );
    if (!heartRate || !Array.isArray(heartRate.data)) throw new Error("Expected HR samples");
    expect(heartRate.data).toContainEqual(
      expect.objectContaining({ value: [Date.parse(previousPoints[0]?.recordedAt ?? ""), 177] }),
    );

    requestState = "error";
    view.rerender(
      <UnitContext.Provider value={{ unitSystem: "metric", setUnitSystem: () => {} }}>
        <ActivityDetailPage />
      </UnitContext.Provider>,
    );
    expect(await screen.findByText("Garmin samples could not be read")).toBeVisible();
    expect(screen.queryByText("No samples for the selected sources.")).toBeNull();
    expect(screen.getByRole("button", { name: "Heart Rate source: Heart rate B" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Heart Rate source:/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Heart rate A" }));
    expect(screen.getByRole("button", { name: "Heart Rate source: Heart rate A" })).toBeVisible();
    expect(screen.queryByText("Showing previous readings from Heart rate A")).toBeNull();
    expect(JSON.stringify(capturedOptions)).toContain(
      `[${Date.parse(recoveredPoints[0]?.recordedAt ?? "")},121]`,
    );
  });

  describe("source tree", () => {
    it("opens the queried lineage with its reported recording", async () => {
      mockActivityByIdUseQuery.mockReturnValue(
        queryResult({ ...mockActivity, sourceTree: detailSourceTree }),
      );
      mockHardwareUseQuery.mockReturnValue({
        data: sourceHardware,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });
      renderWithUnits(<ActivityDetailPage />);
      const trigger = screen.getByRole("button", { name: "Garmin Edge 530 Lineage" });
      fireEvent.click(trigger);
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByRole("link", { name: "Garmin Edge 530" })).toBeVisible();
      expect(screen.getByRole("heading", { name: "Original" })).toBeVisible();
    });

    describe("strength exercise query gating", () => {
      it.each([
        { activityType: "running", enabled: false },
        { activityType: "strength_training", enabled: false },
        { activityType: "strength", enabled: true },
      ])(
        "uses canonical strength query gate for $activityType",
        async ({ activityType, enabled }) => {
          Object.assign(mockActivity, { activityType });
          renderWithUnits(<ActivityDetailPage />);
          expect(getQueryEnabledFlag(mockStrengthExercisesUseQuery.mock.calls[0]?.[1])).toBe(
            enabled,
          );
        },
      );
    });

    describe("Hangboarding detail query gating", () => {
      it("disables Hangboarding details for non-Hangboarding activities", async () => {
        renderWithUnits(<ActivityDetailPage />);

        expect(getQueryEnabledFlag(mockHangboardDetailsUseQuery.mock.calls[0]?.[1])).toBe(false);
      });

      it("enables Hangboarding details and uses the Hangboarding label", async () => {
        Object.assign(mockActivity, { activityType: "hangboard", name: "Repeaters" });
        mockHangboardDetailsUseQuery.mockReturnValue(queryResult(detailPageHangboardDetails));

        renderWithUnits(<ActivityDetailPage />);

        expect(getQueryEnabledFlag(mockHangboardDetailsUseQuery.mock.calls[0]?.[1])).toBe(true);
        expect(screen.getAllByText("Hangboarding").length).toBeGreaterThanOrEqual(2);
      });
    });

    describe("climbing entries", () => {
      it.each(["hiking", "running", "cycling", "strength", "hangboard"])(
        "hides climbs and disables climbing queries for %s even with cached logs",
        async (activityType) => {
          mockActivityByIdUseQuery.mockReturnValue(queryResult({ ...mockActivity, activityType }));
          mockClimbingEntriesUseQuery.mockReturnValue(queryResult([detailPageCachedTimedClimb]));
          mockEntrySuggestionsUseQuery.mockReturnValue(queryResult([detailPageSuggestedClimb]));
          renderWithUnits(<ActivityDetailPage />);
          expect(screen.queryByRole("heading", { name: "Climbs" })).not.toBeInTheDocument();
          expect(screen.queryByText("Cached climb")).not.toBeInTheDocument();
          expect(screen.queryByText(/Cached timed climb/)).not.toBeInTheDocument();
          expect(screen.queryByText("Suggested climb")).not.toBeInTheDocument();
          expect(getQueryEnabledFlag(mockClimbingEntriesUseQuery.mock.calls[0]?.[1])).toBe(false);
          expect(getQueryEnabledFlag(mockEntrySuggestionsUseQuery.mock.calls[0]?.[1])).toBe(false);
        },
      );

      it("keeps cached climbing records visible when both refreshes fail", async () => {
        Object.assign(mockActivity, { activityType: "climbing" });
        mockClimbingEntriesUseQuery.mockReturnValue(
          queryResult([detailPageSummitOuting], {
            error: new Error("Log refresh failed"),
            isError: true,
          }),
        );
        mockEntrySuggestionsUseQuery.mockReturnValue(
          queryResult([detailPageRidgeTraverse], {
            error: new Error("Suggestions refresh failed"),
          }),
        );
        renderWithUnits(<ActivityDetailPage />);
        expect(getQueryEnabledFlag(mockClimbingEntriesUseQuery.mock.calls[0]?.[1])).toBe(true);
        expect(screen.getByText("Summit outing")).toBeInTheDocument();
        expect(screen.getByText("Ridge traverse")).toBeInTheDocument();
        expect(screen.getByText("Log refresh failed")).toBeInTheDocument();
        expect(screen.getByText("Suggestions refresh failed")).toBeInTheDocument();
        expect(
          screen.getByRole("button", { name: "Attach entry 2, Ridge traverse to this activity" }),
        ).toBeEnabled();
      });
      it.each([false, true])(
        "keeps a single loading state while attached climbs resolve (suggestions pending: %s)",
        async (suggestionsPending) => {
          Object.assign(mockActivity, { activityType: "climbing", name: "Morning Rock Climb" });
          mockClimbingEntriesUseQuery.mockReturnValue(
            queryResult<ClimbingLogEntryDetail[]>(undefined, { isLoading: true }),
          );
          if (suggestionsPending)
            mockEntrySuggestionsUseQuery.mockReturnValue(
              queryResult<ClimbingLogEntryDetail[]>(undefined, { isLoading: true }),
            );
          const view = renderWithUnits(<ActivityDetailPage />);
          const climbsSection = screen.getByRole("heading", { name: "Climbs" }).closest("section");
          if (!climbsSection) throw new Error("Expected a climbs section");
          expect(
            within(climbsSection).queryByText("No unattached climbing logs for this day."),
          ).toBeNull();
          expect(within(climbsSection).getAllByRole("status")).toHaveLength(1);
          expect(within(climbsSection).queryByText("Loading climbing logs...")).toBeNull();
          if (!suggestionsPending) {
            mockClimbingEntriesUseQuery.mockReturnValue(queryResult([]));
            view.rerender(
              <UnitContext.Provider value={{ unitSystem: "metric", setUnitSystem: () => {} }}>
                <ActivityDetailPage />
              </UnitContext.Provider>,
            );
            expect(
              within(climbsSection).getByText("No unattached climbing logs for this day."),
            ).toBeInTheDocument();
          }
        },
      );
      it.each([
        { state: "loading", error: null, isLoading: true },
        { state: "paused", error: null, isLoading: false },
        {
          state: "unavailable",
          error: new Error("Attached climbs are unavailable. Refresh to try again."),
          isLoading: false,
        },
      ])(
        "keeps suggestions actionable when attached climbs are $state",
        async ({ error, isLoading }) => {
          Object.assign(mockActivity, { activityType: "climbing", name: "Morning Rock Climb" });
          mockClimbingEntriesUseQuery.mockReturnValue({
            data: undefined,
            error,
            isError: error !== null,
            isLoading,
          });
          mockEntrySuggestionsUseQuery.mockReturnValue(queryResult([detailPageAvailableArete]));

          renderWithUnits(<ActivityDetailPage />);
          const climbsSection = screen.getByRole("heading", { name: "Climbs" }).closest("section");
          if (!climbsSection) throw new Error("Expected a climbs section");
          expect(within(climbsSection).getByText("Available Arete")).toBeInTheDocument();
          if (error) expect(within(climbsSection).getByText(error.message)).toBeInTheDocument();
          const attachButton = within(climbsSection).getByRole("button", {
            name: "Attach entry 1, Available Arete to this activity",
          });
          expect(attachButton).toBeEnabled();
          fireEvent.click(attachButton);
          expect(mockAttachEntryMutate).toHaveBeenCalledWith({
            activityId: "test-123",
            climbingLogEntryId: "available-tick",
          });
          await waitFor(() =>
            expect(mockClimbingEntriesInvalidate).toHaveBeenCalledWith({
              activityId: "test-123",
              responseVersion: 5,
            }),
          );
        },
      );

      it("shows the server error when attaching a climbing entry fails", async () => {
        Object.assign(mockActivity, { activityType: "climbing", name: "Morning Rock Climb" });
        mockAttachShouldFail.mockReturnValue(true);
        mockEntrySuggestionsUseQuery.mockReturnValue(queryResult([detailPageCorner]));

        renderWithUnits(<ActivityDetailPage />);

        fireEvent.click(
          screen.getByRole("button", { name: "Attach entry 1, The Corner to this activity" }),
        );

        await waitFor(() =>
          expect(screen.getByRole("alert")).toHaveTextContent(
            "This climbing entry is no longer available.",
          ),
        );
      });

      it("shows separate suggestion loading, error, and empty states", async () => {
        Object.assign(mockActivity, { activityType: "climbing" });
        mockEntrySuggestionsUseQuery.mockReturnValue(
          queryResult<ClimbingLogEntryDetail[]>(undefined, { isLoading: true }),
        );
        const view = renderWithUnits(<ActivityDetailPage />);
        expect(screen.getByText("Loading climbing logs...")).toBeDefined();
        view.unmount();
        mockEntrySuggestionsUseQuery.mockReturnValue(
          queryResult<ClimbingLogEntryDetail[]>(undefined, {
            error: new Error("Tick service unavailable"),
          }),
        );
        renderWithUnits(<ActivityDetailPage />);
        expect(screen.getByText("Tick service unavailable")).toBeDefined();
      });
    });

    describe("page-owned zone composition", () => {
      it.each([
        {
          data: undefined,
          error: new Error("Heart-rate zones are unavailable."),
          expectedError: "Heart-rate zones are unavailable.",
          empty: false,
        },
        { data: [], error: null, expectedError: null, empty: true },
        {
          data: [],
          error: new Error("Unable to load heart rate zones"),
          expectedError: "Unable to load heart rate zones",
          empty: false,
        },
      ])("shows the correct HR zone state when data is $data", async (state) => {
        mockHrZonesUseQuery.mockReturnValue(
          queryResult(state.data, { isError: state.error !== null, error: state.error }),
        );
        renderWithUnits(<ActivityDetailPage />);
        expect(screen.getByText("Heart Rate Zones")).toBeDefined();
        if (state.expectedError) expect(screen.getByText(state.expectedError)).toBeDefined();
        if (state.empty) expect(screen.getByText("No heart rate zone data")).toBeDefined();
        else expect(screen.queryByText("No heart rate zone data")).toBeNull();
      });

      it("does not show heart rate zones for non-heart-rate streams while zones are loading", async () => {
        const originalStream = [...mockStreamPoints];
        mockStreamPoints.splice(
          0,
          mockStreamPoints.length,
          ...originalStream.map((point) => ({ ...point, heartRate: null })),
        );
        mockHrZonesUseQuery.mockReturnValue(queryResult([], { isLoading: true }));

        renderWithUnits(<ActivityDetailPage />);

        expect(screen.queryByText("Heart Rate Zones")).toBeNull();
        expect(screen.queryByText("No heart rate zone data")).toBeNull();
      });
    });

    describe("retained activity details", () => {
      it("keeps cached heart-rate and power zones visible with refresh errors", async () => {
        setCyclingPowerActivity();
        mockHrZonesUseQuery.mockReturnValue(
          queryResult([detailPageCachedHrZone], {
            error: new Error("Heart-rate zones refresh failed"),
            isError: true,
          }),
        );
        mockPowerZonesUseQuery.mockReturnValue(
          queryResult(detailPageCachedPowerZones, {
            error: new Error("Power zones refresh failed"),
            isError: true,
          }),
        );
        renderWithUnits(<ActivityDetailPage />);

        expect(screen.getByText("Heart Rate Zones")).toBeTruthy();
        expect(screen.getByText("Power Zones")).toBeTruthy();
        expect(screen.getByText("Heart-rate zones refresh failed")).toBeTruthy();
        expect(screen.getByText("Power zones refresh failed")).toBeTruthy();
        expect(screen.getByText("Applied FTP: 250 W")).toBeTruthy();
        expect(screen.queryByRole("link", { name: "Set FTP" })).toBeNull();
      });
    });
  });
});
