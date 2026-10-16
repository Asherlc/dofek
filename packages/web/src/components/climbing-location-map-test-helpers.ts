import type {
  ClimbingLocationMap,
  ClimbingLocationMapEntry,
} from "@dofek/training/climbing-location-map";

export const climbingLocationEntries: ClimbingLocationMapEntry[] = [
  {
    id: "tick-1",
    activityId: "activity-1",
    date: "2026-10-04",
    label: "Blue Arete",
    grade: "5.10a",
    location: {
      coordinates: { latitude: 37.234, longitude: -122.111 },
      scope: "climb",
      objectId: "blue-arete",
      providerId: "mountain-project",
      name: "Blue Arete",
    },
  },
  {
    id: "tick-2",
    activityId: null,
    date: "2026-10-05",
    label: "Left Arete",
    grade: "V3",
    location: {
      coordinates: { latitude: 37.234, longitude: -122.111 },
      scope: "area",
      objectId: "goat-rock",
      providerId: "openbeta",
      name: "Goat Rock",
    },
  },
  {
    id: "tick-3",
    activityId: null,
    date: "2026-10-06",
    label: "The Traverse",
    grade: null,
    location: {
      coordinates: { latitude: 37.236, longitude: -122.112 },
      scope: "climb",
      objectId: "the-traverse",
      providerId: "mountain-project",
      name: "The Traverse",
    },
  },
];

export const climbingLocationMapFixture: ClimbingLocationMap = {
  bounds: { south: 37.234, west: -122.112, north: 37.236, east: -122.111 },
  nodes: [
    {
      id: "cluster",
      coordinates: { latitude: 37.235, longitude: -122.1115 },
      count: 3,
      radius: 15,
      minZoom: 0,
      maxZoom: 15,
      expansionZoom: 16,
      entries: [],
    },
    {
      id: "coincident",
      coordinates: { latitude: 37.234, longitude: -122.111 },
      count: 2,
      radius: 11,
      minZoom: 16,
      maxZoom: 19,
      expansionZoom: null,
      entries: climbingLocationEntries.slice(0, 2),
    },
    {
      id: "single",
      coordinates: { latitude: 37.236, longitude: -122.112 },
      count: 1,
      radius: 7,
      minZoom: 16,
      maxZoom: 19,
      expansionZoom: null,
      entries: climbingLocationEntries.slice(2),
    },
  ],
};
