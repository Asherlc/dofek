import type { ClimbingLocationMap } from "@dofek/training/climbing-location-map";

const location = {
  coordinates: { latitude: 37.5, longitude: -122.5 },
  scope: "climb" as const,
  objectId: "swiss-cheese",
  providerId: "mountain-project",
  name: "Swiss Cheese",
};

export const climbingLocationMapFixture: ClimbingLocationMap = {
  bounds: { south: 37, west: -123, north: 39, east: -121 },
  nodes: [
    {
      id: "cluster",
      coordinates: location.coordinates,
      count: 3,
      radius: 22,
      minZoom: 0,
      maxZoom: 10,
      expansionZoom: 11,
      entries: [],
    },
    {
      id: "swiss-cheese",
      coordinates: location.coordinates,
      count: 2,
      radius: 12,
      minZoom: 11,
      maxZoom: 19,
      expansionZoom: null,
      entries: [
        {
          id: "tick-1",
          activityId: "activity-1",
          date: "2026-10-10",
          label: "Swiss Cheese",
          grade: "V4",
          location,
        },
        {
          id: "tick-2",
          activityId: null,
          date: "2026-10-11",
          label: "Swiss Cheese repeat",
          grade: "V4",
          location,
        },
      ],
    },
    {
      id: "goat-rock",
      coordinates: { latitude: 37.52, longitude: -122.48 },
      count: 1,
      radius: 7,
      minZoom: 11,
      maxZoom: 19,
      expansionZoom: null,
      entries: [
        {
          id: "tick-3",
          activityId: null,
          date: "2026-10-12",
          label: "Left Arete",
          grade: null,
          location: {
            ...location,
            coordinates: { latitude: 37.52, longitude: -122.48 },
            scope: "area",
            objectId: "goat-rock",
            name: "Goat Rock",
            providerId: "openbeta",
          },
        },
      ],
    },
  ],
};
