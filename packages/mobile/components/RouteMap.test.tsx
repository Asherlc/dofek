import type { ClimbingMapMarker } from "@dofek/training/climbing-map";
import { fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactNode, useEffect, useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { RouteMap } from "./RouteMap";

vi.mock("react-native-maps", () => ({
  default: ({
    children,
    initialRegion,
    region,
    style,
    scrollEnabled,
    zoomEnabled,
    pointerEvents,
    onMapReady,
    loadingEnabled,
  }: {
    children: ReactNode;
    initialRegion?: unknown;
    region?: unknown;
    style: { width: number; height: number };
    scrollEnabled?: boolean;
    zoomEnabled?: boolean;
    pointerEvents?: string;
    onMapReady?: () => void;
    loadingEnabled?: boolean;
  }) => {
    const [mountedRegion] = useState(initialRegion);
    const mapRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
      const map = mapRef.current;
      if (!map || !onMapReady) return;
      map.addEventListener("mapready", onMapReady);
      return () => map.removeEventListener("mapready", onMapReady);
    }, [onMapReady]);
    return createElement(
      "div",
      {
        "data-testid": "map",
        "data-region": JSON.stringify(region ?? mountedRegion),
        "data-scroll": String(scrollEnabled),
        "data-zoom": String(zoomEnabled),
        "data-pointer-events": pointerEvents,
        "data-native-loading-enabled": String(loadingEnabled),
        style,
        ref: mapRef,
      },
      children,
    );
  },
  Marker: ({
    coordinate,
    title,
    description,
    children,
    onPress,
  }: {
    coordinate: unknown;
    title?: string;
    description?: string;
    children?: ReactNode;
    onPress?: () => void;
  }) =>
    createElement(
      "div",
      {
        "data-testid": "marker",
        "data-coordinate": JSON.stringify(coordinate),
        title,
        onClick: onPress,
      },
      description,
      children,
    ),
  Polyline: ({ coordinates }: { coordinates: unknown }) =>
    createElement("div", {
      "data-testid": "polyline",
      "data-coordinates": JSON.stringify(coordinates),
    }),
}));

const climbMarkers: ClimbingMapMarker[] = [
  {
    entryId: "tick-1",
    label: "Swiss Cheese",
    location: {
      coordinates: { latitude: 40.752, longitude: -73.98 },
      scope: "climb",
      objectId: "route-1",
      providerId: "mountain-project",
      name: "Swiss Cheese",
    },
  },
  {
    entryId: "tick-2",
    label: "Left Arete",
    location: {
      coordinates: { latitude: 40.753, longitude: -73.979 },
      scope: "area",
      objectId: "area-1",
      providerId: "openbeta",
      name: "Goat Rock",
    },
  },
];

function measure(container: HTMLElement, width = 320) {
  const wrapper = container.querySelectorAll("view").item(1);
  if (!wrapper) throw new Error("Expected a map layout wrapper");
  fireEvent(wrapper, new CustomEvent("layout", { detail: { width, height: 280 } }));
}

const gpsPoints = [
  { lat: 40.748, lng: -73.985 },
  { lat: 40.749, lng: -73.984 },
  { lat: 40.75, lng: -73.983 },
  { lat: 40.751, lng: -73.982 },
];

