import { describe, expect, it } from "vitest";
import {
  buildClimbingMapLocations,
  buildClimbingMapMarkers,
  type ClimbingMapLocation,
  groupClimbingMapMarkers,
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

describe("groupClimbingMapMarkers", () => {
  const providerLabel = (id: string) =>
    ({ "mountain-project": "Mountain Project", openbeta: "OpenBeta" })[id] ?? id;

  it("groups identical coordinates, retains every log, and states each source location once", () => {
    const first = { entryId: "first", label: "Blue Arete", location: areaLocation };
    const repeat = { ...first, entryId: "repeat" };
    const last = { ...first, entryId: "last", label: "Kibbles and Bits" };
    const separate = { entryId: "separate", label: "Other climb", location: climbLocation };
    const groups = groupClimbingMapMarkers([first, separate, repeat, last], providerLabel);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({
      coordinates: areaLocation.coordinates,
      markers: [first, repeat, last],
      title: "3 climbs · Blue Arete · Blue Arete · Kibbles and Bits",
      description: "Area location: Containing area · OpenBeta",
    });
    expect(groups[0]?.markers[0]).toBe(first);
    expect(groups[1]).toMatchObject({ title: "Other climb", markers: [separate] });
  });

  it("retains different source owners and scopes at the same coordinate", () => {
    const groups = groupClimbingMapMarkers(
      [
        { entryId: "area", label: "Area climb", location: areaLocation },
        {
          entryId: "exact",
          label: "Exact climb",
          location: { ...climbLocation, coordinates: areaLocation.coordinates },
        },
      ],
      providerLabel,
    );
    expect(groups[0]?.description).toBe(
      "Area location: Containing area · OpenBeta · Climb location: Source climb · Mountain Project",
    );
    expect(groupClimbingMapMarkers([], providerLabel)).toEqual([]);
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
