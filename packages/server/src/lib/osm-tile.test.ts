import { describe, expect, it } from "vitest";
import { latLngToTile, osmTilePreview, osmTileUrl } from "./osm-tile.ts";

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

  it("keeps tile coordinates in range at map boundaries", () => {
    for (const zoom of [0, 1, 13]) {
      const maxTileIndex = 2 ** zoom - 1;
      for (const [lat, lng] of [
        [0, 180],
        [0, -180],
        [85.05112878, 0],
        [-85.05112878, 0],
        [90, 540],
        [-90, -540],
      ]) {
        const tile = latLngToTile(lat, lng, zoom);
        expect(tile.tileX).toBeGreaterThanOrEqual(0);
        expect(tile.tileX).toBeLessThanOrEqual(maxTileIndex);
        expect(tile.tileY).toBeGreaterThanOrEqual(0);
        expect(tile.tileY).toBeLessThanOrEqual(maxTileIndex);
      }
    }
  });
});

describe("osmTileUrl", () => {
  it("returns an OpenStreetMap tile URL at zoom 13 by default", () => {
    expect(osmTileUrl(37.7749, -122.4194)).toBe("https://tile.openstreetmap.org/13/1310/3166.png");
  });

  it("honors a custom zoom argument", () => {
    expect(osmTileUrl(0, 0, 0)).toBe("https://tile.openstreetmap.org/0/0/0.png");
  });

  it("returns valid tile URLs for wrapped and clamped boundary inputs", () => {
    expect(osmTileUrl(0, 180, 1)).toBe("https://tile.openstreetmap.org/1/0/1.png");
    expect(osmTileUrl(90, 0, 1)).toBe("https://tile.openstreetmap.org/1/1/0.png");
    expect(osmTileUrl(-90, 0, 1)).toBe("https://tile.openstreetmap.org/1/1/1.png");
  });
});

describe("osmTilePreview", () => {
  it("returns a route-fitted tile URL and normalized path points", () => {
    const preview = osmTilePreview([
      { lat: 37.7749, lng: -122.4194 },
      { lat: 37.7752, lng: -122.4188 },
      { lat: 37.7756, lng: -122.4182 },
    ]);

    expect(preview).toEqual({
      tileUrl: "https://tile.openstreetmap.org/13/1310/3166.png",
      routePath: [
        { x: 27.854, y: 37.951 },
        { x: 29.22, y: 37.088 },
        { x: 30.585, y: 35.936 },
      ],
    });
  });

  it("omits route path points when fewer than two coordinates are available", () => {
    expect(osmTilePreview([{ lat: 37.7749, lng: -122.4194 }])).toEqual({
      tileUrl: "https://tile.openstreetmap.org/13/1310/3166.png",
      routePath: null,
    });
  });

  it("falls back to the lowest preview zoom when a route spans multiple tiles", () => {
    const preview = osmTilePreview([
      { lat: 37.7749, lng: -122.4194 },
      { lat: 40.7128, lng: -74.006 },
    ]);

    expect(preview.tileUrl).toBe("https://tile.openstreetmap.org/1/0/0.png");
  });
});
