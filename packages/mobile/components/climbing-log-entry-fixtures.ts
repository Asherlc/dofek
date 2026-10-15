import type { ClimbingMapLocation } from "@dofek/training/climbing-map";
import {
  climbingAttemptFixture,
  climbingClimbFixture,
  climbingLogEntryFixture,
} from "../../server/src/repositories/climbing-test-helpers.ts";

const climb = climbingClimbFixture("mountain-project");
export const climbingLogFixture = climbingLogEntryFixture({
  id: "tick-1",
  providerId: "mountain-project",
  climbId: climb.id,
  climb: {
    ...climb,
    name: "Swiss Cheese",
    areaPath: climb.areaPath.map((area) => ({ ...area, name: "Goat Rock" })),
  },
  sourceName: "Mountain Project",
  displayGrade: "5.4",
  recordedClimbAttemptCount: 2,
  recordedClimbOutcome: "completed",
  attempts: [
    climbingAttemptFixture("tick-1", {
      id: "20000000-0000-4000-8000-000000000006",
      outcome: "failed",
      ropeMethod: "lead",
    }),
    climbingAttemptFixture("tick-1", {
      outcome: "completed",
      ropeMethod: "lead",
      rockResultLabels: ["sent"],
    }),
  ],
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
});

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
