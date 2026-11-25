// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type React from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityAliasRouteId,
  activityDetailMetricSources,
  aliasedRestorableActivity,
  attachableSuggestedClimb,
  attachedClimbingEntry,
  baseCyclingActivity,
  cachedAreaSuggestion,
  cachedClimbingErrorEntries,
  cachedClimbingRoute,
  climbingActivity,
  climbingMapRecords,
  configuredPowerZones,
  downloadedActivityImages,
  expectedClimbingMapMarkers,
  hangboardActivity,
  heartRateOnlyStreamPoints,
  importedHangboardDetails,
  kilterAndKayaClimbingEntries,
  kilterClimbingActivity,
  noPowerStreamPoints,
  partialRouteStreamPoint,
  powerWorkBySource,
  processingRoute,
  readyActivityRoute,
  readySparseTemperatureRoute,
  refreshedGarminHardware,
  repeatedClimbingEntries,
  restorableActivity,
  scopedCyclingRoute,
  sparseTemperatureStreamPoints,
  streamPointsWithHrAndPower,
  surroundingClimbingHeartRate,
  unconfiguredCyclingPowerZones,
  visibleRestoredActivity,
  yogaActivity,
  zeroPowerStreamPoints,
} from "../../app-fixtures/activity-detail";
import { garminActivitySourceTree } from "../../app-fixtures/activity-source-tree";
import {
  activityAlert,
  activityRouteParams,
  chartScrub,
  defaultObserver,
  getPlaceholderData,
  getQueryEnabledFlag,
  mockGarminHeartRateFailure,
  resetActivityDetailMocks,
  routeMocks,
} from "../../components/activity/activity-detail-test-helpers";
import { cyclingProgressionFixture } from "../../components/CyclingProgressionEvidence.stories";
import { RouteMap } from "../../components/RouteMap";
import type { AuthUser } from "../../lib/auth";
import type { useAuth } from "../../lib/auth-context";
import { captureException } from "../../lib/telemetry";

const testHelpers = vi.hoisted(
  () => import("../../components/activity/activity-detail-test-helpers"),
);
const unitMode = vi.hoisted(() => ({ imperial: false }));

vi.mock("react-native", async () => ({
  ...(await testHelpers).createReactNativeMock(),
  useWindowDimensions: vi.fn(() => ({ width: 390, height: 844, scale: 3, fontScale: 1 })),
}));
vi.mock("react-native-svg", async () => (await testHelpers).createSvgMock());
vi.mock("expo-router", async () => {
  const { activityRouteParams, routeMocks } = await testHelpers;
  return {
    useLocalSearchParams: () => activityRouteParams,
    useRouter: () => ({ back: routeMocks.routerBack, push: routeMocks.routerPush }),
  };
});
vi.mock("../../components/ChartTitleWithTooltip", async () => ({
  ChartTitleWithTooltip: (await testHelpers).activityDetailSimpleMocks.ChartTitleWithTooltip,
}));
vi.mock("../../components/MuscleGroupBodyDiagram", async () => ({
  MuscleGroupBodyDiagram: (await testHelpers).activityDetailSimpleMocks.MuscleGroupBodyDiagram,
}));
vi.mock("../../components/GhostSessions", () => ({
  GhostSessions: ({ activityId }: { activityId: string }) => (
    <span data-testid="ghost-sessions-activity">{activityId}</span>
  ),
}));
vi.mock("../../components/ProviderLogo", async () => ({
  ProviderLogo: (await testHelpers).activityDetailSimpleMocks.ProviderLogo,
}));
vi.mock("../../components/RouteMap", async () => ({ RouteMap: (await testHelpers).routeMapMock }));
vi.mock("../../components/activity/useChartScrub", async () =>
  (await testHelpers).createChartScrubMock(),
);
vi.mock("../../lib/units", async () => {
  const converter = (await testHelpers).activityDetailSimpleMocks.unitConverter();
  return {
    ...converter,
    useUnitConverter: () => {
      const units = converter.useUnitConverter();
      return unitMode.imperial
        ? { ...units, convertPace: (seconds: number) => seconds * 1.60934, paceLabel: "/mi" }
        : units;
    },
  };
});
vi.mock("../../lib/auth-context", () => ({ useAuth: () => authFixture }));
vi.mock(
  "../../lib/activity-export",
  async () => (await testHelpers).activityDetailSimpleMocks.activityExport,
);
vi.mock("../../lib/telemetry", async () => (await testHelpers).activityDetailSimpleMocks.telemetry);
vi.mock("../../theme", async (importOriginal) =>
  (await testHelpers).createActivityDetailThemeMock(importOriginal),
);
vi.mock("@dofek/format/format", async (importOriginal) =>
  (await testHelpers).createActivityDetailFormatMock(importOriginal),
);
vi.mock(
  "@dofek/format/units",
  async () => (await testHelpers).activityDetailSimpleMocks.formatUnits,
);
vi.mock("@dofek/providers/providers", async (importOriginal) =>
  (await testHelpers).createActivityDetailProviderMock(importOriginal),
);
vi.mock("@dofek/scoring/colors", async (importOriginal) =>
  (await testHelpers).createActivityDetailScoringMock(importOriginal),
);
vi.mock(
  "@dofek/training/muscle-groups",
  async () => (await testHelpers).activityDetailSimpleMocks.trainingMuscleGroups,
);
vi.mock("@dofek/training/training", async (importOriginal) =>
  (await testHelpers).createActivityDetailTrainingMock(importOriginal),
);
vi.mock("@dofek/zones/zones", async (importOriginal) =>
  (await testHelpers).createActivityDetailZonesMock(importOriginal),
);
const mocks = routeMocks;

let ActivityDetailScreen!: React.ComponentType;
beforeAll(async () => {
  ActivityDetailScreen = (await import("../../app/activity/[id]")).default;
});

function renderActivityDetail() {
  return render(<ActivityDetailScreen />);
}

it("checks protected Ghost eligibility for the canonical activity regardless of its displayed sport", () => {
  activityRouteParams.id = activityAliasRouteId;
  mocks.byIdQuery.mockReturnValue(defaultObserver(yogaActivity));
  renderActivityDetail();
  expect(screen.getByTestId("ghost-sessions-activity").textContent).toBe(yogaActivity.id);
});

const authFixture = vi.hoisted(() => ({
  user: { id: "mobile-test-user", name: "Mobile Test User", email: null } satisfies AuthUser,
  accountSessionOwnerNonce: "mobile-test-session",
  serverUrl: "https://example.com",
  sessionToken: "test-session-token",
})) satisfies Pick<
  ReturnType<typeof useAuth>,
  "user" | "accountSessionOwnerNonce" | "serverUrl" | "sessionToken"
>;

vi.mock("../../lib/trpc", async () => (await testHelpers).makeTrpcMock());

beforeEach(() => {
  unitMode.imperial = false;
  resetActivityDetailMocks({
    activity: baseCyclingActivity,
    stream: streamPointsWithHrAndPower,
    routeParams: activityRouteParams,
    routeMap: vi.mocked(RouteMap),
    alert: activityAlert,
    capture: vi.mocked(captureException),
    routeId: "00000000-0000-0000-0000-000000000001",
  });
});

function selectPerformanceMetric(metric: string) {
  const trigger = screen.queryByRole("button", { name: /^Performance metrics:/ });
  if (!trigger) return;
  fireEvent.click(trigger);
  const choice = screen.queryByRole("radio", { name: metric });
  if (choice) fireEvent.click(choice);
  else fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
}

