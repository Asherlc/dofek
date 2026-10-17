/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityRouteMap } from "./ActivityRouteMap.tsx";

const captureException = vi.hoisted(() => vi.fn());
vi.mock("../lib/telemetry.ts", () => ({ captureException }));
beforeEach(() => captureException.mockClear());
afterEach(() => vi.unstubAllGlobals());

// Leaflet detects SVG support through this browser API, which jsdom omits.
const originalCreateSvgRect = Object.getOwnPropertyDescriptor(
  SVGSVGElement.prototype,
  "createSVGRect",
);
beforeAll(() => {
  Object.defineProperty(SVGSVGElement.prototype, "createSVGRect", {
    configurable: true,
    value: () => ({}),
  });
});
afterAll(() => {
  if (originalCreateSvgRect) {
    Object.defineProperty(SVGSVGElement.prototype, "createSVGRect", originalCreateSvgRect);
  } else {
    Reflect.deleteProperty(SVGSVGElement.prototype, "createSVGRect");
  }
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
  it("shows processing until the initial map tiles load", async () => {
    const { container } = render(<ActivityRouteMap points={[]} climbMarkers={[exact]} />);
    expect(screen.getByRole("status")).toHaveTextContent("Processing map…");
    await waitFor(() => expect(container.querySelector("img.leaflet-tile")).not.toBeNull());
    expect(screen.getByRole("status")).toHaveTextContent("Processing map…");
    for (const tile of container.querySelectorAll("img.leaflet-tile")) fireEvent.load(tile);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it.each(["click", "Enter", " "])(
    "opens a unique location immediately with %s",
    async (activation) => {
      const onSelectEntry = vi.fn();
      render(
        <ActivityRouteMap
          points={[]}
          climbMarkers={[
            exact,
            {
              ...exact,
              entryId: "different-longitude",
              location: { ...exact.location, coordinates: { latitude: 37.8, longitude: -122.5 } },
            },
            {
              ...exact,
              entryId: "different-latitude",
              location: { ...exact.location, coordinates: { latitude: 37.9, longitude: -122.4 } },
            },
          ]}
          onSelectEntry={onSelectEntry}
        />,
      );
      const dot = await screen.findByRole("button", {
        name: "Entry 1 · Blue Arete · Climb location: Blue Arete · Mountain Project",
      });
      fireEvent.keyDown(dot, { key: "Escape" });
      expect(onSelectEntry).not.toHaveBeenCalled();
      if (activation === "click") fireEvent.click(dot);
      else fireEvent.keyDown(dot, { key: activation });
      expect(onSelectEntry).toHaveBeenCalledExactlyOnceWith("tick-1");
      expect(screen.queryByRole("list", { name: "Climbing entries at this location" })).toBeNull();
    },
  );

  it("reserves an offscreen compact preview until it approaches the viewport, then mounts once", async () => {
    let enterViewport = () => {};
    const disconnect = vi.fn();
    const observe = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
          enterViewport = () => callback([{ isIntersecting: true }]);
        }
        observe = observe;
        disconnect = disconnect;
      },
    );
    const markers = [exact];
    const points: { lat: number; lng: number }[] = [];
    const view = render(
      <ActivityRouteMap points={points} climbMarkers={markers} presentation="compact" />,
    );
    await act(async () => {
      await import("leaflet");
    });
    const region = screen.getByRole("region", { name: "Climbing locations" });
    expect(region).toHaveClass("h-[160px]");
    expect(region).not.toHaveClass("leaflet-container");
    expect(screen.getByRole("status")).toHaveTextContent("Processing map…");
    expect(view.container.querySelector("img.leaflet-tile")).toBeNull();
    expect(observe).toHaveBeenCalledWith(region);
    act(() => enterViewport());
    await waitFor(() => expect(view.container.querySelector("img.leaflet-tile")).not.toBeNull());
    const tile = view.container.querySelector("img.leaflet-tile");
    view.rerender(
      <ActivityRouteMap points={points} climbMarkers={markers} presentation="compact" />,
    );
    act(() => enterViewport());
    expect(view.container.querySelector("img.leaflet-tile")).toBe(tile);
    expect(observe).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalled();
  });

  it("opens all same-name occurrences from the top overlapping dot and selects their card identities", async () => {
    const onSelectEntry = vi.fn();
    const { container } = render(
      <ActivityRouteMap
        points={[]}
        climbMarkers={[
          { ...exact, entryNumber: 1 },
          { ...exact, entryId: "repeat", entryNumber: 3 },
        ]}
        onSelectEntry={onSelectEntry}
      />,
    );
    await waitFor(() => expect(container.querySelectorAll("[data-entry-id]")).toHaveLength(2));
    const topDot = container.querySelector('[data-entry-id="repeat"]');
    if (!topDot) throw new Error("Expected the top overlapping dot");
    fireEvent.click(topDot);
    expect(onSelectEntry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Entry 1 · Blue Arete" }));
    expect(onSelectEntry).toHaveBeenLastCalledWith("tick-1");
    fireEvent.click(screen.getByRole("button", { name: "Entry 3 · Blue Arete" }));
    expect(onSelectEntry).toHaveBeenLastCalledWith("repeat");
    expect(screen.getByRole("button", { name: "Entry 3 · Blue Arete" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(container.querySelectorAll(".leaflet-overlay-pane path")).toHaveLength(2);
  });

  it.each(["Enter", " "])("opens coincident occurrences using the %s key", async (key) => {
    const onSelectEntry = vi.fn();
    render(
      <ActivityRouteMap
        points={[]}
        climbMarkers={[exact, { ...exact, entryId: "repeat" }]}
        onSelectEntry={onSelectEntry}
      />,
    );
    const dot = await screen.findByRole("button", {
      name: "Entry 2 · Blue Arete · Climb location: Blue Arete · Mountain Project",
    });
    expect(screen.queryByRole("list", { name: "Climbing entries at this location" })).toBeNull();
    fireEvent.keyDown(dot, { key });
    expect(onSelectEntry).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Entry 1 · Blue Arete" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Entry 2 · Blue Arete" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Entry 1 · Blue Arete" }));
    expect(onSelectEntry).toHaveBeenCalledExactlyOnceWith("tick-1");
  });
  it("keeps opaque tick identities separate from readable source-dot labels", async () => {
    const firstId = "f0e5f441-1c6d-4e20-a2a3-41103e7314a0";
    const secondId = "ab648e3e-5ec8-4ac8-817c-47edc84eddb4";
    const label = "Entry 1 · Blue Arete · Climb location: Blue Arete · Mountain Project";
    const { container } = render(
      <ActivityRouteMap
        points={[]}
        climbMarkers={[
          { ...exact, entryId: firstId },
          { ...exact, entryId: secondId },
        ]}
      />,
    );
    await waitFor(() => expect(container.querySelectorAll("[data-entry-id]")).toHaveLength(2));
    const dots = container.querySelectorAll("[data-entry-id]");
    expect(dots[0]).toHaveAttribute("data-entry-id", firstId);
    expect(dots[1]).toHaveAttribute("data-entry-id", secondId);
    expect(dots[0]).toHaveAttribute("aria-label", label);
    expect(dots[1]).toHaveAttribute("aria-label", label.replace("Entry 1", "Entry 2"));
    const firstDot = dots[0];
    if (!firstDot) throw new Error("Expected a first source dot");
    fireEvent.mouseOver(firstDot);
    expect(container.querySelector(".leaflet-tooltip")?.textContent).toBe(label);
  });

  it("exposes source dots and their labels to keyboard users", async () => {
    const { container } = render(<ActivityRouteMap points={[]} climbMarkers={[exact]} />);
    const dot = await screen.findByRole("button", {
      name: "Entry 1 · Blue Arete · Climb location: Blue Arete · Mountain Project",
    });
    expect(dot).toHaveAttribute("tabindex", "0");
    fireEvent.focus(dot);
    expect(container.querySelector(".leaflet-tooltip")).toHaveTextContent("Blue Arete");
    fireEvent.blur(dot);
    expect(container.querySelector(".leaflet-tooltip")).toBeNull();
  });

  it("reports map initialization errors with a usable error state", async () => {
    render(
      <ActivityRouteMap
        points={[]}
        climbMarkers={[
          {
            ...exact,
            location: {
              ...exact.location,
              coordinates: { latitude: Number.NaN, longitude: -122.4 },
            },
          },
        ]}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Map unavailable: Invalid LatLng object",
      ),
    );
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      component: "ActivityRouteMap",
    });
  });

  it("keeps the recorded route and source points usable after a tile fails", async () => {
    const onAttach = vi.fn();
    const onSelectEntry = vi.fn();
    const { container } = render(
      <div>
        <ActivityRouteMap
          points={[
            { lat: 37.79, lng: -122.41 },
            { lat: 37.81, lng: -122.39 },
          ]}
          climbMarkers={[exact]}
          onSelectEntry={onSelectEntry}
        />
        <button type="button" onClick={onAttach}>
          Attach
        </button>
      </div>,
    );
    await waitFor(() => expect(container.querySelector("img.leaflet-tile")).not.toBeNull());
    const tile = container.querySelector("img.leaflet-tile");
    if (!tile) throw new Error("Expected a map tile");
    fireEvent.error(tile);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Some map tiles could not load. Check your connection.",
    );
    const region = screen.getByRole("region", { name: "Climbing locations" });
    expect(region).not.toHaveClass("hidden");
    expect(region.querySelectorAll(".leaflet-overlay-pane path")).toHaveLength(4);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Entry 1 · Blue Arete · Climb location: Blue Arete · Mountain Project",
      }),
    );
    expect(onSelectEntry).toHaveBeenCalledExactlyOnceWith("tick-1");
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    expect(onAttach).toHaveBeenCalledOnce();
    fireEvent.error(tile);
    expect(captureException).toHaveBeenCalledOnce();
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      component: "ActivityRouteMap",
    });
  });

  it("renders a source dot without a sensor route or Start/Finish pins", async () => {
    const { container } = render(<ActivityRouteMap points={[]} climbMarkers={[exact]} />);
    const region = screen.getByRole("region", { name: "Climbing locations" });
    await waitFor(() =>
      expect(region.querySelectorAll(".leaflet-overlay-pane path")).toHaveLength(1),
    );
    expect(
      screen.getByLabelText("Entry 1 · Blue Arete · Climb location: Blue Arete · Mountain Project"),
    ).toBeInTheDocument();
    expect(container.querySelector(".leaflet-control-attribution")).toHaveTextContent(
      "OpenStreetMap",
    );
    expect(container.querySelector("img.leaflet-tile")?.getAttribute("src")).toMatch(
      /\/15\/[0-9]+\/[0-9]+\.png$/,
    );
  });

  it("draws the sensor polyline and endpoints independently of source dots", async () => {
    const { container } = render(
      <ActivityRouteMap
        points={[
          { lat: 37.79, lng: -122.41 },
          { lat: 37.81, lng: -122.39 },
        ]}
        climbMarkers={[exact]}
      />,
    );
    await waitFor(() =>
      expect(container.querySelectorAll(".leaflet-overlay-pane path")).toHaveLength(4),
    );
    expect(
      screen.getByLabelText("Entry 1 · Blue Arete · Climb location: Blue Arete · Mountain Project"),
    ).toBeInTheDocument();
  });

  it("retains repeated occurrences at the same point and safe area tooltip text", async () => {
    const label = '<img src=x onerror="alert(1)"> & ridge';
    const area = {
      ...exact,
      entryId: "tick-2",
      label,
      location: { ...exact.location, scope: "area" as const, name: "Goat Rock" },
    };
    const { container } = render(<ActivityRouteMap points={[]} climbMarkers={[exact, area]} />);
    await waitFor(() =>
      expect(container.querySelectorAll(".leaflet-overlay-pane path")).toHaveLength(2),
    );
    const dot = screen.getByLabelText(
      `Entry 2 · ${label} · Area location: Goat Rock · Mountain Project`,
    );
    fireEvent.mouseOver(dot);
    await waitFor(() =>
      expect(container.querySelector(".leaflet-tooltip")).toHaveTextContent(
        `Entry 2 · ${label} · Area location: Goat Rock · Mountain Project`,
      ),
    );
    expect(container.querySelector(".leaflet-tooltip img")).toBeNull();
  });

  it("supports a compact single-point preview with exactly one source dot", async () => {
    const { container } = render(
      <ActivityRouteMap points={[]} climbMarkers={[exact]} presentation="compact" />,
    );
    await waitFor(() =>
      expect(container.querySelectorAll(".leaflet-overlay-pane path")).toHaveLength(1),
    );
    expect(screen.getByRole("region", { name: "Climbing locations" })).toHaveClass("h-[160px]");
  });

  it("shows an explicit empty state when neither sensor nor source GPS is supplied", () => {
    render(<ActivityRouteMap points={[]} />);
    expect(screen.getByText("No GPS locations available.")).toBeInTheDocument();
  });
});
