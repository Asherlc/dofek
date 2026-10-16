import { describe, expect, it } from "vitest";
import {
  buildClimbingMapLocations,
  buildClimbingMapMarkers,
  type ClimbingMapLocation,
} from "./climbing-map.ts";

const climbLocation: ClimbingMapLocation = {
  coordinates: { latitude: 0, longitude: -122.25 },
  scope: "climb",
  objectId: "source-climb",
  providerId: "mountain-project",
  name: "Source climb",
};
const areaLocation: ClimbingMapLocation = {
  coordinates: { latitude: 1, longitude: -122.5 },
  scope: "area",
  objectId: "source-area",
  providerId: "openbeta",
  name: "Containing area",
};

describe("buildClimbingMapLocations", () => {
  it("keys supplied locations by log occurrence without changing source ownership", () => {
    const locations = buildClimbingMapLocations([
      { id: "unknown", climb: null, title: null, mapLocation: null },
      { id: "climb", climb: null, title: null, mapLocation: climbLocation },
      { id: "area", climb: null, title: null, mapLocation: areaLocation },
    ]);

    expect(Object.keys(locations)).toEqual(["climb", "area"]);
    expect(locations.climb).toBe(climbLocation);
    expect(locations.area).toBe(areaLocation);
  });
});

describe("buildClimbingMapMarkers", () => {
  it("keeps full card positions and prefers climb names over log titles", () => {
    const markers = buildClimbingMapMarkers([
      { id: "unknown", climb: null, title: "Unlocated", mapLocation: null },
      {
        id: "located",
        climb: { name: "Published climb name" },
        title: "Log title",
        mapLocation: climbLocation,
      },
      { id: "second-unknown", climb: null, title: null, mapLocation: null },
      { id: "titled", climb: { name: null }, title: "Log title", mapLocation: areaLocation },
      { id: "unnamed", climb: null, title: null, mapLocation: areaLocation },
    ]);

    expect(markers).toEqual([
      {
        entryId: "located",
        entryNumber: 2,
        label: "Published climb name",
        location: climbLocation,
      },
      { entryId: "titled", entryNumber: 4, label: "Log title", location: areaLocation },
      { entryId: "unnamed", entryNumber: 5, label: "Climbing log", location: areaLocation },
    ]);
    expect(markers[0]?.location).toBe(climbLocation);
    expect(markers[1]?.location).toBe(areaLocation);
  });

  it("returns no markers for logs without a server location", () => {
    expect(
      buildClimbingMapMarkers([{ id: "unknown", climb: null, title: null, mapLocation: null }]),
    ).toEqual([]);
    expect(buildClimbingMapMarkers([])).toEqual([]);
  });
});
