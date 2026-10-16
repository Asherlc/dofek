import { fireEvent, render, screen } from "@testing-library/react";
import type { ActivityLocation } from "dofek-server/types";
import { describe, expect, it } from "vitest";
import { ActivityMapTile } from "./ActivityMapTile";

const location = {
  kind: "recorded_gps",
  centroidLat: 37,
  centroidLng: -122,
  mapPreview: {
    width: 1024,
    height: 576,
    routePath: [
      { x: 100, y: 100 },
      { x: 200, y: 200 },
    ],
    tiles: [
      { url: "https://tiles.test/1.png", x: 0, y: 0, width: 256, height: 256 },
      { url: "https://tiles.test/1.png", x: 256, y: 0, width: 256, height: 256 },
    ],
  },
} satisfies ActivityLocation;

describe("ActivityMapTile", () => {
  it("keeps processing until every tile instance loads, counting repeated load events once", () => {
    render(<ActivityMapTile location={location} />);
    expect(screen.getByRole("progressbar", { name: "Processing map" })).toBeTruthy();
    const tiles = screen.getAllByTestId("activity-map-preview-tile");
    const first = tiles[0];
    const second = tiles[1];
    if (!first || !second) throw new Error("Expected both preview tiles");
    fireEvent.load(first);
    fireEvent.load(first);
    expect(screen.getByRole("progressbar", { name: "Processing map" })).toBeTruthy();
    fireEvent.load(second);
    expect(screen.queryByRole("progressbar", { name: "Processing map" })).toBeNull();
    expect(screen.getByLabelText("Activity location map")).toBeTruthy();
  });

  it("preserves a loaded preview on refresh and shows processing for a changed preview", () => {
    const view = render(<ActivityMapTile location={location} />);
    for (const tile of screen.getAllByTestId("activity-map-preview-tile")) fireEvent.load(tile);
    const mountedTile = screen.getAllByTestId("activity-map-preview-tile")[0];
    view.rerender(
      <ActivityMapTile location={{ ...location, mapPreview: { ...location.mapPreview } }} />,
    );
    expect(screen.queryByRole("progressbar", { name: "Processing map" })).toBeNull();
    expect(screen.getAllByTestId("activity-map-preview-tile")[0]).toBe(mountedTile);
    view.rerender(
      <ActivityMapTile
        location={{
          ...location,
          mapPreview: {
            ...location.mapPreview,
            tiles: location.mapPreview.tiles.map((tile) => ({
              ...tile,
              url: "https://tiles.test/2.png",
            })),
          },
        }}
      />,
    );
    expect(screen.getByRole("progressbar", { name: "Processing map" })).toBeTruthy();
  });

  it("preserves a map failure until a changed preview starts loading", () => {
    const view = render(<ActivityMapTile location={location} />);
    const tile = screen.getAllByTestId("activity-map-preview-tile")[0];
    if (!tile) throw new Error("Expected a preview tile");
    fireEvent.error(tile);
    expect(screen.getByText("Map unavailable")).toBeTruthy();
    expect(screen.queryByRole("progressbar", { name: "Processing map" })).toBeNull();
    view.rerender(
      <ActivityMapTile
        location={{
          ...location,
          mapPreview: {
            ...location.mapPreview,
            tiles: location.mapPreview.tiles.map((item) => ({
              ...item,
              url: "https://tiles.test/2.png",
            })),
          },
        }}
      />,
    );
    expect(screen.getByRole("progressbar", { name: "Processing map" })).toBeTruthy();
    expect(screen.getAllByTestId("activity-map-preview-tile")).toHaveLength(2);
  });
});
