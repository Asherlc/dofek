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
  recordedClimbAttemptCount: null,
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

function kayaEntry({
  id,
  name,
  grade,
  count,
  outcome,
  wallAngle,
}: {
  id: string;
  name: string | null;
  grade: string;
  count: number;
  outcome: "completed" | "failed" | null;
  wallAngle: number | null;
}) {
  const climb = climbingClimbFixture("kaya");
  const area = climb.areaPath[0];
  if (!area) throw new Error("Expected Kaya area fixture");
  const entryClimb = {
    ...climb,
    id: `${id}-climb`,
    name,
    kind: "boulder" as const,
    areaId: `${id}-area`,
    areaPath: [{ ...area, id: `${id}-area`, name: "Touchstone Pacific Pipe" }],
    publishedGrades: [{ value: grade, system: "v_scale" as const }],
  };
  return climbingLogEntryFixture({
    id,
    providerId: "kaya",
    climbId: entryClimb.id,
    discipline: "rock_climbing",
    sourceName: "Kaya",
    sourceLinks: [],
    displayGrade: grade,
    board: null,
    wallAngle: wallAngle === null ? null : { value: wallAngle, unit: "degrees" },
    holdTypes: null,
    recordedClimbAttemptCount: count,
    recordedClimbOutcome: outcome,
    climb: entryClimb,
    attempts: [
      climbingAttemptFixture(id, {
        id: `${id}-attempt-0`,
        outcome,
        ropeMethod: null,
        rockResultLabels: outcome === "completed" ? ["sent"] : [],
      }),
    ],
  });
}

export const mixedClimbingEntries = [
  kayaEntry({
    id: "climb-v4",
    name: "Blue Circuit",
    grade: "V4",
    count: 7,
    outcome: "completed",
    wallAngle: null,
  }),
  kayaEntry({
    id: "climb-project",
    name: "Project",
    grade: "V5",
    count: 1,
    outcome: "failed",
    wallAngle: 35,
  }),
  kayaEntry({
    id: "kaya-unsent",
    name: null,
    grade: "V3",
    count: 1,
    outcome: null,
    wallAngle: null,
  }),
];

export const climbingMapLocations: Readonly<Record<string, ClimbingMapLocation>> = {
  "tick-1": exactClimbingLocation,
  "tick-2": areaClimbingLocation,
  "tick-4": exactClimbingLocation,
};
