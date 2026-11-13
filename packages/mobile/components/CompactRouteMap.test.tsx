import { providerSourceLabel } from "@dofek/providers/providers";
import { type ClimbingMapMarker, groupClimbingMapMarkers } from "@dofek/training/climbing-map";
import { StaticMapImageManager } from "@maplibre/maplibre-react-native";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CompactRouteMap } from "./CompactRouteMap";

const first: ClimbingMapMarker = {
  entryId: "first",
  label: "Swiss Cheese",
  location: {
    coordinates: { latitude: 40.752, longitude: -73.98 },
    scope: "climb",
    objectId: "route-1",
    providerId: "mountain-project",
    name: "Swiss Cheese",
  },
};
const groups = groupClimbingMapMarkers(
  [
    first,
    { ...first, entryId: "repeat" },
    {
      ...first,
      entryId: "area",
      location: {
        ...first.location,
        coordinates: { latitude: 40.753, longitude: -73.979 },
        scope: "area",
      },
    },
  ],
  providerSourceLabel,
);
describe("CompactRouteMap", () => {
  beforeEach(() => vi.clearAllMocks());
  it("renders scoped points, counts, route endpoints and the chart hover into one static map", async () => {
    const { container } = render(
      <CompactRouteMap
        bounds={[-74, 40.74, -73.97, 40.76]}
        coordinates={[
          [-73.985, 40.748],
          [-73.984, 40.749],
        ]}
        markerGroups={groups}
        hoveredPosition={{ lat: 40.75, lng: -73.983 }}
        mode="light"
      />,
    );
    if (!container.firstElementChild) throw new Error("Expected snapshot wrapper");
    fireEvent(
      container.firstElementChild,
      new CustomEvent("layout", { detail: { width: 320, height: 140 } }),
    );
    expect(StaticMapImageManager.createImage).toHaveBeenCalledWith(
      expect.objectContaining({
        bounds: [-74, 40.74, -73.97, 40.76],
        width: 320,
        height: 140,
        mapStyle: expect.objectContaining({
          sources: expect.objectContaining({
            "compact-activity": expect.objectContaining({
              data: {
                type: "FeatureCollection",
                features: expect.arrayContaining([
                  expect.objectContaining({
                    geometry: { type: "Point", coordinates: [-73.98, 40.752] },
                    properties: expect.objectContaining({ label: "2", radius: 12 }),
                  }),
                  expect.objectContaining({
                    properties: expect.objectContaining({ scope: "area" }),
                  }),
                  expect.objectContaining({
                    geometry: {
                      type: "LineString",
                      coordinates: [
                        [-73.985, 40.748],
                        [-73.984, 40.749],
                      ],
                    },
                  }),
                  expect.objectContaining({
                    properties: expect.objectContaining({ role: "start" }),
                  }),
                  expect.objectContaining({
                    properties: expect.objectContaining({ role: "finish" }),
                  }),
                  expect.objectContaining({
                    properties: expect.objectContaining({ role: "hover" }),
                  }),
                ]),
              },
            }),
          }),
        }),
      }),
    );
    fireEvent.load(await screen.findByTestId("compact-route-preview"));
    expect(screen.getByLabelText(/2 climbs.*Swiss Cheese/)).toBeTruthy();
    expect(screen.queryByRole("progressbar", { name: "Processing map" })).toBeNull();
  });
});
