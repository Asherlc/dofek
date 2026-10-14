import type { ClimbingMapLocation } from "@dofek/training/climbing-map";
import type { ClimbingCardEntry } from "./ClimbingEntryCard";

export const climbingEntryFixture = {
  id: "tick-1",
  climbType: "route",
  gradeSystem: "yds",
  grade: "5.4",
  sent: true,
  attemptCount: 2,
  ascentType: "Redpoint",
  routeName: "Swiss Cheese",
  locationName: "Goat Rock",
  lead: true,
  sourceName: "Mountain Project",
  sourceLinks: [
    {
      kind: "route",
      providerId: "mountain-project",
      url: "https://www.mountainproject.com/route/105734732/swiss-cheese",
    },
    {
      kind: "ticks",
      providerId: "mountain-project",
      url: "https://www.mountainproject.com/user/110186720/ticks",
    },
  ],
  context: {
    providerId: "mountain-project",
    locationPath: [
      { name: "California", externalId: null, kind: null },
      { name: "Goat Rock", externalId: "goat-rock", kind: "area" },
    ],
    board: null,
    wallAngle: null,
    climbStyle: "lead",
    resultStyle: "Redpoint",
  },
  attempts: [{ attemptIndex: 1, outcome: "failed", failureReason: "technique", notes: null }],
  holdType: "crimp",
  wallAngleDegrees: null,
} satisfies ClimbingCardEntry;

export const exactClimbingLocation: ClimbingMapLocation = {
  coordinates: { latitude: 37.228, longitude: -122.096 },
  scope: "climb",
  objectId: "105734732",
  providerId: "mountain-project",
  name: "Swiss Cheese",
};

export const areaClimbingLocation: ClimbingMapLocation = {
  coordinates: { latitude: 37.23, longitude: -122.092 },
  scope: "area",
  objectId: "goat-rock",
  providerId: "openbeta",
  name: "Goat Rock",
};
