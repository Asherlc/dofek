import { describe, expect, it } from "vitest";
import { latLngToTile, osmTileUrl } from "./osm-tile.ts";

describe("latLngToTile", () => {
  it("computes tile coordinates for the equator/prime meridian at zoom 0", () => {
    expect(latLngToTile(0, 0, 0)).toEqual({ zoom: 0, tileX: 0, tileY: 0 });
  });

  it("matches the known tile for San Francisco at zoom 13", () => {
    expect(latLngToTile(37.7749, -122.4194, 13)).toEqual({ zoom: 13, tileX: 1310, tileY: 3166 });
  });

  it("matches the known tile for London at zoom 13", () => {
    expect(latLngToTile(51.5074, -0.1278, 13)).toEqual({ zoom: 13, tileX: 4093, tileY: 2724 });
  });
});

describe("osmTileUrl", () => {
  it("returns an OpenStreetMap tile URL at zoom 13 by default", () => {
    expect(osmTileUrl(37.7749, -122.4194)).toBe("https://tile.openstreetmap.org/13/1310/3166.png");
  });

  it("honors a custom zoom argument", () => {
    expect(osmTileUrl(0, 0, 0)).toBe("https://tile.openstreetmap.org/0/0/0.png");
  });
});
