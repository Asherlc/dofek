/** @vitest-environment jsdom */

import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ActivityMapLocation, ActivityMapTile } from "./ActivityMapTile.tsx";

const mapPreview = {
  width: 1024,
  height: 576,
  center: [-122.4194, 37.7749] satisfies [number, number],
  zoom: 14,
  routePath: null,
};

function location(
  overrides: Partial<Extract<ActivityMapLocation, { kind: "recorded_gps" }>> = {},
): ActivityMapLocation {
  return {
    kind: "recorded_gps",
    centroidLat: 37.7749,
    centroidLng: -122.4194,
    mapPreview,
    ...overrides,
  };
}

vi.mock("maplibre-gl", async () => (await import("../lib/maplibre-test-helpers.ts")).maplibreMock);

import { maps, resetMaps } from "../lib/maplibre-test-helpers.ts";

const captureException = vi.hoisted(() => vi.fn());
vi.mock("../lib/telemetry.ts", () => ({ captureException }));
beforeEach(() => {
  resetMaps();
  captureException.mockClear();
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 512,
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => 288,
  });
});
afterEach(() => vi.unstubAllGlobals());
describe("ActivityMapTile", () => {
  it("snapshots a non-interactive shared map then releases its WebGL context", async () => {
    render(<ActivityMapTile location={location()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Processing map…");
    await waitFor(() => expect(maps).toHaveLength(1));
    expect(maps[0]?.options).toMatchObject({
      center: mapPreview.center,
      zoom: 14,
      interactive: false,
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    act(() => maps[0]?.fire("idle"));
    expect(await screen.findByTestId("activity-map-snapshot")).toHaveAttribute(
      "src",
      "data:image/png;base64,map",
    );
    expect(maps[0]?.remove).toHaveBeenCalledOnce();
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("bounds simultaneous thumbnail renderers and defers offscreen requests", async () => {
    const intersections: ((visible: boolean) => void)[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
          intersections.push((visible) => callback([{ isIntersecting: visible }]));
        }
        observe() {}
        disconnect() {}
      },
    );
    render(
      <>
        <ActivityMapTile location={location()} />
        <ActivityMapTile location={location()} />
      </>,
    );
    expect(maps).toHaveLength(0);
    act(() => {
      for (const enter of intersections) enter(true);
    });
    await waitFor(() => expect(maps).toHaveLength(1));
    act(() => maps[0]?.fire("idle"));
    await waitFor(() => expect(maps).toHaveLength(2));
    expect(maps[0]?.remove).toHaveBeenCalledOnce();
    act(() => maps[1]?.fire("idle"));
  });
  it("releases a stalled preview so the next visible map can render", async () => {
    vi.useFakeTimers();
    render(
      <>
        <ActivityMapTile location={location()} />
        <ActivityMapTile location={location()} />
      </>,
    );
    try {
      await vi.waitFor(() => expect(maps).toHaveLength(1));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(maps[0]?.remove).toHaveBeenCalledOnce();
      expect(captureException).toHaveBeenCalledOnce();
      expect(maps).toHaveLength(2);
      expect(screen.getByText("Map unavailable. Check your connection.")).toBeVisible();
      act(() => maps[1]?.fire("idle"));
      expect(screen.getByTestId("activity-map-snapshot")).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });
  it("letterboxes the complete camera and overlays at differing panel proportions", async () => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 512,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 200,
    });
    render(<ActivityMapTile location={location()} variant="panel" />);
    await waitFor(() => expect(maps).toHaveLength(1));
    expect(maps[0]?.options.zoom).toBe(14);
    expect(parseFloat(screen.getByTestId("activity-map-preview").style.width)).toBeCloseTo(
      (1024 * 200) / 576,
      2,
    );
    expect(screen.getByTestId("activity-map-preview")).toHaveStyle({ height: "200px" });
    act(() => maps[0]?.fire("idle"));
  });
  it("renders a global route at its reference camera before shrinking a tiny thumbnail", async () => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 64,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 48,
    });
    render(
      <ActivityMapTile
        variant="thumbnail"
        location={location({
          mapPreview: {
            ...mapPreview,
            zoom: 0,
            routePath: [
              { x: 0, y: 288 },
              { x: 1024, y: 288 },
            ],
          },
        })}
      />,
    );
    await waitFor(() => expect(maps).toHaveLength(1));
    expect(maps[0]?.options.zoom).toBe(0);
    expect(maps[0]?.container).toHaveStyle({
      width: "1024px",
      height: "576px",
      transform: "scale(0.0625)",
      transformOrigin: "top left",
    });
    expect(screen.getByTestId("activity-map-preview")).toHaveStyle({
      width: "64px",
      height: "36px",
    });
    expect(screen.getByTestId("activity-route-overlay")).toHaveAttribute("viewBox", "0 0 1024 576");
    act(() => maps[0]?.fire("idle"));
    expect(await screen.findByTestId("activity-map-snapshot")).toHaveClass("h-full", "w-full");
  });
  it("retains a snapshot across identical refetches and resets for a changed camera", async () => {
    const view = render(<ActivityMapTile location={location()} />);
    await waitFor(() => expect(maps).toHaveLength(1));
    act(() => maps[0]?.fire("idle"));
    const image = await screen.findByTestId("activity-map-snapshot");
    view.rerender(<ActivityMapTile location={location({ mapPreview: { ...mapPreview } })} />);
    expect(screen.getByTestId("activity-map-snapshot")).toBe(image);
    view.rerender(
      <ActivityMapTile location={location({ mapPreview: { ...mapPreview, zoom: 15 } })} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Processing map…");
    await waitFor(() => expect(maps).toHaveLength(2));
    act(() => maps[1]?.fire("idle"));
  });
  it("reports failed background requests while preserving source geometry", async () => {
    render(<ActivityMapTile location={location()} />);
    await waitFor(() => expect(maps).toHaveLength(1));
    act(() => maps[0]?.fire("error", { error: new Error("offline") }));
    expect(screen.getByRole("status")).toHaveTextContent("Map unavailable. Check your connection.");
    expect(captureException).toHaveBeenCalledOnce();
    expect(maps[0]?.remove).toHaveBeenCalledOnce();
  });
  it("reserves the map panel during server processing", () => {
    render(<ActivityMapTile location={{ kind: "processing" }} variant="panel" />);
    expect(screen.getByRole("status")).toHaveTextContent("Processing map…");
    expect(maps).toHaveLength(0);
  });
  it("draws source-owned Area and Climb points without connecting them as a track", () => {
    render(
      <ActivityMapTile
        location={{
          kind: "climbing_source",
          mapPreview,
          sourcePoints: [
            {
              x: 100,
              y: 200,
              location: {
                coordinates: { latitude: 37, longitude: -122 },
                scope: "area",
                objectId: "area-1",
                providerId: "mountain-project",
                name: "North Wall",
              },
            },
            {
              x: 300,
              y: 400,
              location: {
                coordinates: { latitude: 38, longitude: -123 },
                scope: "climb",
                objectId: "climb-1",
                providerId: "openbeta",
                name: "Corner Crack",
              },
            },
          ],
        }}
      />,
    );

    const map = screen.getByRole("img", {
      name: /Climbing source locations.*Area location: North Wall.*Mountain Project.*Climb location: Corner Crack.*OpenBeta/,
    });
    const points = map.querySelectorAll("circle");
    expect(points).toHaveLength(2);
    expect(points[0]?.parentElement).toHaveStyle({ left: "9.765625%", top: "34.72222222222222%" });
    expect(points[1]?.parentElement).toHaveStyle({ left: "29.296875%", top: "69.44444444444444%" });
    for (const point of points) {
      expect(point.parentElement).toHaveAttribute("width", "16");
      expect(point.parentElement).toHaveAttribute("height", "16");
    }
    expect(map.querySelector("path")).toBeNull();
  });

  it("keeps unnamed source locations attributed without presenting an identifier as a place", () => {
    render(
      <ActivityMapTile
        location={{
          kind: "climbing_source",
          mapPreview,
          sourcePoints: [
            {
              x: 512,
              y: 288,
              location: {
                coordinates: { latitude: 37, longitude: -122 },
                scope: "area",
                objectId: "area-123",
                providerId: "mountain-project",
                name: null,
              },
            },
          ],
        }}
      />,
    );
    expect(
      screen.getByRole("img", {
        name: "Climbing source locations · Area location · Mountain Project",
      }),
    ).toBeDefined();
  });

  it("fills a horizontal activity card map panel", () => {
    render(<ActivityMapTile location={location()} variant="panel" />);

    const tile = screen.getByTestId("activity-map-tile");
    expect(tile.className).toContain("h-full");
    expect(tile.className).toContain("min-h-48");
    expect(tile.className).not.toContain("aspect-[16/9]");
  });

  it("draws a smoothed route overlay when a map tile includes route path points", () => {
    render(
      <ActivityMapTile
        location={location({
          mapPreview: {
            ...mapPreview,
            routePath: [
              { x: 278.54, y: 379.51 },
              { x: 292.2, y: 370.88 },
              { x: 305.85, y: 359.36 },
            ],
          },
        })}
      />,
    );

    expect(screen.getByTestId("activity-route-path").getAttribute("d")).toBe(
      "M 278.54 379.51 C 283.093 376.633, 287.648 374.238, 292.2 370.88 C 296.752 367.522, 301.3 363.2, 305.85 359.36",
    );
  });

  it("uses a high-resolution vector canvas for route overlays", () => {
    render(
      <ActivityMapTile
        location={location({
          mapPreview: {
            ...mapPreview,
            routePath: [
              { x: 25, y: 30 },
              { x: 35, y: 40 },
            ],
          },
        })}
      />,
    );

    expect(screen.getByTestId("activity-route-overlay").getAttribute("viewBox")).toBe(
      "0 0 1024 576",
    );
  });

  it("does not duplicate distance and elevation badges over the map", () => {
    render(<ActivityMapTile location={location()} />);

    expect(screen.queryByText("5.0 km")).toBeNull();
    expect(screen.queryByText("120 m")).toBeNull();
  });

  it("uses a restrained route stroke over the map tile", () => {
    render(
      <ActivityMapTile
        location={location({
          mapPreview: {
            ...mapPreview,
            routePath: [
              { x: 25, y: 30 },
              { x: 35, y: 40 },
            ],
          },
        })}
      />,
    );

    expect(screen.getByTestId("activity-route-casing").getAttribute("stroke-width")).toBe("5");
    expect(screen.getByTestId("activity-route-path").getAttribute("stroke-width")).toBe("3");
  });
});
