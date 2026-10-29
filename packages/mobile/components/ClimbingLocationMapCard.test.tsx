import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { trpc } from "../lib/trpc";
import { ClimbingLocationMapCard } from "./ClimbingLocationMapCard";
import { climbingLocationMapFixture } from "./climbing-location-map-fixtures";
import { createClimbingAttachmentTestClient } from "./climbing-log-attachment-test-helpers";

import { nativeCamera } from "./native-map-test-helpers";

const push = vi.hoisted(() => vi.fn());
vi.mock("expo-router", () => ({ useRouter: () => ({ push }) }));
vi.mock("@maplibre/maplibre-react-native", async () => {
  const { nativeMapMock } = await import("./native-map-test-helpers");
  return nativeMapMock;
});

function measure(container: HTMLElement, width = 320) {
  const wrapper = container.querySelector('[data-testid="climbing-location-map-wrapper"]');
  if (!wrapper) throw new Error("Expected map layout wrapper");
  fireEvent(wrapper, new CustomEvent("layout", { detail: { width, height: 280 } }));
}

function zoomToClimbs() {
  fireEvent(screen.getByTestId("map"), new CustomEvent("mapmove", { detail: 14 }));
}

describe("ClimbingLocationMapCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reserves its viewport and shows processing through layout and native startup", () => {
    const view = render(<ClimbingLocationMapCard data={climbingLocationMapFixture} />);
    expect(screen.getByRole("progressbar", { name: "Processing map" })).toBeTruthy();
    expect(screen.getByTestId("climbing-location-map-wrapper").style.height).toBe("280px");
    measure(view.container, 0);
    expect(screen.queryByTestId("map")).toBeNull();
    expect(screen.getByRole("progressbar", { name: "Processing map" })).toBeTruthy();
    measure(view.container);
    const map = screen.getByTestId("map");
    expect(screen.getByRole("progressbar", { name: "Processing map" })).toBeTruthy();
    fireEvent(screen.getByTestId("map"), new Event("mapready"));
    expect(screen.queryByRole("progressbar", { name: "Processing map" })).toBeNull();
    expect(
      JSON.parse(map.getAttribute("data-map-style") ?? "null").sources.openmaptiles,
    ).toBeTruthy();
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
    expect(nativeCamera.easeTo).toHaveBeenLastCalledWith({
      center: [-122.5, 37.5],
      zoom: 10,
      duration: 300,
    });
    fireEvent(map, new CustomEvent("mapmove", { detail: 10 }));
    expect(screen.getByTitle("2 climbs at this location")).toBeTruthy();

    nativeCamera.fitBounds.mockClear();
    zoomToClimbs();
    expect(screen.getByTestId("map")).toBe(map);
    expect(nativeCamera.fitBounds).not.toHaveBeenCalled();
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

  it("opens a cancellable activity picker for the exact unattached climb", () => {
    const fixture = createClimbingAttachmentTestClient();
    const view = render(
      <trpc.Provider client={fixture.client} queryClient={fixture.queryClient}>
        <QueryClientProvider client={fixture.queryClient}>
          <ClimbingLocationMapCard data={climbingLocationMapFixture} />
        </QueryClientProvider>
      </trpc.Provider>,
    );
    measure(view.container);
    zoomToClimbs();
    fireEvent.click(screen.getByTitle("2 climbs at this location"));

    expect(fixture.requests).toHaveLength(0);
    fireEvent.click(
      screen.getByRole("button", { name: "Attach to activity for Swiss Cheese repeat" }),
    );
    expect(screen.getByRole("header").textContent).toBe("Attach to activity");
    expect(screen.getByText("Swiss Cheese repeat · 2026-10-11")).toBeTruthy();
    expect(
      screen.getByText("Choose a recorded climbing or hiking activity from this day."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel attachment" }));
    expect(screen.queryByRole("header")).toBeNull();
    expect(screen.getByText("Swiss Cheese repeat")).toBeTruthy();
    expect(screen.getByTestId("map")).toBeTruthy();
  });

  it("refits the mounted map when the filtered location bounds change", () => {
    const view = render(<ClimbingLocationMapCard data={climbingLocationMapFixture} />);
    measure(view.container);
    const map = screen.getByTestId("map");
    nativeCamera.fitBounds.mockClear();
    view.rerender(
      <ClimbingLocationMapCard
        data={{
          ...climbingLocationMapFixture,
          bounds: { south: 40, west: -74, north: 41, east: -73 },
        }}
      />,
    );
    expect(screen.getByTestId("map")).toBe(map);
    expect(nativeCamera.fitBounds).toHaveBeenCalledWith(
      expect.arrayContaining([-74.15, 39.85, -72.85, 41.15]),
      expect.objectContaining({ duration: 300 }),
    );
  });

  it("preserves cached map data and shows the server message during a refresh failure", () => {
    const view = render(<ClimbingLocationMapCard data={climbingLocationMapFixture} />);
    measure(view.container);
    const map = screen.getByTestId("map");
    fireEvent(screen.getByTestId("map"), new Event("mapready"));
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
    expect(screen.queryByRole("progressbar", { name: "Processing map" })).toBeNull();
  });

  it("shows processing again when an empty result is replaced by a newly mounted map", () => {
    const view = render(<ClimbingLocationMapCard data={climbingLocationMapFixture} />);
    measure(view.container);
    const originalMap = screen.getByTestId("map");
    fireEvent(screen.getByTestId("map"), new Event("mapready"));
    expect(screen.queryByRole("progressbar", { name: "Processing map" })).toBeNull();
    view.rerender(<ClimbingLocationMapCard data={{ bounds: null, nodes: [] }} />);
    expect(screen.getByText("No climbing locations in this period")).toBeTruthy();
    view.rerender(<ClimbingLocationMapCard data={climbingLocationMapFixture} />);
    expect(screen.getByTestId("map")).not.toBe(originalMap);
    expect(screen.getByRole("progressbar", { name: "Processing map" })).toBeTruthy();
    fireEvent(screen.getByTestId("map"), new Event("mapready"));
    expect(screen.queryByRole("progressbar", { name: "Processing map" })).toBeNull();
  });

  it("reports native map failures without hiding cached climb data", () => {
    const view = render(<ClimbingLocationMapCard data={climbingLocationMapFixture} />);
    measure(view.container);
    fireEvent(screen.getByTestId("map"), new Event("maperror"));
    expect(
      screen.getByText("Map unavailable. Check your connection and reopen climbing locations."),
    ).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("distinguishes first-load, failed and empty map states", () => {
    const view = render(<ClimbingLocationMapCard data={undefined} loading />);
    const status = screen.getByRole("progressbar", { name: "Processing map" });
    expect(status.parentElement?.getAttribute("style")).toContain("height: 280px");
    view.rerender(
      <ClimbingLocationMapCard data={undefined} error={{ message: "Reconnect your account." }} />,
    );
    expect(screen.getByText("Reconnect your account.")).toBeTruthy();
    expect(screen.queryByText("No climbing locations in this period")).toBeNull();
    view.rerender(<ClimbingLocationMapCard data={{ bounds: null, nodes: [] }} />);
    expect(screen.getByText("No climbing locations in this period")).toBeTruthy();
  });
});
