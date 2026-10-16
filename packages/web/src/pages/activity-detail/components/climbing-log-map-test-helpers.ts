import type { ClimbingMapLocation } from "@dofek/training/climbing-map";
import {
  climbingAttemptFixture,
  climbingClimbFixture,
  climbingLogEntryFixture,
} from "../../../../../server/src/repositories/climbing-test-helpers.ts";

const climb = { ...climbingClimbFixture("mountain-project"), name: "Swiss Cheese" };
const first = climbingLogEntryFixture({
  id: "tick-1",
  climb,
  climbId: climb.id,
  providerId: "mountain-project",
  sourceName: "Mountain Project",
  displayGrade: "5.4",
  recordedClimbAttemptCount: 1,
  sourceLinks: [
    {
      providerId: "mountain-project",
      kind: "route",
      url: "https://www.mountainproject.com/route/105734732/swiss-cheese",
    },
  ],
});
first.attempts = [climbingAttemptFixture(first.id, { ropeMethod: "top_rope" })];
export const exactClimbingLocation: ClimbingMapLocation = {
  coordinates: { latitude: 37.234, longitude: -122.111 },
  scope: "climb",
  objectId: climb.id,
  providerId: "mountain-project",
  name: "Swiss Cheese",
};
export const areaClimbingLocation: ClimbingMapLocation = {
  coordinates: { latitude: 37.236, longitude: -122.112 },
  scope: "area",
  objectId: "goat-rock",
  providerId: "openbeta",
  name: "Goat Rock",
};
export const climbingMapLogs = [
  first,
  climbingLogEntryFixture({
    id: "tick-2",
    title:
      "The unusually long ridge traverse above the north-facing wall and its narrow exposed corner",
    sourceName: "OpenBeta",
    sourceLinks: [{ providerId: "openbeta", kind: "route", url: "https://openbeta.io/" }],
    displayGrade: "5.8",
    recordedClimbAttemptCount: 1,
  }),
  climbingLogEntryFixture({
    id: "tick-3",
    title: "Indoor board log",
    board: { name: "Training Board", externalId: null },
    recordedClimbAttemptCount: 1,
  }),
  {
    ...first,
    id: "tick-4",
    attempts: [climbingAttemptFixture("tick-4", { ropeMethod: "top_rope" })],
  },
];
export const climbingMapLocations: Readonly<Record<string, ClimbingMapLocation>> = {
  "tick-1": exactClimbingLocation,
  "tick-2": areaClimbingLocation,
  "tick-4": exactClimbingLocation,
};
