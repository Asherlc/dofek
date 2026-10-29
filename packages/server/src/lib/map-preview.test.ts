import { describe, expect, it } from "vitest";
import { pointMapPreview, routeMapPreview } from "./map-preview.ts";

describe("routeMapPreview", () => {
  it("returns a world camera for an empty preview", () => {
    expect(routeMapPreview([])).toMatchObject({
      width: 1024,
      height: 576,
      center: [0, 0],
      zoom: 0,
      routePath: null,
    });
  });

  it("pairs the fitted camera with the existing projected route", () => {
    const preview = routeMapPreview([
      { lat: 37.7749, lng: -122.4194 },
      { lat: 37.7752, lng: -122.4188 },
      { lat: 37.7756, lng: -122.4182 },
    ]);
    expect(preview.zoom).toBe(18);
    expect(preview.center[0]).toBeCloseTo(-122.4188, 6);
    expect(preview.center[1]).toBeCloseTo(37.77525, 6);
    expect(preview.routePath).toEqual([
      { x: 288.304, y: 453.089 },
      { x: 512, y: 311.585 },
      { x: 735.696, y: 122.911 },
    ]);
  });

  it("uses a lower zoom for a route crossing the country", () => {
    const preview = routeMapPreview([
      { lat: 37.7749, lng: -122.4194 },
      { lat: 40.7128, lng: -74.006 },
    ]);
    expect(preview.zoom).toBe(3);
    expect(preview.routePath).toEqual([
      { x: 236.582, y: 309.586 },
      { x: 787.418, y: 266.414 },
    ]);
  });

  it("keeps the projected world tall enough for a worldwide preview", () => {
    const preview = routeMapPreview([
      { lat: 0, lng: -170 },
      { lat: 0, lng: 170 },
    ]);
    expect(preview.zoom).toBeCloseTo(Math.log2(preview.height / 512));
    expect(preview.center[1]).toBeCloseTo(0);
    expect(preview.routePath?.map((point) => point.y)).toEqual([288, 288]);
  });

  it("keeps cameras finite for wrapped longitudes and polar inputs", () => {
    for (const point of [
      { lat: 90, lng: 180 },
      { lat: -90, lng: -540 },
    ]) {
      const preview = routeMapPreview([point]);
      expect(preview.center.every(Number.isFinite)).toBe(true);
      expect(preview.center[0]).toBeGreaterThanOrEqual(-180);
      expect(preview.center[0]).toBeLessThanOrEqual(180);
      expect(Math.abs(preview.center[1])).toBeLessThanOrEqual(85.05112878);
      expect(preview.routePath).toBeNull();
    }
  });
});

describe("pointMapPreview", () => {
  it("keeps source identity with its projected position without connecting sources", () => {
    const area = { lat: 40.01, lng: -105.28, location: { scope: "area", objectId: "area-1" } };
    const climb = { lat: 40.012, lng: -105.275, location: { scope: "climb", objectId: "climb-1" } };
    const result = pointMapPreview([area, climb]);
    expect(result.preview.zoom).toBe(13);
    expect(result.points.map((point) => point.point)).toEqual([area, climb]);
    expect(result.points[0]?.x).toBeLessThan(result.points[1]?.x ?? 0);
    expect(result.points[0]?.y).toBeGreaterThan(result.points[1]?.y ?? 0);
    expect(result.preview.routePath).toBeNull();
  });

  it("centers zero-valued source coordinates and handles empty sources", () => {
    const result = pointMapPreview([{ lat: 0, lng: 0 }]);
    expect(result.preview.center).toEqual([0, 0]);
    expect(result.preview.zoom).toBe(13);
    expect(result.points).toEqual([{ x: 512, y: 288, point: { lat: 0, lng: 0 } }]);
    expect(pointMapPreview([]).points).toEqual([]);
  });
});