function openPerformance(metric?: string) {
  fireEvent.click(screen.getByRole("tab", { name: "Performance" }));
  if (metric) selectPerformanceMetric(metric);
}

describe("ActivityDetailScreen", () => {
  it("opens chart performance separately from the workout overview and puts record actions near the header", () => {
    renderActivityDetail();
    expect(screen.queryByRole("button", { name: "View Heart Rate data" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Performance" }));
    expect(screen.getByRole("button", { name: "View Heart Rate data" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "View Power data" })).toBeNull();
    selectPerformanceMetric("Power");
    expect(screen.getByRole("button", { name: "View Power data" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "View Heart Rate data" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Activity actions" }));
    expect(screen.getByRole("button", { name: "Export Activity" })).toBeTruthy();
    const recompute = screen.getByRole("button", { name: "Recompute activity" });
    fireEvent.click(screen.getByRole("button", { name: "Activity actions" }));
    expect(recompute.isConnected).toBe(true);
  });

  it("shows Kilter's logged window and keeps point-only duration unknown beside Kaya climbs", async () => {
    mocks.byIdQuery.mockReturnValue(defaultObserver(kilterClimbingActivity));
    mocks.climbingEntriesQuery.mockReturnValue(defaultObserver(kilterAndKayaClimbingEntries));

    renderActivityDetail();
    expect(getQueryEnabledFlag(mocks.climbingEntriesQuery.mock.calls[0]?.[1])).toBe(true);
    expect(screen.getByText("Climbs")).toBeTruthy();
    expect(screen.getByText("Kilter Board · Logged climbs · 3:02 AM")).toBeTruthy();
    expect(screen.getByText("Duration")).toBeTruthy();
    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(screen.getByText("Kaya wall climb")).toBeTruthy();
    expect(screen.getByText("Kilter board climb")).toBeTruthy();
    expect(screen.queryByText("No unattached climbing logs for this day.")).toBeNull();
    expect(screen.queryByText("0m")).toBeNull();
  });

  it("shows surrounding HR readings supplied by the server for climbing", async () => {
    mocks.byIdQuery.mockReturnValue(defaultObserver(climbingActivity));
    mocks.heartRateContextQuery.mockReturnValue(defaultObserver(surroundingClimbingHeartRate));
    renderActivityDetail();
    openPerformance();
    fireEvent.click(await screen.findByRole("button", { name: "View Heart Rate data" }));
    expect(screen.getByText("91 bpm")).toBeDefined();
    expect(screen.getByText("92 bpm")).toBeDefined();
  });
  it("opens lineage with actionable refresh errors in the real activity header", async () => {
    mocks.byIdQuery.mockReturnValue(
      defaultObserver({ ...baseCyclingActivity, sourceTree: garminActivitySourceTree }),
    );
    mocks.hardwareQuery.mockReturnValue({
      ...defaultObserver(refreshedGarminHardware),
      error: new Error("Reconnect Garmin and retry device metadata."),
      refetch: mocks.hardwareRefetch,
    });
    renderActivityDetail();
    expect(screen.getByText("Reconnect Garmin and retry device metadata.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.hardwareRefetch).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Lineage: Garmin Edge 530" }));
    expect(screen.getByText("220 W")).toBeTruthy();
  });

  it("shows downloaded activity images and closes their viewer after activity navigation", async () => {
    mocks.imagesQuery.mockReturnValue({
      ...defaultObserver(downloadedActivityImages),
      refetch: vi.fn(),
    });
    const view = renderActivityDetail();
    expect(mocks.imagesQuery).toHaveBeenCalledWith(
      { id: baseCyclingActivity.id },
      expect.objectContaining({
        enabled: true,
        staleTime: 0,
        refetchOnMount: "always",
        meta: { persist: false },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "View 1 photo" }));
    expect(screen.getByRole("button", { name: "Close photo" })).toBeTruthy();
    activityRouteParams.id = "00000000-0000-0000-0000-000000000002";
    view.rerender(<ActivityDetailScreen />);
    expect(screen.queryByRole("button", { name: "Close photo" })).toBeNull();
  });
  it.each(["hiking", "running", "cycling", "strength", "hangboard", "rock_climbing"])(
    "hides climbs for %s activities even when climbing queries have cached data",
    async (activityType) => {
      mocks.byIdQuery.mockReturnValue(defaultObserver({ ...baseCyclingActivity, activityType }));
      mocks.climbingEntriesQuery.mockReturnValue(defaultObserver([attachedClimbingEntry]));
      mocks.entrySuggestionsQuery.mockReturnValue(
        defaultObserver([cachedClimbingErrorEntries.suggested]),
      );

      renderActivityDetail();
      expect(screen.queryByText("Climbs")).toBeNull();
      expect(screen.queryByText("Attached Boulder")).toBeNull();
      expect(screen.queryByText("Ridge traverse")).toBeNull();
      expect(getQueryEnabledFlag(mocks.climbingEntriesQuery.mock.calls[0]?.[1])).toBe(false);
      expect(getQueryEnabledFlag(mocks.entrySuggestionsQuery.mock.calls[0]?.[1])).toBe(false);
    },
  );

  it("loads climbing logs and keeps cached records visible when both refreshes fail", async () => {
    mocks.byIdQuery.mockReturnValue(defaultObserver(climbingActivity));
    mocks.climbingEntriesQuery.mockReturnValue({
      ...defaultObserver([cachedClimbingErrorEntries.attached]),
      error: new Error("Log refresh failed"),
    });
    mocks.entrySuggestionsQuery.mockReturnValue({
      ...defaultObserver([cachedClimbingErrorEntries.suggested]),
      error: new Error("Suggestions refresh failed"),
    });
    renderActivityDetail();
    expect(getQueryEnabledFlag(mocks.climbingEntriesQuery.mock.calls[0]?.[1])).toBe(true);
    expect(screen.getByText("Summit outing")).toBeTruthy();
    expect(screen.getByText("Ridge traverse")).toBeTruthy();
    expect(screen.getByText("Log refresh failed")).toBeTruthy();
    expect(screen.getByText("Suggestions refresh failed")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Attach entry 2, Ridge traverse to this activity" }),
    ).toBeTruthy();
  });
  it("updates route export readiness from processing to the ready route endpoint", async () => {
    mocks.streamQuery.mockReturnValue(defaultObserver([partialRouteStreamPoint]));
    mocks.routeQuery.mockReturnValue(defaultObserver(processingRoute));

    const view = renderActivityDetail();
    fireEvent.click(screen.getByRole("button", { name: "Activity actions" }));
    expect(screen.getByRole("progressbar", { name: "Processing map" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Export Activity" }));
    expect(
      screen.getByRole("button", { name: "Export as GPS track (GPX)" }).hasAttribute("disabled"),
    ).toBe(true);
    mocks.routeQuery.mockReturnValue(defaultObserver(readyActivityRoute));
    view.rerender(<ActivityDetailScreen />);
    expect(screen.getByText("Route ends at 37.9")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Export as GPS track (GPX)" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it.each(["loading", "processing"] as const)(
    "reserves map space while route geometry is %s without a renderable map",
    (state) => {
      mocks.routeQuery.mockReturnValue({
        data: state === "processing" ? processingRoute : undefined,
        isLoading: state === "loading",
        error: null,
      });
      renderActivityDetail();
      const status = screen.getByRole("progressbar", { name: "Processing map" });
      expect(status.textContent).toBe("Processing map…");
      expect(JSON.parse(status.parentElement?.getAttribute("data-style") ?? "null")).toMatchObject({
        height: 280,
      });
    },
  );

  it.each([
    "unavailable",
    "loading",
    "processing",
    "error",
    "cached error",
    "cached loading",
  ] as const)("shows canonical climbing locations when the recorded route is %s", async (state) => {
    mocks.byIdQuery.mockReturnValue(defaultObserver(climbingActivity));
    mocks.routeQuery.mockReturnValue({
      ...defaultObserver(
        state.startsWith("cached")
          ? cachedClimbingRoute
          : state === "processing"
            ? processingRoute
            : { status: "unavailable" },
      ),
      error: state.endsWith("error") ? new Error("Recorded route refresh failed") : null,
      isLoading: state.endsWith("loading"),
    });
    mocks.climbingEntriesQuery.mockReturnValue({
      data: [climbingMapRecords.unlocated, climbingMapRecords.located],
      error: new Error("Climbing refresh failed"),
      isLoading: false,
      isFetching: false,
      isPlaceholderData: false,
    });
    mocks.entrySuggestionsQuery.mockReturnValue(defaultObserver([climbingMapRecords.suggested]));

    renderActivityDetail();
    expect(screen.queryAllByText("Route ends at none")).toHaveLength(
      state.startsWith("cached") ? 0 : 1,
    );
    expect(screen.getByText("Climbing refresh failed")).toBeTruthy();
    expect(screen.getByLabelText("Climbing entry: Located climb")).toBeTruthy();
    expect(screen.getByLabelText("Climbing entry: Suggested climb")).toBeTruthy();
    const overviewProps = vi.mocked(RouteMap).mock.calls.find(([props]) => !props.compact)?.[0];
    expect(overviewProps?.climbMarkers).toEqual(expectedClimbingMapMarkers);
    act(() => overviewProps?.onSelectEntry?.("10000000-0000-4000-8000-000000000301"));
    expect(
      screen
        .getByRole("button", { name: "Select entry 2, Located climb" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Log details for entry 2, Located climb" }));
    expect(screen.getByRole("button", { name: "Close record detail" })).toBeTruthy();
    expect(screen.getByText("Record Detail")).toBeTruthy();
    const selectedOverviewProps = vi
      .mocked(RouteMap)
      .mock.calls.filter(([props]) => !props.compact)
      .at(-1)?.[0];
    expect(selectedOverviewProps?.points).toBe(overviewProps?.points);
    if (state.startsWith("cached")) {
      expect(screen.getByText("Route ends at 7")).toBeTruthy();
    }
    if (state.endsWith("loading") || state === "processing") {
      expect(
        screen.getByText(
          state.endsWith("loading") ? "Loading route map…" : "Processing route map…",
        ),
      ).toBeTruthy();
      expect(screen.queryByRole("progressbar", { name: "Processing map" })).toBeNull();
    }
    if (state.endsWith("error")) {
      expect(screen.getByText("Recorded route refresh failed")).toBeTruthy();
    }
  });

  it("keeps the cycling route scoped to its activity when climbing suggestions remain cached", async () => {
    mocks.byIdQuery.mockReturnValue(defaultObserver(baseCyclingActivity));
    mocks.routeQuery.mockReturnValue(defaultObserver(scopedCyclingRoute));
    mocks.entrySuggestionsQuery.mockReturnValue(defaultObserver([cachedAreaSuggestion]));
    renderActivityDetail();
    const overview = vi.mocked(RouteMap).mock.calls.find(([props]) => !props.compact)?.[0];
    expect(overview?.climbMarkers).toEqual([]);
  });

  it("opens the exact repeated climb in a detail modal and can reopen it after closing", async () => {
    mocks.byIdQuery.mockReturnValue(defaultObserver(climbingActivity));
    const [first, second] = repeatedClimbingEntries;
    mocks.climbingEntriesQuery.mockReturnValue(defaultObserver([first, second]));
    renderActivityDetail();
    const overview = vi.mocked(RouteMap).mock.calls.find(([props]) => !props.compact)?.[0];
    expect(overview?.climbMarkers?.map((marker) => marker.entryId)).toEqual([first.id, second.id]);
    fireEvent.click(screen.getByRole("button", { name: "Log details for entry 2, Corner" }));
    const detail = screen.getByTestId("modal");
    expect(within(detail).getByText("Second occurrence notes")).toBeTruthy();
    expect(within(detail).queryByText("First occurrence notes")).toBeNull();
    fireEvent.click(within(detail).getByRole("button", { name: "Close record detail" }));
    expect(screen.queryByText("Record Detail")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Log details for entry 2, Corner" }));
    expect(within(screen.getByTestId("modal")).getByText("Second occurrence notes")).toBeTruthy();
  });

  it("invalidates Activities screen queries after deleting an activity", async () => {
    renderActivityDetail();
    fireEvent.click(screen.getByRole("button", { name: "Activity actions" }));

    fireEvent.click(screen.getByLabelText("Delete Activity"));
    const deleteAction = activityAlert.mock.calls.at(-1)?.[2]?.[1];
    if (!deleteAction || typeof deleteAction.onPress !== "function") {
      throw new Error("Expected the destructive delete action");
    }
    deleteAction.onPress();

    await waitFor(() => {
      expect(mocks.deleteMutate).toHaveBeenCalledWith({ id: baseCyclingActivity.id });
      expect(mocks.activityListInvalidate).toHaveBeenCalledOnce();
      expect(mocks.calendarWeekListInvalidate).toHaveBeenCalledOnce();
      expect(mocks.calendarActivityOverviewInvalidate).toHaveBeenCalledOnce();
      expect(mocks.calendarDataInvalidate).toHaveBeenCalledOnce();
      expect(mocks.trainingProgressionStrengthReset).toHaveBeenCalledOnce();
      expect(mocks.trainingProgressionCyclingReset).toHaveBeenCalledOnce();
      expect(mocks.routerBack).toHaveBeenCalledOnce();
    });
  });

  it("shows loading, actionable error, and empty tick suggestion states", async () => {
    mocks.byIdQuery.mockReturnValue(defaultObserver(climbingActivity));
    mocks.entrySuggestionsQuery.mockReturnValue({ data: undefined, error: null, isLoading: true });
    const view = renderActivityDetail();
    expect(screen.getByText("Loading climbing logs...")).toBeTruthy();
    view.unmount();
    mocks.entrySuggestionsQuery.mockReturnValue({
      data: undefined,
      error: new Error("Tick service unavailable"),
      isLoading: false,
    });
    renderActivityDetail();
    expect(screen.getByText("Tick service unavailable")).toBeTruthy();
  });

  it("keeps one loading panel until attached climbs resolve after empty suggestions", async () => {
    mocks.byIdQuery.mockReturnValue(defaultObserver(climbingActivity));
    mocks.climbingEntriesQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
    mocks.entrySuggestionsQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
    const view = renderActivityDetail();
    const climbsCard = screen.getByText("Climbs").parentElement;
    if (!climbsCard) throw new Error("Expected a climbs card");
    expect(climbsCard.querySelectorAll('[testid="query-state-loading"]')).toHaveLength(1);
    expect(screen.queryByText("No unattached climbing logs for this day.")).toBeNull();

    mocks.entrySuggestionsQuery.mockReturnValue(defaultObserver([]));
    view.rerender(<ActivityDetailScreen />);
    expect(climbsCard.querySelectorAll('[testid="query-state-loading"]')).toHaveLength(1);
    expect(screen.queryByText("No unattached climbing logs for this day.")).toBeNull();

    mocks.climbingEntriesQuery.mockReturnValue(defaultObserver([]));
    view.rerender(<ActivityDetailScreen />);
    expect(screen.getByText("No unattached climbing logs for this day.")).toBeTruthy();
  });

  it("keeps available suggestions attachable while attached climbs initially load", async () => {
    mocks.byIdQuery.mockReturnValue(defaultObserver(climbingActivity));
    mocks.climbingEntriesQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
    mocks.entrySuggestionsQuery.mockReturnValue(defaultObserver([attachableSuggestedClimb]));
    renderActivityDetail();
    const climbsCard = screen.getByText("Climbs").parentElement;
    if (!climbsCard) throw new Error("Expected a climbs card");
    expect(within(climbsCard).getByText("Suggested Boulder")).toBeTruthy();
    expect(climbsCard.querySelectorAll('[testid="query-state-loading"]')).toHaveLength(1);
    fireEvent.click(
      within(climbsCard).getByRole("button", {
        name: "Attach entry 1, Suggested Boulder to this activity",
      }),
    );
    expect(mocks.attachEntryMutate).toHaveBeenCalledWith({
      activityId: baseCyclingActivity.id,
      climbingLogEntryId: "suggested-climb",
    });
    await waitFor(() => {
      expect(mocks.climbingEntriesInvalidate).toHaveBeenCalledWith({
        activityId: baseCyclingActivity.id,
        responseVersion: 5,
      });
    });
  });

  it("keeps cached attached climbs visible while suggestions load during a refetch", async () => {
    mocks.byIdQuery.mockReturnValue(defaultObserver(climbingActivity));
    mocks.climbingEntriesQuery.mockReturnValue({
      data: [attachedClimbingEntry],
      isLoading: false,
      isFetching: true,
      error: null,
    });
    mocks.entrySuggestionsQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
    renderActivityDetail();
    const climbsCard = screen.getByText("Climbs").parentElement;
    if (!climbsCard) throw new Error("Expected a climbs card");
    expect(within(climbsCard).getByText("Attached Boulder")).toBeTruthy();
    expect(within(climbsCard).getByText("Loading climbing logs...")).toBeTruthy();
    expect(screen.queryByText("No unattached climbing logs for this day.")).toBeNull();
  });

  it.each([null, new Error("Climbs unavailable")])(
    "does not report an empty card before attached climbs have data (error: %s)",
    async (error) => {
      mocks.byIdQuery.mockReturnValue(defaultObserver(climbingActivity));
      mocks.climbingEntriesQuery.mockReturnValue({ data: undefined, isLoading: false, error });
      mocks.entrySuggestionsQuery.mockReturnValue(defaultObserver([]));
      renderActivityDetail();
      expect(screen.getByText("Climbs")).toBeTruthy();
      expect(screen.queryByText("No unattached climbing logs for this day.")).toBeNull();
      if (error) expect(screen.getByText("Climbs unavailable")).toBeTruthy();
    },
  );

  it("enables Hangboarding details only for canonical hangboard activities", async () => {
    mocks.byIdQuery.mockReturnValue(
      defaultObserver({ ...baseCyclingActivity, activityType: "cycling" }),
    );
    renderActivityDetail();
    expect(getQueryEnabledFlag(mocks.hangboardDetailsQuery.mock.calls[0]?.[1])).toBe(false);

    mocks.byIdQuery.mockReturnValue(defaultObserver(hangboardActivity));
    mocks.hangboardDetailsQuery.mockReturnValue(defaultObserver(importedHangboardDetails));
    const rerendered = renderActivityDetail();
    rerendered.rerender(<ActivityDetailScreen />);
    expect(getQueryEnabledFlag(mocks.hangboardDetailsQuery.mock.calls.at(-1)?.[1])).toBe(true);
    expect(screen.getAllByText("Hangboarding")).toHaveLength(1);
    expect(screen.getAllByText("Imported 7/3")).toHaveLength(1);
  });

  it("renders the activity's stored session perceived exertion", async () => {
    mocks.byIdQuery.mockReturnValue(
      defaultObserver({ ...baseCyclingActivity, perceivedExertion: 7 }),
    );

    renderActivityDetail();
    expect(screen.getByLabelText("Session perceived exertion")).toBeTruthy();
    expect(screen.getByText("7/10")).toBeTruthy();
  });

  it.each([
    {
      name: "missing distance",
      activity: {
        totalDistance: null,
        totalDistanceState: { status: "missing", reason: "Distance not recorded" },
      },
      shows: [],
      hides: ["Distance unavailable", "Distance not recorded"],
    },
    {
      name: "processing, failed and conflicting details",
      activity: {
        totalDistance: null,
        totalDistanceState: { status: "processing", reason: "Distance is being recomputed" },
        elevationGain: null,
        elevationGainState: { status: "failed", reason: "Elevation processing failed" },
        avgHr: null,
        avgHrState: { status: "conflicting", reason: "Heart-rate sources disagree" },
      },
      shows: [
        "Distance processing",
        "Distance is being recomputed",
        "Elevation Gain failed",
        "Elevation processing failed",
        "Avg Heart Rate conflicting",
        "Heart-rate sources disagree",
      ],
      hides: [],
    },
    {
      name: "recorded zero distance",
      activity: { totalDistance: 0, totalDistanceState: { status: "available" } },
      shows: ["0 km"],
      hides: ["Distance unavailable"],
    },
    {
      name: "indoor cycling",
      activity: { modality: "indoor", totalDistance: 0 },
      shows: ["Avg Power"],
      hides: ["Distance"],
    },
    {
      name: "virtual cycling",
      activity: { modality: "virtual", totalDistance: 25_000 },
      shows: ["Avg Power"],
      hides: ["Distance"],
    },
    {
      name: "road cycling",
      activity: { activityType: "cycling", modality: "road" },
      shows: ["Distance", "30 km"],
      hides: [],
    },
    {
      name: "indoor running",
      activity: { activityType: "running", modality: "indoor" },
      shows: ["Distance", "30 km"],
      hides: [],
    },
  ])("keeps route stats for $name", async ({ activity, shows, hides }) => {
    mocks.byIdQuery.mockReturnValue(defaultObserver({ ...baseCyclingActivity, ...activity }));
    mocks.streamQuery.mockReturnValue(defaultObserver([]));
    renderActivityDetail();
    for (const text of shows) expect(screen.getByText(text)).toBeTruthy();
    for (const text of hides) expect(screen.queryByText(text)).toBeNull();
  });

  it.each([
    ["running", "steps/min"],
    ["cycling", "rpm"],
  ] as const)(
    "labels %s cadence chart data with the page-selected unit",
    async (activityType, unit) => {
      mocks.byIdQuery.mockReturnValue(defaultObserver({ ...baseCyclingActivity, activityType }));
      mocks.streamQuery.mockReturnValue(
        defaultObserver([{ ...streamPointsWithHrAndPower[0], cadence: 85 }]),
      );
      renderActivityDetail();
      openPerformance("Cadence");
      fireEvent.click(screen.getByRole("button", { name: "View Cadence data" }));
      expect(screen.getAllByText(`85 ${unit}`).length).toBeGreaterThan(0);
    },
  );

  it.each([
    { workKilojoules: 721.6, coveragePct: 100, expected: "722 kJ", partial: false },
    { workKilojoules: 0, coveragePct: 100, expected: "0 kJ", partial: false },
    { workKilojoules: 400, coveragePct: 98.9, expected: "400 kJ", partial: true },
    { workKilojoules: 400, coveragePct: 99, expected: "400 kJ", partial: false },
  ])("shows $expected with $coveragePct percent measured coverage", async (row) => {
    mocks.powerWorkQuery.mockReturnValue(
      defaultObserver({
        workKilojoules: row.workKilojoules,
        coverage: { coveredSeconds: 3500, coveragePct: row.coveragePct },
      }),
    );
    renderActivityDetail();
    expect(screen.getByText("Energy Output")).toBeTruthy();
    expect(screen.getByText(row.expected)).toBeTruthy();
    expect(screen.queryByText("Partial power data") !== null).toBe(row.partial);
  });

  it("omits output when the server has no measured work", async () => {
    renderActivityDetail();
    expect(screen.queryByText("Energy Output")).toBeNull();
    expect(screen.queryByText("Partial power data")).toBeNull();
  });

  it.each([
    { trainingStressScore: 0, expected: "0.0" },
    { trainingStressScore: 82.4, expected: "82.4" },
    { trainingStressScore: null, expected: null },
  ])("shows stored training stress when present ($trainingStressScore)", async (row) => {
    mocks.powerZonesQuery.mockReturnValue(
      defaultObserver({
        ...configuredPowerZones,
        trainingStressScore: row.trainingStressScore,
      }),
    );
    renderActivityDetail();
    if (row.expected) {
      expect(screen.getByText("Training Stress Score")).toBeTruthy();
      expect(screen.getByText(row.expected)).toBeTruthy();
    } else {
      expect(screen.queryByText("Training Stress Score")).toBeNull();
    }
  });

  it("enables powerZones from summary power and shows an overview error without cached zones", async () => {
    mocks.streamQuery.mockReturnValue(defaultObserver(noPowerStreamPoints));
    mocks.powerZonesQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isFetching: false,
      error: new Error("Power zones are unavailable."),
    });
    renderActivityDetail();
    expect(getQueryEnabledFlag(mocks.powerZonesQuery.mock.calls.at(-1)?.[1])).toBe(true);
    expect(screen.getByText("Power zones are unavailable.")).toBeTruthy();
    expect(screen.queryByText("Training Stress Score")).toBeNull();
  });

  it("keeps the overview training stress score during a powerZones refresh error", async () => {
    mocks.powerZonesQuery.mockReturnValue({
      ...defaultObserver({
        ...configuredPowerZones,
        trainingStressScore: 82.4,
      }),
      error: new Error("Power zones failed to refresh"),
    });
    renderActivityDetail();
    expect(screen.getByText("Training Stress Score")).toBeTruthy();
    expect(screen.getByText("82.4")).toBeTruthy();
    expect(screen.getByText("Power zones failed to refresh")).toBeTruthy();
    openPerformance("Power");
    expect(screen.getByText("Power zones failed to refresh")).toBeTruthy();
  });
  it("keeps recorded output visible and shows the refresh status only while fetching in Performance", async () => {
    mocks.metricSourcesQuery.mockReturnValue(
      defaultObserver(activityDetailMetricSources.filter((source) => source.key === "power")),
    );
    const workState = {
      ...defaultObserver(powerWorkBySource.wahoo),
      isFetching: true,
      error: new Error("Power data could not be read. Choose another source."),
    };
    mocks.powerWorkQuery.mockReturnValue(workState);
    const { rerender } = renderActivityDetail();
    expect(screen.queryByText("Updating metrics…")).toBeNull();
    openPerformance();
    expect(screen.getByText("Updating metrics…")).toBeTruthy();
    for (const isFetching of [false, true, false]) {
      workState.isFetching = isFetching;
      rerender(<ActivityDetailScreen />);
      if (isFetching) expect(screen.getByText("Updating metrics…")).toBeTruthy();
      else expect(screen.queryByText("Updating metrics…")).toBeNull();
    }
  });

  it("reserves no idle metrics status space in Performance", () => {
    renderActivityDetail();
    openPerformance();
    expect(screen.queryByText("Updating metrics…")).toBeNull();
  });

  it("does not show the previous ride's output after navigating to another activity", async () => {
    const previousWork = powerWorkBySource.wahoo;
    mocks.powerWorkQuery.mockImplementation((input: { id: string }, options: unknown) => ({
      data:
        input.id === baseCyclingActivity.id
          ? previousWork
          : getPlaceholderData(options)?.(previousWork, {
              queryKey: [
                ["activity", "powerWork"],
                { input: { id: baseCyclingActivity.id, powerSourceId: "wahoo" }, type: "query" },
              ],
            }),
      isLoading: input.id !== baseCyclingActivity.id,
      isFetching: input.id !== baseCyclingActivity.id,
      error: null,
    }));

    const view = renderActivityDetail();
    expect(screen.getByText("720 kJ")).toBeTruthy();

    const nextActivityId = "00000000-0000-0000-0000-000000000002";
    activityRouteParams.id = nextActivityId;
    mocks.byIdQuery.mockReturnValue(
      defaultObserver({ ...baseCyclingActivity, id: nextActivityId, name: "Evening Ride" }),
    );
    view.rerender(<ActivityDetailScreen />);
    expect(screen.getByText("Evening Ride")).toBeTruthy();
    expect(screen.queryByText("720 kJ")).toBeNull();
  });

  it("surfaces the activity detail server error", async () => {
    mocks.byIdQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("Activity detail is temporarily unavailable"),
    });

    renderActivityDetail();
    expect(screen.getByText("Activity detail is temporarily unavailable")).toBeTruthy();
  });

  it("uses layman-readable accessible names for activity export formats", async () => {
    renderActivityDetail();
    fireEvent.click(screen.getByRole("button", { name: "Activity actions" }));

    fireEvent.click(screen.getByRole("button", { name: "Export Activity" }));
    expect(screen.getByRole("button", { name: "Export as GPS track (GPX)" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Export as Training Center data (TCX)" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Export as comma-separated values (CSV)" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Export as fitness activity file (FIT)" }),
    ).toBeTruthy();
  });

  it("shows an empty state when heart rate zones are unavailable for an activity with heart rate", async () => {
    renderActivityDetail();
    openPerformance();
    expect(screen.getByText("No heart rate zone data")).toBeTruthy();
  });

  it("shows the heart rate zones loading state while zones are loading", async () => {
    mocks.hrZonesQuery.mockReturnValue({ data: [], isLoading: true, error: null });

    renderActivityDetail();
    openPerformance();
    expect(screen.getByTestId("loading")).toBeTruthy();
    expect(screen.queryByText("No heart rate zone data")).toBeNull();
  });

  it("does not show heart rate zones for non-heart-rate streams while zones are loading", async () => {
    mocks.streamQuery.mockReturnValue({
      data: streamPointsWithHrAndPower.map((point) => ({ ...point, heartRate: null })),
      isLoading: false,
    });
    mocks.hrZonesQuery.mockReturnValue({ data: [], isLoading: true, error: null });

    renderActivityDetail();
    openPerformance();
    expect(screen.queryByText("Heart Rate Zones")).toBeNull();
    expect(screen.queryByText("No heart rate zone data")).toBeNull();
  });

  it("shows the heart rate zones error instead of the empty state when loading zones fails", async () => {
    mocks.hrZonesQuery.mockReturnValue({
      data: [],
      isLoading: false,
      error: { message: "Unable to load heart rate zones" },
    });

    renderActivityDetail();
    openPerformance();
    expect(screen.getByText("Unable to load heart rate zones")).toBeTruthy();
    expect(screen.queryByText("No heart rate zone data")).toBeNull();
  });

  it("links power-present rides without FTP to the activity's local date", async () => {
    mocks.streamQuery.mockReturnValue({
      data: zeroPowerStreamPoints,
      isLoading: false,
    });
    mocks.powerZonesQuery.mockReturnValue(defaultObserver(unconfiguredCyclingPowerZones));
    renderActivityDetail();
    openPerformance("Power");
    fireEvent.click(screen.getByRole("link", { name: "Set cycling FTP for this activity date" }));
    expect(mocks.routerPush).toHaveBeenCalledWith(
      "/settings?tab=models-units&section=cycling-ftp&date=2026-05-15",
    );
  });

  it("does not show the FTP setup link while power zones are loading, failed, or power is absent", async () => {
    mocks.powerZonesQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isFetching: true,
      error: null,
    });
    const loading = renderActivityDetail();
    openPerformance("Power");
    expect(
      screen.queryByRole("link", { name: "Set cycling FTP for this activity date" }),
    ).toBeNull();
    loading.unmount();

    mocks.powerZonesQuery.mockReturnValue({
      ...defaultObserver(unconfiguredCyclingPowerZones),
      isFetching: true,
    });
    const refreshing = renderActivityDetail();
    openPerformance("Power");
    expect(
      screen.queryByRole("link", { name: "Set cycling FTP for this activity date" }),
    ).toBeNull();
    refreshing.unmount();

    mocks.powerZonesQuery.mockReturnValue({
      ...defaultObserver(unconfiguredCyclingPowerZones),
      error: new Error("Power zones failed to refresh"),
    });
    const failed = renderActivityDetail();
    openPerformance("Power");
    expect(
      screen.queryByRole("link", { name: "Set cycling FTP for this activity date" }),
    ).toBeNull();
    failed.unmount();

    mocks.streamQuery.mockReturnValue({
      data: noPowerStreamPoints,
      isLoading: false,
    });
    mocks.powerZonesQuery.mockReturnValue(defaultObserver(null));
    renderActivityDetail();
    openPerformance();
    expect(
      screen.queryByRole("link", { name: "Set cycling FTP for this activity date" }),
    ).toBeNull();
  });

  it("shows planned vs. recorded intervals only for cycling activities with eligible rows", async () => {
    const plannedRow = {
      intervalIndex: 0,
      startOffsetSeconds: 0,
      endOffsetSeconds: 180,
      label: "Work 1",
      target: { kind: "range" as const, minWatts: 250, maxWatts: 265 },
      plannedDurationSeconds: 180,
      recordedTimerDurationSeconds: 134,
      timerDifferenceSeconds: -46,
      averagePowerWatts: 256,
    };
    mocks.plannedIntervalsQuery.mockReturnValue(defaultObserver([plannedRow]));
    mocks.byIdQuery.mockReturnValue(
      defaultObserver({ ...baseCyclingActivity, activityType: "cycling" }),
    );
    const cycling = renderActivityDetail();
    expect(screen.getByText("Planned vs. recorded intervals")).toBeTruthy();
    expect(screen.getByText("0:46 short of 3:00")).toBeTruthy();
    expect(getQueryEnabledFlag(mocks.plannedIntervalsQuery.mock.calls.at(-1)?.[1])).toBe(true);
    cycling.unmount();

    mocks.plannedIntervalsQuery.mockClear();
    mocks.byIdQuery.mockReturnValue(defaultObserver(yogaActivity));
    renderActivityDetail();
    expect(screen.queryByText("Planned vs. recorded intervals")).toBeNull();
    expect(getQueryEnabledFlag(mocks.plannedIntervalsQuery.mock.calls.at(-1)?.[1])).toBe(false);
  });

  it("omits the intervals section for cycling without eligible rows", async () => {
    mocks.byIdQuery.mockReturnValue(
      defaultObserver({ ...baseCyclingActivity, activityType: "cycling" }),
    );
    renderActivityDetail();
    expect(screen.queryByText("Planned vs. recorded intervals")).toBeNull();
  });

  it("renders without crashing for non-cycling workouts with heart rate data but no power", async () => {
    mocks.byIdQuery.mockReturnValue(defaultObserver(yogaActivity));
    mocks.streamQuery.mockReturnValue(defaultObserver(heartRateOnlyStreamPoints));
    mocks.metricSourcesQuery.mockReturnValue(
      defaultObserver(activityDetailMetricSources.filter((source) => source.key === "heartRate")),
    );
    renderActivityDetail();
    openPerformance();
    expect(screen.getByText("Yoga Session")).toBeTruthy();
    expect(screen.getByRole("button", { name: "View Heart Rate data" })).toBeTruthy();
    const enabled = getQueryEnabledFlag(mocks.powerZonesQuery.mock.calls[0]?.[1]);
    expect(enabled).toBe(false);
  });

  it("keeps restore completion tracking mounted after PostgreSQL makes the activity visible", async () => {
    mocks.restoreResult.mockReturnValue({ analyticsJobId: "restore-job-1" });
    mocks.restoreStatus.mockReturnValue({ data: { status: "pending", error: null }, error: null });
    mocks.byIdQuery.mockReturnValue(defaultObserver(restorableActivity));
    const { rerender } = renderActivityDetail();
    mocks.byIdQuery.mockReturnValue(defaultObserver(visibleRestoredActivity));
    rerender(<ActivityDetailScreen />);
    expect(screen.getByText("Refreshing restored activity charts…")).toBeTruthy();
    const invalidations = mocks.activityInvalidate.mock.calls.length;
    mocks.restoreStatus.mockReturnValue({
      data: { status: "completed", error: null },
      error: null,
    });
    rerender(<ActivityDetailScreen />);
    await waitFor(() => expect(mocks.activityInvalidate).toHaveBeenCalledTimes(invalidations + 1));
  });

  it("restores the canonical activity while refreshing detail cached under its route alias", async () => {
    const canonicalActivityId = aliasedRestorableActivity.id;
    activityRouteParams.id = activityAliasRouteId;
    mocks.byIdQuery.mockReturnValue(defaultObserver(aliasedRestorableActivity));

    renderActivityDetail();

    fireEvent.click(screen.getByRole("button", { name: "Restore activity" }));
    expect(mocks.restoreProviderAbsentMutate).toHaveBeenCalledWith({ ids: [canonicalActivityId] });
    expect(mocks.activityInvalidate).toHaveBeenCalledWith();
  });
});

it("shows available running form measurements in Activity detail Performance", () => {
  mocks.byIdQuery.mockReturnValue(
    defaultObserver({
      ...baseCyclingActivity,
      activityType: "running",
      avgSpeed: 3.33,
      avgCadence: 178,
      runningForm: {
        cadence: 178,
        cadenceBasis: "cadence_samples",
        cadenceObservedSeconds: 600,
        cadenceCoveragePercent: null,
        strideLengthMeters: 1.24,
        stanceTimeMs: 240,
        verticalOscillationMm: 8,
      },
    }),
  );
  renderActivityDetail();
  openPerformance();
  expect(screen.getByText("Running Form")).toBeTruthy();
  const readings = screen.getByLabelText("Running Form readings");
  expect(within(readings).getByText("Cadence")).toBeTruthy();
  expect(within(readings).getByText("178 spm")).toBeTruthy();
  expect(within(readings).getByText("Recorded cadence")).toBeTruthy();
  expect(within(readings).getByText("Stride length")).toBeTruthy();
  expect(within(readings).getByText("1.24 m")).toBeTruthy();
  expect(within(readings).getByText("Ground contact time")).toBeTruthy();
  expect(within(readings).getByText("240 ms")).toBeTruthy();
  expect(within(readings).getByText("Vertical oscillation")).toBeTruthy();
  expect(within(readings).getByText("8 mm")).toBeTruthy();
  expect(within(readings).getAllByText("Cadence")).toHaveLength(1);
});

it("shows form-only readings without the generic empty performance message", () => {
  mocks.byIdQuery.mockReturnValue(
    defaultObserver({
      ...baseCyclingActivity,
      activityType: "running",
      avgCadence: null,
      runningForm: {
        cadence: null,
        cadenceBasis: "unknown",
        cadenceObservedSeconds: null,
        cadenceCoveragePercent: null,
        strideLengthMeters: 2.1,
        stanceTimeMs: 210,
        verticalOscillationMm: 9,
      },
    }),
  );
  mocks.streamQuery.mockReturnValue(defaultObserver([]));
  renderActivityDetail();
  openPerformance();
  expect(screen.getByText("Running Form")).toBeTruthy();
  expect(screen.getByText("2.10 m")).toBeTruthy();
  expect(screen.queryByText("No performance measurements recorded")).toBeNull();
});

it("omits the form readout for non-running activities and older cached runs", () => {
  mocks.byIdQuery.mockReturnValue(
    defaultObserver({
      ...baseCyclingActivity,
      runningForm: {
        cadence: 170,
        cadenceBasis: "cadence_samples",
        cadenceObservedSeconds: null,
        cadenceCoveragePercent: null,
        strideLengthMeters: 2,
        stanceTimeMs: 200,
        verticalOscillationMm: 9,
      },
    }),
  );
  const cycling = renderActivityDetail();
  openPerformance();
  expect(screen.queryByText("Running Form")).toBeNull();
  cycling.unmount();

  mocks.byIdQuery.mockReturnValue(
    defaultObserver({ ...baseCyclingActivity, activityType: "running" }),
  );
  renderActivityDetail();
  openPerformance();
  expect(screen.queryByText("Running Form")).toBeNull();
});

it("uses the server-provided run pace as Avg Pace with an Avg Speed fallback", () => {
  mocks.byIdQuery.mockReturnValue(
    defaultObserver({
      ...baseCyclingActivity,
      activityType: "running",
      avgSpeed: 3.328,
      avgPaceSecondsPerKm: 301,
    }),
  );
  const running = renderActivityDetail();
  expect(screen.getByText("Avg Pace")).toBeTruthy();
  expect(screen.getByText("5:01 /km")).toBeTruthy();
  expect(screen.queryByText("Avg Speed")).toBeNull();
  running.unmount();

  mocks.byIdQuery.mockReturnValue(
    defaultObserver({ ...baseCyclingActivity, activityType: "running", avgSpeed: 3.328 }),
  );
  const older = renderActivityDetail();
  expect(screen.getByText("Avg Speed")).toBeTruthy();
  expect(screen.queryByText("Avg Pace")).toBeNull();
  older.unmount();

  mocks.byIdQuery.mockReturnValue(
    defaultObserver({ ...baseCyclingActivity, activityType: "running", avgSpeed: 0 }),
  );
  const zero = renderActivityDetail();
  expect(screen.getByText("Avg Speed")).toBeTruthy();
  zero.unmount();

  renderActivityDetail();
  expect(screen.getByText("Avg Speed")).toBeTruthy();
});

it("converts the server-provided run pace for imperial units", () => {
  unitMode.imperial = true;
  mocks.byIdQuery.mockReturnValue(
    defaultObserver({
      ...baseCyclingActivity,
      activityType: "running",
      avgSpeed: 3.328,
      avgPaceSecondsPerKm: 300,
    }),
  );
  renderActivityDetail();
  expect(screen.getByText("8:03 /mi")).toBeTruthy();
});

it("switches the visible power-work reading with its selected source", async () => {
  mocks.metricSourcesQuery.mockReturnValue(defaultObserver(activityDetailMetricSources));
  const workBySource = {
    wahoo: defaultObserver(powerWorkBySource.wahoo),
    garmin: defaultObserver(powerWorkBySource.garmin),
  };
  mocks.powerWorkQuery.mockImplementation(
    (input: { powerSourceId?: string }) =>
      workBySource[input.powerSourceId === "garmin" ? "garmin" : "wahoo"],
  );
  renderActivityDetail();
  expect(getQueryEnabledFlag(mocks.powerZonesQuery.mock.calls[0]?.[1])).toBe(true);
  expect(screen.getByText("720 kJ")).toBeTruthy();
  openPerformance("Power");
  fireEvent.click(screen.getByRole("button", { name: "Power source: Wahoo" }));
  fireEvent.click(screen.getByRole("radio", { name: "Garmin" }));
  expect(screen.getByRole("button", { name: "Power source: Garmin" })).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
  expect(screen.getByText("810 kJ")).toBeTruthy();
});

it("keeps mobile pickers available after a source read fails", async () => {
  mocks.metricSourcesQuery.mockReturnValue(
    defaultObserver(activityDetailMetricSources.filter((source) => source.key === "heartRate")),
  );
  const failGarminRead = mockGarminHeartRateFailure(streamPointsWithHrAndPower);
  const routeView = renderActivityDetail();
  openPerformance();
  fireEvent.click(screen.getByRole("button", { name: "Heart Rate source: WHOOP" }));
  fireEvent.click(screen.getByRole("radio", { name: "Garmin" }));
  expect(screen.getByRole("button", { name: "Heart Rate source: Garmin" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "View Heart Rate data" }));
  expect(screen.getByText("140 bpm")).toBeTruthy();
  expect(screen.getByText("Showing previous readings from WHOOP")).toBeTruthy();
  failGarminRead();
  routeView.rerender(<ActivityDetailScreen />);
  fireEvent.click(screen.getByRole("button", { name: "Heart Rate source: Garmin" }));
  fireEvent.click(screen.getByRole("radio", { name: "Garmin" }));
  expect(screen.getByText("Garmin samples could not be read")).toBeTruthy();
  expect(screen.queryByText("No Heart Rate data available")).toBeNull();
  expect(screen.getByRole("button", { name: "Heart Rate source: Garmin" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Heart Rate source: Garmin" }));
  fireEvent.click(screen.getByRole("radio", { name: "WHOOP" }));
  expect(screen.getByRole("button", { name: "Heart Rate source: WHOOP" })).toBeTruthy();
  expect(screen.queryByText("Garmin samples could not be read")).toBeNull();
});

it.each([false, true])(
  "shows power zone source failures while retaining cached zones: %s",
  async (cached) => {
    mocks.metricSourcesQuery.mockReturnValue(
      defaultObserver(activityDetailMetricSources.filter((source) => source.key === "power")),
    );
    const zones = configuredPowerZones;
    mocks.powerZonesQuery.mockImplementation((input: { powerSourceId?: string }) => ({
      data: input.powerSourceId === "garmin" && !cached ? undefined : zones,
      error:
        input.powerSourceId === "garmin"
          ? new Error("Garmin power zones could not be read. Choose another source.")
          : null,
      isLoading: false,
    }));
    renderActivityDetail();
    openPerformance("Power");
    expect(screen.getByText(/FTP: 250 W/).textContent).toContain("effective 2026-02-01");
    expect(
      screen.queryByRole("link", { name: "Set cycling FTP for this activity date" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Power source: Wahoo" }));
    fireEvent.click(screen.getByRole("radio", { name: "Garmin" }));
    expect(
      screen.getByText("Garmin power zones could not be read. Choose another source."),
    ).toBeTruthy();
    if (cached) expect(screen.getByText("Endurance")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Power source: Garmin" }));
    fireEvent.click(screen.getByRole("radio", { name: "Wahoo" }));
    expect(
      screen.queryByText("Garmin power zones could not be read. Choose another source."),
    ).toBeNull();
  },
);

it("keeps sparse temperature charts on the activity timeline and supports GPS hover and scrubbing", async () => {
  mocks.routeQuery.mockReturnValue(defaultObserver(readySparseTemperatureRoute));
  mocks.metricSourcesQuery.mockReturnValue(defaultObserver(activityDetailMetricSources));
  mocks.streamQuery.mockReturnValue(defaultObserver(sparseTemperatureStreamPoints));
  const view = renderActivityDetail();
  openPerformance("Skin Temperature");

  fireEvent.click(screen.getByRole("button", { name: "View Skin Temperature data" }));
  expect(screen.getByText("89.9 °F")).toBeTruthy();
  expect(mocks.streamQuery.mock.calls.at(-1)?.[0]).toMatchObject({
    sources: { skinTemperature: '["whoop_ble","strap-a"]' },
  });
  expect(chartScrub.startedAt).toBe(Date.parse(baseCyclingActivity.startedAt));
  expect(chartScrub.endedAt).toBe(Date.parse(baseCyclingActivity.endedAt));
  expect(chartScrub.onHoverTime).toBeDefined();
  expect(chartScrub.onScrubStart).toBeDefined();
  expect(chartScrub.onScrubEnd).toBeDefined();
  act(() => chartScrub.onScrubStart?.());
  expect(
    view.container.querySelector("[data-scroll-enabled]")?.getAttribute("data-scroll-enabled"),
  ).toBe("false");
  act(() => chartScrub.onHoverTime?.(Date.parse("2026-04-14T10:30:00.000Z")));
  const [mapProps] = vi.mocked(RouteMap).mock.lastCall ?? [];
  expect(mapProps?.compact).toBeFalsy();
  expect(mapProps?.hoveredPosition).toEqual({ lat: 2, lng: -122 });
  act(() => chartScrub.onScrubEnd?.());
  expect(
    view.container.querySelector("[data-scroll-enabled]")?.getAttribute("data-scroll-enabled"),
  ).toBe("true");
});

it("uses one compact trigger for every available performance metric and keeps the selection", () => {
  renderActivityDetail();
  fireEvent.click(screen.getByRole("tab", { name: "Performance" }));

  expect(screen.queryByRole("tablist", { name: "Performance metrics" })).toBeNull();
  const trigger = screen.getByRole("button", { name: /^Performance metrics: Heart Rate/ });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");

  fireEvent.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  const choices = screen.getAllByRole("radio").map((radio) => radio.getAttribute("aria-label"));
  expect(choices).toContain("Heart Rate");
  expect(choices).toContain("Power");

  fireEvent.click(screen.getByRole("radio", { name: "Power" }));
  expect(screen.getByRole("button", { name: "View Power data" })).toBeTruthy();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");

  fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
  fireEvent.click(screen.getByRole("tab", { name: "Performance" }));
  expect(screen.getByRole("button", { name: /^Performance metrics: Power/ })).toBeTruthy();
});

it("omits the compact metric trigger when only one metric is available", () => {
  mocks.streamQuery.mockReturnValue(
    defaultObserver([
      {
        recordedAt: "2026-04-14T10:00:00.000Z",
        heartRate: 140,
        power: null,
        speed: null,
        cadence: null,
        altitude: null,
        skinTemperature: null,
        lat: null,
        lng: null,
      },
    ]),
  );
  renderActivityDetail();
  fireEvent.click(screen.getByRole("tab", { name: "Performance" }));

  expect(screen.queryByRole("button", { name: /^Performance metrics:/ })).toBeNull();
  expect(screen.getByRole("button", { name: "View Heart Rate data" })).toBeTruthy();
});

it("keeps the performance section empty when no metric is available", () => {
  mocks.streamQuery.mockReturnValue(
    defaultObserver([
      {
        recordedAt: "2026-04-14T10:00:00.000Z",
        heartRate: null,
        power: null,
        speed: null,
        cadence: null,
        altitude: null,
        skinTemperature: null,
        lat: null,
        lng: null,
      },
    ]),
  );
  renderActivityDetail();
  fireEvent.click(screen.getByRole("tab", { name: "Performance" }));

  expect(screen.queryByRole("button", { name: /^Performance metrics:/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /View .* data/ })).toBeNull();
});

it("enables the cycling progression query only for cycling activities", () => {
  mocks.byIdQuery.mockReturnValue(defaultObserver(yogaActivity));
  renderActivityDetail();

  expect(getQueryEnabledFlag(mocks.trainingProgressionCyclingQuery.mock.calls.at(-1)?.[1])).toBe(
    false,
  );
  expect(screen.queryByText("Ready to progress")).toBeNull();
});

it("shows ready cycling evidence with both dated rides and session effort separated", async () => {
  mocks.trainingProgressionCyclingQuery.mockReturnValue(defaultObserver(cyclingProgressionFixture));
  renderActivityDetail();

  expect(getQueryEnabledFlag(mocks.trainingProgressionCyclingQuery.mock.calls.at(-1)?.[1])).toBe(
    true,
  );
  expect(await screen.findByText("Ready to progress")).toBeTruthy();
  expect(screen.getByText("Cycling progression")).toBeTruthy();
  fireEvent.click(screen.getByText("See interval evidence"));
  expect(screen.getByText(/Selected ride/)).toBeTruthy();
  expect(screen.getByText(/Comparison ride/)).toBeTruthy();
  expect(screen.getAllByText("Session effort: 4/10")).toHaveLength(2);
  expect(screen.getAllByText(/220 W/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/218 W/).length).toBeGreaterThan(0);
});

it("shows a compact loading panel while cycling progression loads without a cache", () => {
  mocks.trainingProgressionCyclingQuery.mockReturnValue({
    ...defaultObserver(null),
    isLoading: true,
  });
  renderActivityDetail();

  expect(document.querySelectorAll('[testid="query-state-loading"]')).toHaveLength(1);
  expect(screen.queryByText("Ready to progress")).toBeNull();
});

it("keeps cached cycling evidence visible while it reloads", () => {
  mocks.trainingProgressionCyclingQuery.mockReturnValue({
    ...defaultObserver(cyclingProgressionFixture),
    isLoading: true,
  });
  renderActivityDetail();

  expect(document.querySelectorAll('[testid="query-state-loading"]')).toHaveLength(0);
  expect(screen.getByText("Ready to progress")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "See interval evidence" }));
  expect(screen.getByText(/Work 1:.*220 W/)).toBeTruthy();
  expect(screen.getByText(/Work 1:.*218 W/)).toBeTruthy();
  expect(screen.getAllByText("Session effort: 4/10")).toHaveLength(2);
});

it("shows no progression panel once a null result arrives successfully", () => {
  mocks.trainingProgressionCyclingQuery.mockReturnValue(defaultObserver(null));
  renderActivityDetail();

  expect(document.querySelectorAll('[testid="query-state-loading"]')).toHaveLength(0);
  expect(screen.queryByText("Ready to progress")).toBeNull();
});

it("keeps the recorded Session effort when cycling evidence is empty", () => {
  mocks.byIdQuery.mockReturnValue(
    defaultObserver({ ...baseCyclingActivity, perceivedExertion: 7 }),
  );
  renderActivityDetail();

  expect(screen.getByLabelText("Session perceived exertion")).toBeTruthy();
  expect(screen.getByText("7/10")).toBeTruthy();
  expect(screen.queryByText("Ready to progress")).toBeNull();
});
