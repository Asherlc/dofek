/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maps, markers, resetMaps } from "../lib/maplibre-test-helpers.ts";
import { ActivityRouteMap } from "./ActivityRouteMap.tsx";

vi.mock("maplibre-gl", async () => (await import("../lib/maplibre-test-helpers.ts")).maplibreMock);
const captureException = vi.hoisted(() => vi.fn());
vi.mock("../lib/telemetry.ts", () => ({ captureException }));
beforeEach(() => {
  resetMaps();
  captureException.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const exact = {
  entryId: "tick-1",
  label: "Blue Arete",
  location: {
    coordinates: { latitude: 37.8, longitude: -122.4 },
    scope: "climb" as const,
    objectId: "climb-1",
    providerId: "mountain-project",
    name: "Blue Arete",
  },
};

describe("ActivityRouteMap", () => {
  it("centers and zooms on selection, including selections made before initialization", async () => {
    const points: { lat: number; lng: number }[] = [];
    const area = {
      ...exact,
      entryId: "area",
      location: {
        ...exact.location,
        scope: "area" as const,
        coordinates: { latitude: 38, longitude: -123 },
      },
    };
    const climbMarkers = [exact, area];
    const view = render(
      <ActivityRouteMap points={points} climbMarkers={climbMarkers} selectedEntryId="tick-1" />,
    );
    await waitFor(() =>
      expect(maps[0]?.easeTo).toHaveBeenCalledWith({
        center: [-122.4, 37.8],
        zoom: 16,
        duration: 600,
      }),
    );
    view.rerender(
      <ActivityRouteMap points={points} climbMarkers={climbMarkers} selectedEntryId="area" />,
    );
    expect(maps[0]?.easeTo).toHaveBeenLastCalledWith({
      center: [-123, 38],
      zoom: 16,
      duration: 600,
    });
    view.rerender(
      <ActivityRouteMap points={points} climbMarkers={climbMarkers} selectedEntryId="unlocated" />,
    );
    expect(maps[0]?.easeTo).toHaveBeenCalledTimes(2);
    expect(maps).toHaveLength(1);
    expect(maps[0]?.fitBounds).toHaveBeenCalledOnce();
  });
  it("initializes the shared vector style and waits for map load", async () => {
    render(<ActivityRouteMap points={[]} climbMarkers={[exact]} />);
    expect(screen.getByRole("status")).toHaveTextContent("Processing map…");
    await waitFor(() => expect(maps).toHaveLength(1));
    expect(maps[0]?.options.style).toMatchObject({
      version: 8,
      sources: { openmaptiles: expect.anything() },
    });
    act(() => maps[0]?.fire("load"));
    expect(screen.queryByRole("status")).toBeNull();
  });
  it.each(["click", "Enter", " "])("selects a unique climb using %s", async (key) => {
    const onSelectEntry = vi.fn();
    render(<ActivityRouteMap points={[]} climbMarkers={[exact]} onSelectEntry={onSelectEntry} />);
    const dot = await screen.findByRole("button", {
      name: "Blue Arete · Climb location: Blue Arete · Mountain Project",
    });
    fireEvent.keyDown(dot, { key: "Escape" });
    expect(onSelectEntry).not.toHaveBeenCalled();
    if (key === "click") fireEvent.click(dot);
    else fireEvent.keyDown(dot, { key });
    expect(onSelectEntry).toHaveBeenCalledExactlyOnceWith("tick-1");
  });
  it("selects the first occurrence from a counted, safely labelled marker", async () => {
    const onSelectEntry = vi.fn();
    const unsafe = '<img src=x onerror="alert(1)">';
    const { container } = render(
      <ActivityRouteMap
        points={[]}
        climbMarkers={[
          { ...exact, label: unsafe },
          { ...exact, entryId: "repeat", label: unsafe },
        ]}
        onSelectEntry={onSelectEntry}
      />,
    );
    const group = await screen.findByRole("button", { name: /^2 climbs/ });
    expect(group).toHaveTextContent("2");
    expect(group).toHaveAttribute("data-entry-ids", JSON.stringify(["tick-1", "repeat"]));
    fireEvent.focus(group);
    expect(screen.getByRole("tooltip")).toHaveTextContent(unsafe);
    expect(container.querySelector("[role=tooltip] img")).toBeNull();
    fireEvent.blur(group);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.keyDown(group, { key: "Enter" });
    expect(onSelectEntry).toHaveBeenCalledWith("tick-1");
    expect(group).toHaveAttribute("aria-pressed", "true");
  });
  it("preserves route, endpoints, source points and chart hover independently", async () => {
    const hover = { current: (_position: { lat: number; lng: number } | null) => {} };
    const view = render(
      <ActivityRouteMap
        points={[
          { lat: 37, lng: -122 },
          { lat: 38, lng: -123 },
        ]}
        climbMarkers={[exact]}
        onRegisterHoverCallback={hover}
      />,
    );
    await screen.findByRole("button", { name: /Blue Arete/ });
    act(() => maps[0]?.fire("load"));
    expect(maps[0]?.addSource).toHaveBeenCalledWith(
      "activity-route",
      expect.objectContaining({
        data: expect.objectContaining({
          geometry: {
            type: "LineString",
            coordinates: [
              [-122, 37],
              [-123, 38],
            ],
          },
        }),
      }),
    );
    expect(markers).toHaveLength(3);
    act(() => hover.current({ lat: 39, lng: -124 }));
    expect(markers.at(-1)?.coordinates).toEqual([-124, 39]);
    act(() => hover.current({ lat: 40, lng: -125 }));
    expect(markers).toHaveLength(4);
    expect(markers.at(-1)?.coordinates).toEqual([-125, 40]);
    act(() => hover.current(null));
    expect(markers.at(-1)?.remove).toHaveBeenCalled();
    view.unmount();
    expect(maps[0]?.remove).toHaveBeenCalledOnce();
  });
  it("retains source selection on tile errors and reports each map error once", async () => {
    const onSelectEntry = vi.fn();
    render(<ActivityRouteMap points={[]} climbMarkers={[exact]} onSelectEntry={onSelectEntry} />);
    const dot = await screen.findByRole("button", { name: /Blue Arete/ });
    act(() => {
      maps[0]?.fire("error", { error: new Error("offline") });
      maps[0]?.fire("error", { error: new Error("offline") });
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Some map tiles could not load. Check your connection.",
    );
    fireEvent.click(dot);
    expect(onSelectEntry).toHaveBeenCalledWith("tick-1");
    expect(captureException).toHaveBeenCalledOnce();
  });
  it("reports initialization failures and removes partial maps", async () => {
    render(
      <ActivityRouteMap
        points={[]}
        climbMarkers={[
          {
            ...exact,
            location: { ...exact.location, coordinates: { latitude: NaN, longitude: 0 } },
          },
        ]}
      />,
    );
    expect(await screen.findByText(/Map unavailable: Invalid LngLat/)).toBeVisible();
    expect(captureException).toHaveBeenCalled();
    expect(maps[0]?.remove).toHaveBeenCalled();
  });
  it("updates the system palette while preserving the camera, markers and route", async () => {
    const events = new EventTarget();
    const query = {
      ...window.matchMedia("(prefers-color-scheme: dark)"),
      matches: false,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    };
    vi.spyOn(window, "matchMedia").mockReturnValue(query);
    render(
      <ActivityRouteMap
        points={[
          { lat: 37, lng: -122 },
          { lat: 38, lng: -123 },
        ]}
        climbMarkers={[exact]}
      />,
    );
    await screen.findByRole("button", { name: /Blue Arete/ });
    act(() => maps[0]?.fire("load"));
    query.matches = true;
    act(() => events.dispatchEvent(new Event("change")));
    expect(maps[0]?.setStyle).toHaveBeenCalledWith(
      expect.objectContaining({
        layers: expect.arrayContaining([
          expect.objectContaining({ id: "background", paint: { "background-color": "#1a2a20" } }),
        ]),
      }),
    );
    act(() => maps[0]?.fire("style.load"));
    expect(maps[0]?.addSource).toHaveBeenCalledTimes(2);
    expect(maps[0]?.fitBounds).toHaveBeenCalledOnce();
    expect(markers).toHaveLength(3);
  });
  it("defers compact maps and releases them when offscreen", async () => {
    let intersect = (_visible: boolean) => {};
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
          intersect = (visible) => callback([{ isIntersecting: visible }]);
        }
        observe() {}
        disconnect() {}
      },
    );
    render(<ActivityRouteMap points={[]} climbMarkers={[exact]} presentation="compact" />);
    expect(maps).toHaveLength(0);
    act(() => intersect(true));
    await waitFor(() => expect(maps).toHaveLength(1));
    act(() => intersect(false));
    expect(maps[0]?.remove).toHaveBeenCalled();
  });
  it("shows the empty state", () => {
    render(<ActivityRouteMap points={[]} />);
    expect(screen.getByText("No GPS locations available.")).toBeVisible();
  });
});
