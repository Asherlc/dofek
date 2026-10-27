import type { ClimbingLocationMapEntry } from "@dofek/training/climbing-location-map";
import { describe, expect, it } from "vitest";
import { buildClimbingLocationMap } from "./climbing-location-map.ts";

function entry(id: string, latitude: number, longitude: number): ClimbingLocationMapEntry {
  return {
    id,
    activityId: null,
    date: "2026-10-13",
    label: `Climb ${id}`,
    grade: "V4",
    location: {
      coordinates: { latitude, longitude },
      scope: "climb",
      objectId: id,
      providerId: "openbeta",
      name: `Climb ${id}`,
    },
  };
}

describe("buildClimbingLocationMap", () => {
  it("returns an empty map when no source locations are available", () => {
    expect(buildClimbingLocationMap([])).toEqual({ bounds: null, nodes: [] });
  });

  it("groups nearby climbs at overview zoom and reveals individual climbs up close", () => {
    const map = buildClimbingLocationMap([
      entry("a", 37.8, -122.2),
      entry("b", 37.8001, -122.2001),
    ]);
    const overview = map.nodes.filter((node) => node.minZoom <= 0 && node.maxZoom >= 0);
    expect(overview).toHaveLength(1);
    expect(overview[0]).toMatchObject({ count: 2, entries: [] });
    expect(overview[0]?.expansionZoom).toBeGreaterThan(0);
    const close = map.nodes.filter((node) => node.minZoom <= 19 && node.maxZoom >= 19);
    expect(close).toHaveLength(2);
    expect(close.map((node) => node.entries[0]?.id).sort()).toEqual(["a", "b"]);
    expect(close.every((node) => node.count === 1 && node.expansionZoom === null)).toBe(true);
    expect(overview[0]?.radius).toBeGreaterThan(close[0]?.radius ?? Infinity);
    expect(map.bounds).toEqual({ south: 37.8, west: -122.2001, north: 37.8001, east: -122.2 });
  });

  it("preserves every recorded climb at an exact shared location without offsetting dots", () => {
    const first = entry("a", 0, 0);
    const second = entry("b", 0, 0);
    second.location.scope = "area";
    second.location.name = "Shared wall";
    const map = buildClimbingLocationMap([first, second]);
    expect(map.nodes).toHaveLength(1);
    expect(map.nodes[0]).toMatchObject({
      coordinates: { latitude: 0, longitude: 0 },
      count: 2,
      minZoom: 0,
      maxZoom: 19,
      expansionZoom: null,
      entries: [first, second],
    });
  });

  it("weights clusters by logged climbs rather than unique coordinate count", () => {
    const map = buildClimbingLocationMap([
      entry("a", 37.8, -122.2),
      entry("b", 37.8, -122.2),
      entry("c", 37.8001, -122.2001),
    ]);
    expect(map.nodes.find((node) => node.minZoom === 0)?.count).toBe(3);
    for (let zoom = 0; zoom <= 19; zoom++) {
      const visible = map.nodes.filter((node) => node.minZoom <= zoom && node.maxZoom >= zoom);
      expect(visible.reduce((total, node) => total + node.count, 0)).toBe(3);
    }
  });

  it("keeps distant locations separate and returns stable nodes regardless of query order", () => {
    const entries = [entry("a", 37.8, -122.2), entry("b", -33.8, 151.2)];
    const map = buildClimbingLocationMap(entries);
    expect(map.nodes.filter((node) => node.minZoom <= 3 && node.maxZoom >= 3)).toHaveLength(2);
    expect(buildClimbingLocationMap([...entries].reverse())).toEqual(map);
  });
});
