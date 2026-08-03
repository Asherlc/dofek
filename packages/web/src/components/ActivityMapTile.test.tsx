/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type ActivityMapLocation, ActivityMapTile } from "./ActivityMapTile.tsx";

const mapPreview = {
  width: 1024,
  height: 576,
  tiles: [
    {
      url: "https://tile.openstreetmap.org/15/5241/12665.png",
      x: 0,
      y: 0,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/15/5242/12665.png",
      x: 256,
      y: 0,
      width: 256,
      height: 256,
    },
  ],
  routePath: null,
};

function location(overrides: Partial<ActivityMapLocation> = {}): ActivityMapLocation {
  return {
    mapPreview,
    ...overrides,
  };
}

describe("ActivityMapTile", () => {
  it("fills a horizontal activity card map panel", () => {
    render(<ActivityMapTile location={location()} variant="panel" />);

    const tile = screen.getByTestId("activity-map-tile");
    expect(tile.className).toContain("h-full");
    expect(tile.className).toContain("min-h-48");
    expect(tile.className).not.toContain("aspect-[16/9]");
  });

  it("replaces failed map tiles with a fallback", () => {
    render(<ActivityMapTile location={location()} />);
    fireEvent.error(screen.getAllByTestId("activity-map-preview-tile")[0] ?? document.body);

    expect(screen.getByText("Map unavailable")).toBeDefined();
  });

  it("allows map tile requests to include the page origin as the referrer", () => {
    render(<ActivityMapTile location={location()} />);

    expect(
      screen.getAllByTestId("activity-map-preview-tile")[0]?.getAttribute("referrerpolicy"),
    ).toBe("origin");
  });

  it("renders a positioned multi-tile map preview at exported pixel size", () => {
    render(<ActivityMapTile location={location()} />);

    expect(screen.getByTestId("activity-map-preview").getAttribute("data-preview-width")).toBe(
      "1024",
    );
    expect(screen.getAllByTestId("activity-map-preview-tile")).toHaveLength(2);
    expect(screen.getAllByTestId("activity-map-preview-tile")[1]?.getAttribute("style")).toContain(
      "left: 25%",
    );
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

  it("keeps the map tile at its original scale so labels stay readable", () => {
    render(
      <ActivityMapTile
        location={location({
          mapPreview: {
            ...mapPreview,
            routePath: [
              { x: 5, y: 5 },
              { x: 15, y: 15 },
            ],
          },
        })}
      />,
    );

    expect(screen.getByTestId("activity-route-viewport").getAttribute("style")).toBeNull();
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
