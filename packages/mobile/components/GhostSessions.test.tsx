import type { GhostSessionsGetResponse } from "@dofek/training/ghost-sessions";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ghostActivityId,
  ghostComparison,
  ghostFirstPage,
  ghostFirstVisit,
  ghostFullSection,
  ghostNamesReady,
  ghostReady,
  ghostSecondPage,
  olderGhostActivityId,
} from "../app-fixtures/ghost-sessions";
import { GhostSessions } from "./GhostSessions";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  refresh: vi.fn(),
  cancel: vi.fn(),
  getQueryState: vi.fn(),
  passes: vi.fn(),
  compare: vi.fn(),
  settings: vi.fn(),
  push: vi.fn(),
  map: vi.fn(),
  nextPage: vi.fn(),
}));

vi.mock("../lib/trpc", () => {
  const utils = { ghostSessions: { get: { cancel: mocks.cancel } } };
  return {
    trpc: {
      useUtils: () => utils,
      ghostSessions: {
        get: { useQuery: mocks.get, _def: () => ({ path: ["ghostSessions", "get"] }) },
        passes: { useInfiniteQuery: mocks.passes },
        compare: { useQuery: mocks.compare },
      },
      settings: { get: { useQuery: mocks.settings } },
    },
  };
});
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const queryClient = { getQueryState: mocks.getQueryState };
  return {
    ...(await importOriginal<typeof import("@tanstack/react-query")>()),
    useQueryClient: () => queryClient,
  };
});
vi.mock("expo-router", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("./RouteMap", () => ({ RouteMap: mocks.map }));
vi.mock("@react-native-community/slider", () => ({
  default: ({
    value,
    maximumValue,
    accessibilityLabel,
    onValueChange,
  }: {
    value: number;
    maximumValue: number;
    accessibilityLabel: string;
    onValueChange: (value: number) => void;
  }) => (
    <input
      type="range"
      min={0}
      max={maximumValue}
      value={value}
      aria-label={accessibilityLabel}
      onChange={(event) => onValueChange(Number(event.target.value))}
    />
  ),
}));

let detail: GhostSessionsGetResponse | undefined;
let detailError: Error | undefined;
let labelPreference: { value: boolean };
let labelsReadError: Error | undefined;
let labelsFetchStatus: "idle" | "fetching" | "paused";
let detailUpdatedAt: number;
let detailUpdateCount: number;
let stalePass: string | undefined;
let laterPage: boolean;

const emptyPending = { data: undefined, isLoading: true, isPending: true, isFetching: false };

beforeEach(() => {
  vi.clearAllMocks();
  detail = ghostReady;
  detailError = undefined;
  labelPreference = { value: false };
  labelsReadError = undefined;
  labelsFetchStatus = "idle";
  detailUpdatedAt = 1;
  detailUpdateCount = 1;
  stalePass = undefined;
  laterPage = false;
  mocks.get.mockImplementation(() => ({
    ...emptyPending,
    data: detail,
    dataUpdatedAt: detailUpdatedAt,
    error: detailError,
    isLoading: !detail && !detailError,
    refetch: mocks.refresh,
  }));
  mocks.cancel.mockResolvedValue(undefined);
  mocks.getQueryState.mockImplementation(() => ({ dataUpdateCount: detailUpdateCount }));
  mocks.refresh.mockReset().mockImplementation(async () => {
    detailUpdateCount += 1;
    return { isSuccess: true, data: detail, dataUpdatedAt: detailUpdatedAt };
  });
  mocks.settings.mockImplementation(({ key }: { key: string }) => ({
    data: key === "ghostMapLabels" ? labelPreference : { value: "imperial" },
    isFetchedAfterMount: true,
    error: key === "ghostMapLabels" ? labelsReadError : undefined,
    isFetching: key === "ghostMapLabels" && labelsFetchStatus === "fetching",
    fetchStatus: key === "ghostMapLabels" ? labelsFetchStatus : "idle",
  }));
  mocks.passes.mockImplementation(() => ({
    data: { pages: laterPage ? [ghostFirstPage, ghostSecondPage] : [ghostFirstPage] },
    hasNextPage: !laterPage,
    fetchNextPage: mocks.nextPage,
  }));
  mocks.compare.mockImplementation((input: { passId?: string } | symbol) => {
    if (typeof input === "symbol" || !input.passId) return emptyPending;
    if (input.passId === stalePass)
      return { ...emptyPending, isLoading: false, error: { data: { code: "NOT_FOUND" } } };
    return { data: ghostComparison(input.passId), isLoading: false };
  });
  mocks.map.mockReturnValue(null);
});

const panel = () => <GhostSessions activityId={ghostActivityId} />;

afterEach(() => vi.useRealTimers());

describe("GhostSessions", () => {
  it("opens the server suggestion directly and keeps optional metrics honest", () => {
    detail = {
      ...ghostReady,
      sections: [
        { ...ghostFullSection, suggestedGhost: { passId: "older-pass", reason: "previous-best" } },
      ],
    };
    render(panel());
    expect(mocks.compare).toHaveBeenCalledWith(
      { activityId: ghostActivityId, sectionId: "route:fixture", passId: "older-pass" },
      expect.objectContaining({ meta: { persist: false } }),
    );
    expect(screen.getByText("Previous best")).toBeTruthy();
    expect(screen.getByText("10s slower")).toBeTruthy();
    expect(screen.getByText("Only the recorded overlap is compared.")).toBeTruthy();
    expect(screen.getByText("Pace /mi")).toBeTruthy();
    expect(
      screen.getByText("Heart rate and power are unavailable for this comparison."),
    ).toBeTruthy();
    expect(screen.getByText("History is incomplete.")).toBeTruthy();
    expect(mocks.get).toHaveBeenCalledWith(
      { activityId: ghostActivityId },
      expect.objectContaining({ meta: { persist: false } }),
    );
  });

  it("loads another cursor, preserves a manual choice on refresh and opens the canonical workout", async () => {
    const view = render(panel());
    fireEvent.click(screen.getByRole("button", { name: "Past efforts" }));
    fireEvent.click(screen.getByRole("button", { name: "Load more past efforts" }));
    expect(mocks.nextPage).toHaveBeenCalledOnce();
    expect(mocks.passes.mock.lastCall?.[1].getNextPageParam(ghostFirstPage)).toBe("second-page");
    laterPage = true;
    view.rerender(panel());
    fireEvent.click(screen.getByRole("button", { name: /Compare .*4m 50s/ }));
    expect(screen.getByText("10s slower")).toBeTruthy();
    const link = screen.getByRole("link", { name: /Open workout.*Nov 22/ });
    fireEvent.click(link);
    expect(mocks.push).toHaveBeenCalledWith({
      pathname: "/activity/[id]",
      params: { id: olderGhostActivityId },
    });
    detail = { ...ghostReady, sections: [{ ...ghostFullSection }] };
    view.rerender(panel());
    expect(mocks.compare.mock.lastCall?.[0]).toMatchObject({ passId: "older-pass" });
    stalePass = "older-pass";
    view.rerender(panel());
    await waitFor(() =>
      expect(mocks.compare.mock.lastCall?.[0]).toMatchObject({ passId: "recent-pass" }),
    );
  });

  it("starts paused, scrubs both paths at the same elapsed offset and resets", () => {
    vi.useFakeTimers();
    render(panel());
    expect(screen.getByRole("button", { name: "Play replay" })).toBeTruthy();
    const slider = screen.getByRole("slider", { name: "Replay elapsed time" });
    fireEvent.change(slider, { target: { value: "150000" } });
    const positions = mocks.map.mock.lastCall?.[0].comparison.positions;
    expect(positions.anchor.lng).toBeCloseTo(-122.414);
    expect(positions.candidate.lng).toBeGreaterThan(-122.425);
    expect(positions.candidate.lng).toBeLessThan(positions.anchor.lng);
    fireEvent.click(screen.getByRole("button", { name: "Play replay" }));
    expect(screen.getByRole("button", { name: "Pause replay" })).toBeTruthy();
    act(() => vi.advanceTimersByTime(1_000));
    expect(slider).toHaveProperty("value", "151000");
    fireEvent.click(screen.getByRole("button", { name: "Pause replay" }));
    act(() => vi.advanceTimersByTime(1_000));
    expect(slider).toHaveProperty("value", "151000");
    fireEvent.click(screen.getByRole("button", { name: "Restart replay" }));
    expect(slider).toHaveProperty("value", "0");
    expect(screen.getByRole("button", { name: "Play replay" })).toBeTruthy();
  });

  it("selects named roads and trails, then removes names immediately on withdrawal", async () => {
    labelPreference = { value: true };
    detail = ghostNamesReady;
    const view = render(panel());
    expect(await screen.findByText("Partial map coverage.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cedar Road" }));
    expect(mocks.compare.mock.lastCall?.[0]).toMatchObject({
      sectionId: "named:road-fixture",
      passId: "road-pass",
    });
    expect(screen.getByRole("link", { name: /OpenStreetMap/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ridge Trail" }));
    labelPreference = { value: false };
    view.rerender(panel());
    expect(screen.queryByText("Cedar Road")).toBeNull();
    expect(screen.queryByText("Ridge Trail")).toBeNull();
    expect(mocks.compare.mock.lastCall?.[0]).toMatchObject({ sectionId: "route:fixture" });
  });

  it("suppresses stale named sections and replay when a prior opt-in cannot be refreshed", async () => {
    labelPreference = { value: true };
    detail = {
      ...ghostNamesReady,
      sections: [
        ...ghostNamesReady.sections,
        { ...ghostFullSection, sectionId: "climb:fixture", kind: "unnamed-climb" },
      ],
    };
    const view = render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Cedar Road" }));
    expect(mocks.compare.mock.lastCall?.[0]).toMatchObject({ passId: "road-pass" });
    expect(screen.getByRole("link", { name: /OpenStreetMap/ })).toBeTruthy();

    labelsReadError = new Error("Consent could not be refreshed");
    mocks.compare.mockClear();
    view.rerender(panel());

    expect(screen.queryAllByText("Cedar Road")).toHaveLength(0);
    expect(screen.queryAllByText("Ridge Trail")).toHaveLength(0);
    expect(screen.queryByRole("link", { name: /OpenStreetMap/ })).toBeNull();
    expect(mocks.compare).not.toHaveBeenCalledWith(
      expect.objectContaining({ sectionId: "named:road-fixture" }),
      expect.anything(),
    );
    expect(mocks.compare.mock.lastCall?.[0]).toMatchObject({ sectionId: "route:fixture" });
    await act(async () => {
      labelsReadError = undefined;
      view.rerender(panel());
    });
    expect(mocks.compare.mock.lastCall?.[0]).toMatchObject({ sectionId: "route:fixture" });
    fireEvent.click(screen.getByRole("button", { name: "Unnamed climb" }));
    expect(mocks.compare.mock.lastCall?.[0]).toMatchObject({ sectionId: "climb:fixture" });
  });

  it.each(["fetching", "paused"] as const)(
    "hides names while consent revalidation is %s and restores the chosen name on confirmation",
    async (status) => {
      labelPreference = { value: true };
      detail = ghostNamesReady;
      const view = render(panel());
      fireEvent.click(await screen.findByRole("button", { name: "Cedar Road" }));
      expect(mocks.compare.mock.lastCall?.[0]).toMatchObject({ passId: "road-pass" });

      labelsFetchStatus = status;
      view.rerender(panel());
      expect(screen.queryAllByText("Cedar Road")).toHaveLength(0);
      expect(screen.queryByRole("link", { name: /OpenStreetMap/ })).toBeNull();
      expect(mocks.compare.mock.lastCall?.[0]).toMatchObject({ sectionId: "route:fixture" });

      labelsFetchStatus = "idle";
      view.rerender(panel());
      expect(
        (await screen.findByRole("button", { name: "Cedar Road" })).getAttribute("aria-selected"),
      ).toBe("true");
      expect(mocks.compare.mock.lastCall?.[0]).toMatchObject({ passId: "road-pass" });
    },
  );

  it("waits for a fresh detail response after a new true consent check before showing names", async () => {
    labelPreference = { value: true };
    detail = ghostNamesReady;
    const view = render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Cedar Road" }));
    expect(mocks.compare.mock.lastCall?.[0]).toMatchObject({ passId: "road-pass" });

    labelsFetchStatus = "fetching";
    view.rerender(panel());
    let finishRefresh:
      | ((result: {
          isSuccess: boolean;
          data: GhostSessionsGetResponse;
          dataUpdatedAt: number;
        }) => void)
      | undefined;
    mocks.refresh.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRefresh = resolve;
        }),
    );
    labelPreference = { value: true };
    labelsFetchStatus = "idle";
    view.rerender(panel());
    expect(screen.queryAllByText("Cedar Road")).toHaveLength(0);
    expect(screen.queryByRole("link", { name: /OpenStreetMap/ })).toBeNull();
    expect(screen.getByText("20s faster")).toBeTruthy();
    expect(mocks.compare.mock.lastCall?.[0]).toMatchObject({ sectionId: "route:fixture" });

    await waitFor(() => expect(finishRefresh).toBeTypeOf("function"));
    expect(mocks.cancel).toHaveBeenLastCalledWith({ activityId: ghostActivityId });
    detailUpdatedAt += 1;
    view.rerender(panel());
    expect(screen.queryAllByText("Cedar Road")).toHaveLength(0);
    const renamed = {
      ...ghostNamesReady,
      sections: ghostNamesReady.sections.map((section) =>
        section.sectionId === "named:road-fixture" && "name" in section
          ? { ...section, name: "Fern Road" }
          : section,
      ),
    };
    await act(async () => {
      detailUpdateCount += 1;
      finishRefresh?.({ isSuccess: true, data: renamed, dataUpdatedAt: detailUpdatedAt });
    });
    expect(screen.queryAllByText("Cedar Road")).toHaveLength(0);
    expect(screen.queryAllByText("Fern Road")).toHaveLength(0);
    detail = renamed;
    view.rerender(panel());
    expect(screen.queryAllByText("Cedar Road")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Fern Road" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(mocks.compare.mock.lastCall?.[0]).toMatchObject({ passId: "road-pass" });
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    expect(mocks.refresh).toHaveBeenLastCalledWith({ cancelRefetch: false });
  });

  it("keeps cached recorded timing and hides names if the fresh detail request fails", async () => {
    labelPreference = { value: true };
    detail = ghostNamesReady;
    detailError = new Error("Detail could not be refreshed");
    mocks.refresh.mockResolvedValueOnce({
      isSuccess: false,
      data: detail,
      dataUpdatedAt: detailUpdatedAt,
    });
    render(panel());
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
    expect(screen.queryAllByText("Cedar Road")).toHaveLength(0);
    expect(screen.queryByRole("link", { name: /OpenStreetMap/ })).toBeNull();
    expect(screen.getByText("20s faster")).toBeTruthy();
  });

  it("rejects cached names restored by a canceled verification that reports success", async () => {
    labelPreference = { value: true };
    detail = ghostNamesReady;
    const detailKey = [
      ["ghostSessions", "get"],
      { input: { activityId: ghostActivityId }, type: "query" },
    ] as const;
    const queryClient = new QueryClient();
    queryClient.setQueryData(detailKey, detail, { updatedAt: detailUpdatedAt });
    const observer = new QueryObserver(queryClient, {
      queryKey: detailKey,
      queryFn: () => new Promise<GhostSessionsGetResponse>(() => {}),
    });
    mocks.getQueryState.mockImplementation((key) => queryClient.getQueryState(key));
    mocks.refresh.mockImplementationOnce(async () => {
      const result = observer.refetch();
      await queryClient.cancelQueries({ queryKey: detailKey });
      return result;
    });
    await act(async () => {
      render(panel());
    });
    const canceled = await mocks.refresh.mock.results[0]?.value;
    queryClient.clear();
    expect(canceled).toMatchObject({ isSuccess: true, data: ghostNamesReady });
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.getQueryState).toHaveBeenCalledWith(detailKey);
    expect(screen.queryAllByText("Cedar Road")).toHaveLength(0);
    expect(screen.queryByRole("link", { name: /OpenStreetMap/ })).toBeNull();
    expect(screen.getByText("20s faster")).toBeTruthy();
    expect(mocks.compare.mock.lastCall?.[0]).toMatchObject({ sectionId: "route:fixture" });
  });

  it("renders the full first visit in separate recorded chunks, with meaningful empty and loading states", () => {
    detail = ghostFirstVisit;
    const view = render(panel());
    expect(screen.getByText("First recorded visit")).toBeTruthy();
    expect(mocks.map.mock.lastCall?.[0].comparison.anchor).toEqual(ghostFullSection.geometry);
    detail = undefined;
    view.rerender(panel());
    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    detailError = new Error("Could not load Ghost Sessions.");
    view.rerender(panel());
    expect(screen.getByTestId("query-state-error")).toBeTruthy();
    detail = { ...ghostReady, availability: "unavailable", sections: [] };
    view.rerender(panel());
    expect(screen.queryByText("Ghost Sessions")).toBeNull();
  });

  it("shows a distinct map-name error without hiding the recorded comparison", async () => {
    labelPreference = { value: true };
    detail = { ...ghostReady, nameStatus: "error" };
    render(panel());
    expect(
      await screen.findByText("Road and trail names are temporarily unavailable."),
    ).toBeTruthy();
    expect(screen.getByText("20s faster")).toBeTruthy();
  });
});
