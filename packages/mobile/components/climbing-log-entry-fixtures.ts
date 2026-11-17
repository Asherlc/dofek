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
  recordedClimbAttemptCount: null,
  recordedClimbOutcome: "completed",
  attempts: [
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

export function mountainProjectAscentEntry(
  id: string,
  climbName: string,
  ascentType: "Onsight" | "Flash" | "Redpoint",
) {
  const climb = climbingLogFixture.climb;
  return {
    ...climbingLogFixture,
    id,
    climbId: `${id}-climb`,
    title: climbName,
    recordedClimbAttemptCount: null,
    recordedClimbOutcome: "completed" as const,
    climb: climb && { ...climb, id: `${id}-climb`, name: climbName },
    attempts: [
      climbingAttemptFixture(id, {
        id: `${id}-attempt`,
        outcome: "completed",
        ropeMethod: "lead",
        rockResultLabels: ascentType === "Redpoint" ? ["sent"] : ["sent", ascentType],
        attemptIndex: ascentType === "Redpoint" ? null : 1,
        receivedBeta: ascentType === "Flash" ? true : null,
        hadCompletedBefore: ascentType === "Redpoint" ? null : false,
      }),
    ],
  };
}

function recordedCountEntry(
  id: string,
  title: string,
  count: number,
  outcome: "completed" | "failed" | null,
  wallAngle: { value: number; unit: "degrees" | null } | null,
) {
  const climb = climbingLogFixture.climb;
  return {
    ...climbingLogFixture,
    id,
    climbId: `${id}-climb`,
    providerId: "kaya",
    sourceName: "Kaya",
    title,
    recordedClimbAttemptCount: count,
    recordedClimbOutcome: outcome,
    wallAngle,
    board: title === "Blue Circuit" ? { name: "Training Board", externalId: "board-1" } : null,
    climb: climb && {
      ...climb,
      id: `${id}-climb`,
      name: title,
      areaId: `${id}-area`,
      areaPath: climb.areaPath.map((area) => ({
        ...area,
        id: `${id}-area`,
        name: "Touchstone Pacific Pipe",
      })),
    },
    attempts: [
      climbingAttemptFixture(id, {
        id: `${id}-attempt`,
        outcome,
        ropeMethod: null,
        rockResultLabels: outcome === "completed" ? ["sent"] : [],
        attemptIndex: 1,
      }),
    ],
  };
}

export const recordedCountEntries = {
  completed: recordedCountEntry("blue-circuit", "Blue Circuit", 7, "completed", {
    value: -20,
    unit: null,
  }),
  project: recordedCountEntry("project", "Project", 1, "failed", {
    value: 35,
    unit: "degrees",
  }),
  unknown: recordedCountEntry("unknown-outcome", "Unsent", 1, null, null),
};

export const areaClimbingLocation: ClimbingMapLocation = {
  coordinates: { latitude: 37.23, longitude: -122.092 },
  scope: "area",
  objectId: "goat-rock",
  providerId: "openbeta",
  name: "Goat Rock",
};