describe("RouteMap", () => {
  it("lists and selects every named climb sharing an area location", () => {
    const first = climbMarkers[0];
    if (!first) throw new Error("Expected a climb marker fixture");
    const markers = ["Bits and Bits", "Kibbles and Bits", "Blue Arete", "Left Arete"].map(
      (label, index) => ({
        ...first,
        entryId: `area-log-${index}`,
        label,
        location: { ...first.location, scope: "area" as const, name: "Johnny Wall" },
      }),
    );
    const onSelectEntry = vi.fn();
    const { container } = render(
      <RouteMap points={[]} climbMarkers={markers} onSelectEntry={onSelectEntry} />,
    );
    measure(container);
    const marker = screen.getByTitle(
      "4 climbs · Bits and Bits · Kibbles and Bits · Blue Arete · Left Arete",
    );
    expect(marker.textContent).toBe("Area location: Johnny Wall · Mountain Project4");
    expect(screen.getAllByTestId("marker")).toHaveLength(1);
    fireEvent.click(marker);
    for (const entry of markers) {
      fireEvent.click(screen.getByRole("button", { name: entry.label }));
      expect(onSelectEntry).toHaveBeenLastCalledWith(entry.entryId);
    }
  });

  it("opens a uniquely located entry directly and permits overview pan and zoom", () => {
    const onSelectEntry = vi.fn();
    const { container } = render(
      <RouteMap points={[]} climbMarkers={climbMarkers} onSelectEntry={onSelectEntry} />,
    );
    measure(container);
    const marker = screen.getAllByTestId("marker")[1];
    if (!marker) throw new Error("Expected a unique climb marker");
    fireEvent.click(marker);
    expect(onSelectEntry).toHaveBeenCalledWith("tick-2");
    expect(screen.getByTestId("map").getAttribute("data-scroll")).toBe("true");
    expect(screen.getByTestId("map").getAttribute("data-zoom")).toBe("true");
  });

  it("keeps compact maps noninteractive", () => {
    const onSelectEntry = vi.fn();
    const { container } = render(
      <RouteMap
        points={[]}
        climbMarkers={climbMarkers.slice(0, 1)}
        compact
        onSelectEntry={onSelectEntry}
      />,
    );
    measure(container);
    fireEvent.click(screen.getByTestId("marker"));
    expect(onSelectEntry).not.toHaveBeenCalled();
    expect(screen.getByTestId("map").getAttribute("data-scroll")).toBe("false");
    expect(screen.getByTestId("map").getAttribute("data-zoom")).toBe("false");
    expect(screen.getByTestId("map").getAttribute("data-pointer-events")).toBe("none");
  });

  it("shows one counted marker and selects every same-name log at its coordinate", () => {
    const first = climbMarkers[0];
    if (!first) throw new Error("Expected a source fixture");
    const onSelectEntry = vi.fn();
    const { container } = render(
      <RouteMap
        points={[]}
        climbMarkers={[
          { ...first, entryNumber: 1 },
          { ...first, entryId: "repeat", entryNumber: 3 },
        ]}
        onSelectEntry={onSelectEntry}
      />,
    );
    measure(container);
    const group = screen.getByTitle("2 climbs · Swiss Cheese · Swiss Cheese");
    expect(screen.getAllByTestId("marker")).toHaveLength(1);
    expect(group.textContent).toContain("2");
    fireEvent.click(group);
    const [firstChoice, secondChoice] = screen.getAllByRole("button", { name: "Swiss Cheese" });
    if (!firstChoice || !secondChoice) throw new Error("Expected both climb choices");
    fireEvent.click(firstChoice);
    expect(onSelectEntry).toHaveBeenLastCalledWith("tick-1");
    fireEvent.click(secondChoice);
    expect(onSelectEntry).toHaveBeenLastCalledWith("repeat");
    expect(secondChoice.getAttribute("aria-selected")).toBe("true");
    expect(screen.getAllByTestId("marker")).toHaveLength(1);
  });
  it("renders the title when given GPS points", () => {
    render(<RouteMap points={gpsPoints} />);
    expect(screen.getByText("Route Map")).toBeTruthy();
  });

  it("defers MapView until the wrapper is measured via onLayout", () => {
    const { container } = render(<RouteMap points={gpsPoints} />);
    // MapView should not render until onLayout fires and provides pixel width.
    // In jsdom the native layout event never fires, so MapView stays unmounted.
    expect(container.querySelector("MapView")).toBeNull();
  });

  it.each([false, true])(
    "shows map processing through layout and native readiness (compact: %s)",
    (compact) => {
      const view = render(<RouteMap points={gpsPoints} compact={compact} />);
      const processing = screen.getByRole("progressbar", { name: "Processing map" });
      expect(processing.textContent).toBe("Processing map…");
      const wrapper = view.container.querySelectorAll("view").item(1);
      expect(wrapper?.getAttribute("style")).toContain(`height: ${compact ? 140 : 280}px`);

      measure(view.container, 0);
      expect(screen.queryByTestId("map")).toBeNull();
      measure(view.container);
      expect(screen.getByRole("progressbar", { name: "Processing map" })).toBeTruthy();
      const mountedMap = screen.getByTestId("map");
      fireEvent(mountedMap, new Event("mapready"));
      expect(screen.queryByRole("progressbar", { name: "Processing map" })).toBeNull();
      expect(mountedMap.getAttribute("data-native-loading-enabled")).toBe("true");

      view.rerender(
        <RouteMap points={[...gpsPoints, { lat: 40.752, lng: -73.981 }]} compact={compact} />,
      );
      expect(screen.getByTestId("map")).toBe(mountedMap);
      expect(screen.queryByRole("progressbar", { name: "Processing map" })).toBeNull();
    },
  );

  it("renders nothing when given an empty array", () => {
    const { container } = render(<RouteMap points={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("filters out points without coordinates", () => {
    const mixedPoints = [
      { lat: null, lng: null },
      { lat: 40.748, lng: -73.985 },
      { lat: null, lng: -73.984 },
      { lat: 40.75, lng: -73.983 },
    ];
    render(<RouteMap points={mixedPoints} />);
    expect(screen.getByText("Route Map")).toBeTruthy();
  });

  it("renders nothing when all points lack coordinates", () => {
    const { container } = render(
      <RouteMap
        points={[
          { lat: null, lng: null },
          { lat: null, lng: null },
        ]}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders source-only markers with a finite local viewport and no sensor pins", () => {
    const { container } = render(<RouteMap points={[]} climbMarkers={climbMarkers} />);
    measure(container);
    expect(screen.getAllByTestId("marker")).toHaveLength(2);
    expect(screen.getAllByTestId("marker")[0]?.getAttribute("data-coordinate")).toBe(
      '{"latitude":40.752,"longitude":-73.98}',
    );
    expect(screen.getAllByTestId("marker")[1]?.getAttribute("data-coordinate")).toBe(
      '{"latitude":40.753,"longitude":-73.979}',
    );
    expect(screen.queryByTestId("polyline")).toBeNull();
    expect(screen.queryByTitle("Start")).toBeNull();
    expect(screen.queryByTitle("Finish")).toBeNull();
    expect(screen.getByTestId("map").getAttribute("data-region")).toBe(
      '{"latitude":40.7525,"longitude":-73.9795,"latitudeDelta":0.005,"longitudeDelta":0.005}',
    );
    expect(screen.getByText(/Area location.*Goat Rock.*OpenBeta/)).toBeTruthy();
  });

  it("keeps all repeated logs in a counted marker alongside the sensor route and hover marker", () => {
    const first = climbMarkers[0];
    if (!first) throw new Error("Expected a climb marker fixture");
    const { container } = render(
      <RouteMap
        points={gpsPoints}
        climbMarkers={[first, { ...first, entryId: "repeat", label: "Swiss Cheese repeat" }]}
        hoveredPosition={{ lat: 40.75, lng: -73.983 }}
      />,
    );
    expect(screen.queryByTestId("map")).toBeNull();
    measure(container, 410);
    expect(screen.getAllByTestId("marker")).toHaveLength(4);
    expect(
      screen.getByTitle("2 climbs · Swiss Cheese · Swiss Cheese repeat").textContent,
    ).toContain("2");
    expect(screen.getByTitle("Start")).toBeTruthy();
    expect(screen.getByTitle("Finish")).toBeTruthy();
    expect(screen.getByTestId("polyline").getAttribute("data-coordinates")).toContain(
      '"latitude":40.748',
    );
    expect(screen.getByTestId("map").style.width).toBe("410px");
  });

  it("uses a compact single-point source preview", () => {
    const { container } = render(
      <RouteMap points={[]} climbMarkers={climbMarkers.slice(0, 1)} compact />,
    );
    measure(container);
    expect(screen.getAllByTestId("marker")).toHaveLength(1);
    expect(screen.getByTestId("map").style.height).toBe("140px");
    expect(screen.queryByTitle("Start")).toBeNull();
    expect(screen.queryByTitle("Finish")).toBeNull();
  });

  it("updates the mounted native viewport when source coordinates change", () => {
    const first = climbMarkers[0];
    if (!first) throw new Error("Expected a climb marker fixture");
    const view = render(<RouteMap points={[]} climbMarkers={[first]} />);
    expect(screen.queryByTestId("map")).toBeNull();
    measure(view.container);
    const mountedMap = screen.getByTestId("map");
    view.rerender(
      <RouteMap
        points={[]}
        climbMarkers={[
          first,
          {
            ...first,
            entryId: "far-tick",
            location: { ...first.location, coordinates: { latitude: 40.762, longitude: -73.97 } },
          },
        ]}
      />,
    );
    expect(screen.getByTestId("map")).toBe(mountedMap);
    expect(JSON.parse(mountedMap.getAttribute("data-region") ?? "null")).toMatchObject({
      latitude: expect.closeTo(40.757, 10),
      longitude: expect.closeTo(-73.975, 10),
      latitudeDelta: expect.closeTo(0.013, 10),
      longitudeDelta: expect.closeTo(0.013, 10),
    });
  });
});
