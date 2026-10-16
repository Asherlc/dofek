import { act, fireEvent, render, screen } from "@testing-library/react";
import { createElement, forwardRef, type ReactNode, useImperativeHandle } from "react";
import type { Region } from "react-native-maps";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClimbingLocationMapCard } from "./ClimbingLocationMapCard";
import { climbingLocationMapFixture } from "./climbing-location-map-fixtures";

const nativeMap = vi.hoisted<{
  animateToRegion: ReturnType<typeof vi.fn>;
  onRegionChangeComplete: ((region: Region) => void) | null;
}>(() => ({
  animateToRegion: vi.fn(),
  onRegionChangeComplete: null,
}));
const push = vi.hoisted(() => vi.fn());

vi.mock("expo-router", () => ({ useRouter: () => ({ push }) }));
vi.mock("react-native-maps", () => ({
  default: forwardRef(function MockMap(
    {
      children,
      onRegionChangeComplete,
      scrollEnabled,
      zoomEnabled,
    }: {
      children: ReactNode;
      onRegionChangeComplete: (region: Region) => void;
      scrollEnabled: boolean;
      zoomEnabled: boolean;
    },
    ref,
  ) {
    nativeMap.onRegionChangeComplete = onRegionChangeComplete;
    useImperativeHandle(ref, () => nativeMap);
    return createElement(
      "div",
      {
        "data-testid": "map",
        "data-interactive": scrollEnabled && zoomEnabled,
      },
      children,
    );
  }),
  Marker: ({
    title,
    accessibilityLabel,
    children,
    onPress,
  }: {
    title: string;
    accessibilityLabel: string;
    children: ReactNode;
    onPress: () => void;
  }) =>
    createElement(
      "button",
      { title, "aria-label": accessibilityLabel, type: "button", onClick: onPress },
      children,
    ),
}));

function measure(container: HTMLElement) {
  const wrapper = container.querySelector('[data-testid="climbing-location-map-wrapper"]');
  if (!wrapper) throw new Error("Expected map layout wrapper");
  fireEvent(wrapper, new CustomEvent("layout", { detail: { width: 320, height: 280 } }));
}

function zoomToClimbs() {
  act(() =>
    nativeMap.onRegionChangeComplete?.({
      latitude: 37.5,
      longitude: -122.5,
      latitudeDelta: 0.005,
      longitudeDelta: 0.005,
    }),
  );
}

describe("ClimbingLocationMapCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nativeMap.onRegionChangeComplete = null;
  });

  it("keeps one interactive map and the same dot color as clusters separate into climbs", () => {
    const view = render(<ClimbingLocationMapCard data={climbingLocationMapFixture} />);
    measure(view.container);
    const map = screen.getByTestId("map");
    expect(map.getAttribute("data-interactive")).toBe("true");
    const cluster = screen.getByRole("button", { name: "3 climbs · Zoom in" });
    const clusterDot = cluster.firstElementChild;
    expect(clusterDot?.getAttribute("style")).toContain("width: 44px");
    fireEvent.click(cluster);
    expect(nativeMap.animateToRegion).toHaveBeenLastCalledWith(
      expect.objectContaining({ latitude: 37.5, longitude: -122.5, longitudeDelta: 0.2197265625 }),
      300,
    );
    const targetRegion = nativeMap.animateToRegion.mock.lastCall?.[0];
    act(() => nativeMap.onRegionChangeComplete?.(targetRegion));
    expect(screen.getByTitle("2 climbs at this location")).toBeTruthy();

    nativeMap.animateToRegion.mockClear();
    zoomToClimbs();
    expect(screen.getByTestId("map")).toBe(map);
    expect(nativeMap.animateToRegion).not.toHaveBeenCalled();
    const leaf = screen.getByTitle("2 climbs at this location");
    expect(leaf.firstElementChild?.getAttribute("style")).toContain("width: 24px");
    expect(leaf.firstElementChild?.getAttribute("style")).toContain(
      clusterDot?.getAttribute("style")?.match(/background-color: [^;]+/)?.[0],
    );
    expect(screen.getByTitle("Left Arete")).toBeTruthy();
    expect(screen.queryByTitle("3 climbs · Zoom in")).toBeNull();
  });

  it("shows every repeated climb, its date, grade, source, scope and available activity link", () => {
    const view = render(<ClimbingLocationMapCard data={climbingLocationMapFixture} />);
    measure(view.container);
    zoomToClimbs();
    fireEvent.click(screen.getByTitle("2 climbs at this location"));
    expect(screen.getByText("Swiss Cheese")).toBeTruthy();
    expect(screen.getByText("Swiss Cheese repeat")).toBeTruthy();
    expect(screen.getAllByText(/V4/)).toHaveLength(2);
    expect(screen.getAllByText(/Climb location: Swiss Cheese · Mountain Project/)).toHaveLength(2);
    expect(screen.getByText(/Oct 10/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View activity for Swiss Cheese" }));
    expect(push).toHaveBeenCalledWith("/activity/activity-1");
    expect(
      screen.queryByRole("button", { name: "View activity for Swiss Cheese repeat" }),
    ).toBeNull();
    fireEvent.click(screen.getByTitle("Left Arete"));
    expect(screen.getByText("Area location: Goat Rock · OpenBeta")).toBeTruthy();
  });

  it("refits the mounted map when the filtered location bounds change", () => {
    const view = render(<ClimbingLocationMapCard data={climbingLocationMapFixture} />);
    measure(view.container);
    const map = screen.getByTestId("map");
    nativeMap.animateToRegion.mockClear();
    view.rerender(
      <ClimbingLocationMapCard
        data={{
          ...climbingLocationMapFixture,
          bounds: { south: 40, west: -74, north: 41, east: -73 },
        }}
      />,
    );
    expect(screen.getByTestId("map")).toBe(map);
    expect(nativeMap.animateToRegion).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: 40.5, longitude: -73.5 }),
      300,
    );
  });

  it("preserves cached map data and shows the server message during a refresh failure", () => {
    const view = render(<ClimbingLocationMapCard data={climbingLocationMapFixture} />);
    measure(view.container);
    const map = screen.getByTestId("map");
    view.rerender(
      <ClimbingLocationMapCard
        data={climbingLocationMapFixture}
        loading
        error={{ message: "Climbing locations are temporarily unavailable. Try again." }}
      />,
    );
    expect(screen.getByTestId("map")).toBe(map);
    expect(
      screen.getByText("Climbing locations are temporarily unavailable. Try again."),
    ).toBeTruthy();
    expect(screen.queryByTestId("query-state-loading")).toBeNull();
  });

  it("distinguishes first-load, failed and empty map states", () => {
    const view = render(<ClimbingLocationMapCard data={undefined} loading />);
    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    view.rerender(
      <ClimbingLocationMapCard data={undefined} error={{ message: "Reconnect your account." }} />,
    );
    expect(screen.getByText("Reconnect your account.")).toBeTruthy();
    expect(screen.queryByText("No climbing locations in this period")).toBeNull();
    view.rerender(<ClimbingLocationMapCard data={{ bounds: null, nodes: [] }} />);
    expect(screen.getByText("No climbing locations in this period")).toBeTruthy();
  });
});
