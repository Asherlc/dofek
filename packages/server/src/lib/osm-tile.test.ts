import { describe, expect, it } from "vitest";
import { latLngToTile, osmTilePreview, osmTileUrl } from "./osm-tile.ts";

function tilePathnames(urls: string[]): string[] {
  return urls.map((url) => new URL(url).pathname);
}

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
  it("returns world tile and null route path for empty input", () => {
    const preview = osmTilePreview([]);

    expect(preview.width).toBe(1024);
    expect(preview.height).toBe(576);
    expect(preview.tiles).toEqual([
      {
        url: "https://tile.openstreetmap.org/0/0/0.png",
        x: 384,
        y: 160,
        width: 256,
        height: 256,
      },
    ]);
    expect(preview.routePath).toBeNull();
  });

  it("exports a route-fitted multi-tile static map preview", () => {
    const preview = osmTilePreview([
      { lat: 37.7749, lng: -122.4194 },
      { lat: 37.7752, lng: -122.4188 },
      { lat: 37.7756, lng: -122.4182 },
    ]);

    expect(preview.width).toBe(1024);
    expect(preview.height).toBe(576);
    expect(preview.tiles.length).toBeGreaterThan(1);
    const firstTileUrl = new URL(preview.tiles[0]?.url ?? "");
    expect(preview.tiles[0]).toEqual({
      url: expect.any(String),
      x: expect.any(Number),
      y: expect.any(Number),
      width: 256,
      height: 256,
    });
    expect(firstTileUrl.origin).toBe("https://tile.openstreetmap.org");
    expect(firstTileUrl.pathname).toMatch(/^\/19\/\d+\/\d+\.png$/);
    expect(tilePathnames(preview.tiles.map((tile) => tile.url))).toEqual([
      "/19/83856/202646.png",
      "/19/83857/202646.png",
      "/19/83858/202646.png",
      "/19/83859/202646.png",
      "/19/83860/202646.png",
      "/19/83856/202647.png",
      "/19/83857/202647.png",
      "/19/83858/202647.png",
      "/19/83859/202647.png",
      "/19/83860/202647.png",
      "/19/83856/202648.png",
      "/19/83857/202648.png",
      "/19/83858/202648.png",
      "/19/83859/202648.png",
      "/19/83860/202648.png",
    ]);
    expect(preview.tiles.map((tile) => ({ x: tile.x, y: tile.y }))).toEqual([
      { x: -179.332, y: -132.862 },
      { x: 76.668, y: -132.862 },
      { x: 332.668, y: -132.862 },
      { x: 588.668, y: -132.862 },
      { x: 844.668, y: -132.862 },
      { x: -179.332, y: 123.138 },
      { x: 76.668, y: 123.138 },
      { x: 332.668, y: 123.138 },
      { x: 588.668, y: 123.138 },
      { x: 844.668, y: 123.138 },
      { x: -179.332, y: 379.138 },
      { x: 76.668, y: 379.138 },
      { x: 332.668, y: 379.138 },
      { x: 588.668, y: 379.138 },
      { x: 844.668, y: 379.138 },
    ]);
    expect(preview.routePath).toHaveLength(3);
    expect(preview.routePath).toEqual([
      { x: 288.304, y: 453.089 },
      { x: 512, y: 311.585 },
      { x: 735.696, y: 122.911 },
    ]);
    expect(preview.routePath?.[0]?.x).toBeGreaterThan(0);
    expect(preview.routePath?.[0]?.x).toBeLessThan(preview.width);
    expect(preview.routePath?.[0]?.y).toBeGreaterThan(0);
    expect(preview.routePath?.[0]?.y).toBeLessThan(preview.height);
  });

  it("zooms short route previews tightly enough that the path is readable", () => {
    const preview = osmTilePreview([
      { lat: 37.7749, lng: -122.4194 },
      { lat: 37.7752, lng: -122.4188 },
      { lat: 37.7756, lng: -122.4182 },
    ]);
    const routePath = preview.routePath ?? [];
    const routeWidth =
      Math.max(...routePath.map((point) => point.x)) -
      Math.min(...routePath.map((point) => point.x));
    const routeHeight =
      Math.max(...routePath.map((point) => point.y)) -
      Math.min(...routePath.map((point) => point.y));

    expect(routeWidth).toBeGreaterThan(preview.width * 0.4);
    expect(routeHeight).toBeGreaterThan(preview.height * 0.5);
  });

  it("omits route path points when fewer than two coordinates are available", () => {
    const preview = osmTilePreview([{ lat: 37.7749, lng: -122.4194 }]);

    expect(preview.tiles.length).toBeGreaterThan(1);
    expect(preview.routePath).toBeNull();
  });

  it("anchors boundary previews to the valid world tile range", () => {
    const preview = osmTilePreview([{ lat: 90, lng: 180 }]);

    expect(preview.tiles).toHaveLength(12);
    expect(tilePathnames(preview.tiles.map((tile) => tile.url))).toEqual([
      "/19/0/0.png",
      "/19/1/0.png",
      "/19/2/0.png",
      "/19/3/0.png",
      "/19/0/1.png",
      "/19/1/1.png",
      "/19/2/1.png",
      "/19/3/1.png",
      "/19/0/2.png",
      "/19/1/2.png",
      "/19/2/2.png",
      "/19/3/2.png",
    ]);
    expect(preview.tiles[0]).toMatchObject({ x: 0, y: 0 });
    expect(preview.tiles.at(-1)).toMatchObject({ x: 768, y: 512 });
    expect(preview.routePath).toBeNull();
  });

  it("wraps low-zoom tile columns across the world edge instead of repeating edge tiles", () => {
    const preview = osmTilePreview([
      { lat: 0, lng: -170 },
      { lat: 0, lng: 170 },
    ]);

    expect(tilePathnames(preview.tiles.map((tile) => tile.url))).toEqual([
      "/1/0/0.png",
      "/1/1/0.png",
      "/1/0/0.png",
      "/1/1/0.png",
      "/1/0/1.png",
      "/1/1/1.png",
      "/1/0/1.png",
      "/1/1/1.png",
      "/1/0/1.png",
      "/1/1/1.png",
      "/1/0/1.png",
      "/1/1/1.png",
    ]);
    expect(preview.routePath).toEqual([
      { x: 14.222, y: 256 },
      { x: 497.778, y: 256 },
    ]);
  });

  it("uses the highest preview zoom that fits a long route inside the export", () => {
    const preview = osmTilePreview([
      { lat: 37.7749, lng: -122.4194 },
      { lat: 40.7128, lng: -74.006 },
    ]);

    const firstTileUrl = new URL(preview.tiles[0]?.url ?? "");
    expect(firstTileUrl.origin).toBe("https://tile.openstreetmap.org");
    expect(firstTileUrl.pathname).toMatch(/^\/4\//);
    expect(preview.tiles).toHaveLength(20);
    expect(tilePathnames(preview.tiles.map((tile) => tile.url))).toEqual([
      "/4/1/4.png",
      "/4/2/4.png",
      "/4/3/4.png",
      "/4/4/4.png",
      "/4/5/4.png",
      "/4/1/5.png",
      "/4/2/5.png",
      "/4/3/5.png",
      "/4/4/5.png",
      "/4/5/5.png",
      "/4/1/6.png",
      "/4/2/6.png",
      "/4/3/6.png",
      "/4/4/6.png",
      "/4/5/6.png",
      "/4/1/7.png",
      "/4/2/7.png",
      "/4/3/7.png",
      "/4/4/7.png",
      "/4/5/7.png",
    ]);
    expect(preview.tiles[0]).toMatchObject({ x: -162.558, y: -249.604 });
    expect(preview.tiles.at(-1)).toMatchObject({ x: 861.442, y: 518.396 });
    expect(preview.routePath).toEqual([
      { x: 236.582, y: 309.586 },
      { x: 787.418, y: 266.414 },
    ]);
  });
});
