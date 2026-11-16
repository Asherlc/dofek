import type { ActivitySourceTree } from "@dofek/providers/activity-source-tree";
import type { ActivityMetricSources } from "../../../server/src/contracts/activity-metric-sources.ts";
import type { ActivityDetail } from "../../../server/src/models/activity.ts";
import {
  climbingAttemptFixture,
  climbingClimbFixture,
  climbingLogEntryFixture,
} from "../../../server/src/repositories/climbing-test-helpers.ts";
import type { StreamPoint, StrengthExerciseDetail } from "../../../server/src/routers/activity.ts";

export const detailSourceTree: ActivitySourceTree = {
  primary: {
    id: "garmin-record",
    providerId: "garmin",
    sourceName: "Garmin Edge 530",
    label: "Garmin Edge 530",
    description: null,
    url: "https://connect.garmin.com/modern/activity/123",
    children: [
      {
        id: "strava-record",
        providerId: "strava",
        sourceName: null,
        label: "Strava",
        description: null,
        url: "https://www.strava.com/activities/123",
        children: [
          {
            id: "apple-strava-record",
            providerId: "apple_health",
            sourceName: null,
            label: "Apple Health",
            description: null,
            url: null,
            children: [],
          },
        ],
      },
      {
        id: "apple-garmin-record",
        providerId: "apple_health",
        sourceName: null,
        label: "Apple Health",
        description: null,
        url: null,
        children: [],
      },
    ],
  },
  otherSources: [
    {
      id: "whoop-record",
      providerId: "whoop",
      sourceName: null,
      label: "WHOOP",
      description: "Other matching source",
      url: null,
      children: [],
    },
  ],
};

export const removedDetailSourceTree: ActivitySourceTree = {
  primary: {
    id: "removed-garmin-record",
    providerId: "garmin",
    sourceName: "Garmin Edge 530",
    label: "Garmin Edge 530",
    description: "Removed from provider",
    url: null,
    children: [
      {
        id: "removed-strava-record",
        providerId: "strava",
        sourceName: null,
        label: "Strava",
        description: "Removed from provider",
        url: null,
        children: [],
      },
    ],
  },
  otherSources: [
    {
      id: "active-whoop-record",
      providerId: "whoop",
      sourceName: null,
      label: "WHOOP",
      description: "Other matching source",
      url: "https://app.whoop.com/activities/123",
      children: [],
    },
  ],
};

export const baseActivity: ActivityDetail = {
  climbingLogSessions: [],
  id: "abc-123",
  activityType: "cycling",
  primaryActivityType: null,
  rawType: "cycling",
  modality: null,
  startedAt: "2026-03-31T08:00:00Z",
  displayedDate: "2026-03-31",
  endedAt: "2026-03-31T09:30:00Z",
  durationMin: 90,
  localTimeContext: {
    timezone: "America/Los_Angeles",
    startUtcOffsetMinutes: -420,
    endUtcOffsetMinutes: -420,
    source: "provider_timezone",
  },
  name: "Morning Ride",
  notes: null,
  perceivedExertion: null,
  providerId: "garmin",
  subsource: null,
  sourceProviders: ["garmin", "strava", "apple_health", "whoop"],
  sourceLinks: [
    {
      providerId: "garmin",
      externalId: "123",
      subsource: null,
      label: "Garmin Connect",
      url: "https://connect.garmin.com/modern/activity/123",
      providerAbsentAt: null,
    },
  ],
  sourceTree: detailSourceTree,
  avgHr: 145,
  avgHrState: { status: "available" },
  maxHr: 175,
  maxHrState: { status: "available" },
  avgPower: 220,
  avgPowerState: { status: "available" },
  maxPower: 450,
  maxPowerState: { status: "available" },
  avgSpeed: 8.5,
  avgSpeedState: { status: "available" },
  maxSpeed: 15.2,
  maxSpeedState: { status: "available" },
  avgCadence: 85,
  avgCadenceState: { status: "available" },
  totalDistance: 42000,
  totalDistanceState: { status: "available" },
  elevationGain: 350,
  elevationGainState: { status: "available" },
  elevationLoss: 340,
  elevationLossState: { status: "available" },
  sampleCount: 5400,
  sampleCountState: { status: "available" },
  providerAbsentAt: null,
  sourceDecision: null,
  fitRecoveryWarning: null,
};

export const detailPageActivity: ActivityDetail & { displayedDate?: string } = {
  climbingLogSessions: [],
  id: "test-123",
  displayedDate: "2026-03-18",
  notes: null,
  perceivedExertion: null,
  maxSpeed: null,
  maxSpeedState: { status: "missing", reason: "Max Speed not recorded" },
  elevationLoss: null,
  elevationLossState: { status: "missing", reason: "Elevation Loss not recorded" },
  sampleCount: null,
  sampleCountState: { status: "missing", reason: "Sample Count not recorded" },
  name: "Morning Run",
  activityType: "running",
  primaryActivityType: null,
  rawType: "running",
  modality: null,
  startedAt: "2026-03-18T07:00:00Z",
  endedAt: "2026-03-18T07:45:00Z",
  durationMin: 45,
  localTimeContext: {
    timezone: null,
    startUtcOffsetMinutes: 60,
    endUtcOffsetMinutes: 60,
    source: "provider_offset",
  },
  providerId: "whoop",
  subsource: null,
  providerAbsentAt: null,
  totalDistance: 10000,
  totalDistanceState: { status: "available" },
  elevationGain: 200,
  elevationGainState: { status: "available" },
  avgHr: 150,
  avgHrState: { status: "available" },
  maxHr: 175,
  maxHrState: { status: "available" },
  avgPower: null,
  avgPowerState: { status: "missing", reason: "Avg Power not recorded" },
  maxPower: null,
  maxPowerState: { status: "missing", reason: "Max Power not recorded" },
  avgSpeed: 3,
  avgSpeedState: { status: "available" },
  avgCadence: null,
  avgCadenceState: { status: "missing", reason: "Avg Cadence not recorded" },
  sourceProviders: ["whoop", "apple_health"],
  sourceLinks: [],
  sourceTree: { primary: null, otherSources: [] },
  sourceDecision: null,
  fitRecoveryWarning: null,
};

export const detailPageStreamPoints: StreamPoint[] = [
  {
    recordedAt: "2026-03-18T07:00:00Z",
    lat: 1,
    lng: 1,
    heartRate: 140,
    power: null,
    speed: 3,
    cadence: null,
    altitude: 100,
  },
  {
    recordedAt: "2026-03-18T07:15:00Z",
    lat: 1.1,
    lng: 1.1,
    heartRate: 155,
    power: null,
    speed: 3.5,
    cadence: null,
    altitude: 250,
  },
  {
    recordedAt: "2026-03-18T07:30:00Z",
    lat: 1.2,
    lng: 1.2,
    heartRate: 160,
    power: null,
    speed: 2.8,
    cadence: null,
    altitude: 400,
  },
];

export function detailPageWithFirstHeartRate(
  points: StreamPoint[],
  heartRate: number,
): StreamPoint[] {
  return points.map((point, index) => ({
    ...point,
    heartRate: index === 0 ? heartRate : point.heartRate,
  }));
}

export const detailPageClimbingHeartRateContext = {
  window: { startedAt: "2026-04-14T09:55:00.000Z", endedAt: "2026-04-14T11:05:00.000Z" },
  points: [
    { recordedAt: "2026-04-14T09:55:00.000Z", value: 91 },
    { recordedAt: "2026-04-14T11:05:00.000Z", value: 92 },
  ],
};

export const detailPageCachedHrZone = {
  zone: 1,
  label: "Recovery",
  minPct: 50,
  maxPct: 60,
  seconds: 240,
  percent: 100,
};
export const detailPageActivityTitleCases = [
  { activityType: "walking", primaryActivityType: "running", title: "Running", occurrences: 2 },
  { activityType: "hiking", primaryActivityType: null, title: "Hiking", occurrences: 3 },
] as const;
export const detailPageClimbingRouteStates = [
  "unavailable",
  "loading",
  "processing",
  "error",
  "cached error",
  "cached loading",
] as const;
export const detailPageRouteBoundsPoints = [
  { lat: 7, lng: 8 },
  { lat: 9, lng: 10 },
];
export const detailPageConfiguredThresholdEvidence = {
  value: 250,
  unit: "watt" as const,
  method: "configured" as const,
  effective_from: "2026-03-01",
  source_record_id: "00000000-0000-4000-8000-000000000101",
  unavailable_reason: null,
};

export const detailPageCachedPowerZones = {
  activityDate: "2026-03-18",
  ftp: 250,
  thresholdEvidence: detailPageConfiguredThresholdEvidence,
  zones: [{ zone: 1, label: "Endurance", minPct: 56, maxPct: 75, seconds: 240, percent: 100 }],
};

export const detailPageUnavailablePowerZones = {
  activityDate: "2026-03-18",
  ftp: null,
  zones: [],
  thresholdEvidence: {
    ...detailPageConfiguredThresholdEvidence,
    value: null,
    effective_from: null,
    source_record_id: null,
    unavailable_reason: "No FTP setting applies to this activity.",
  },
};

export const detailPageMetricSources: ActivityMetricSources = [
  {
    key: "heartRate",
    label: "Heart Rate",
    defaultSourceId: "hr-a",
    sources: [
      {
        id: "hr-a",
        label: "Heart rate A",
        presentation: {
          displayName: "A",
          providerId: "whoop",
          sourceName: null,
          attribution: null,
        },
      },
      {
        id: "hr-b",
        label: "Heart rate B",
        presentation: {
          displayName: "B",
          providerId: "garmin",
          sourceName: null,
          attribution: null,
        },
      },
    ],
  },
  {
    key: "power",
    label: "Power",
    defaultSourceId: "power-a",
    sources: [
      {
        id: "power-a",
        label: "Power A",
        presentation: {
          displayName: "A",
          providerId: "wahoo",
          sourceName: null,
          attribution: null,
        },
      },
      {
        id: "power-b",
        label: "Power B",
        presentation: {
          displayName: "B",
          providerId: "garmin",
          sourceName: null,
          attribution: null,
        },
      },
    ],
  },
  {
    key: "altitude",
    label: "Elevation",
    defaultSourceId: "altitude-a",
    sources: [
      {
        id: "altitude-a",
        label: "Elevation A",
        presentation: {
          displayName: "A",
          providerId: "garmin",
          sourceName: null,
          attribution: null,
        },
      },
      {
        id: "altitude-b",
        label: "Elevation B",
        presentation: {
          displayName: "B",
          providerId: "wahoo",
          sourceName: null,
          attribution: null,
        },
      },
    ],
  },
];

export const detailPageStrengthExercises: StrengthExerciseDetail[] = [
  {
    activityId: "10000000-0000-4000-8000-000000000001",
    exerciseIndex: 0,
    exerciseName: "Pull-up",
    equipment: null,
    muscleGroups: null,
    exerciseType: "strength",
    sets: [
      {
        setIndex: 0,
        setType: "working",
        weightKg: 70,
        reps: 8,
        durationSeconds: null,
        rpe: 8,
        notes: null,
      },
    ],
  },
];

export const detailPageNullStreamPoint: StreamPoint = {
  recordedAt: "2026-03-18T07:00:00Z",
  lat: null,
  lng: null,
  heartRate: null,
  power: null,
  speed: null,
  cadence: null,
  altitude: null,
};

export const detailPageClimbingLocations = {
  entries: [
    climbingLogEntryFixture({ id: "unlocated", title: "Unknown location" }),
    climbingLogEntryFixture({
      id: "20000000-0000-4000-8000-000000000011",
      title: "Located climb",
      mapLocation: {
        coordinates: { latitude: 0, longitude: -122.25 },
        scope: "climb",
        objectId: "20000000-0000-4000-8000-000000000003",
        providerId: "mountain-project",
        name: "Located climb",
      },
    }),
  ],
  suggestions: [
    climbingLogEntryFixture({
      id: "suggested",
      title: "Suggested climb",
      mapLocation: {
        coordinates: { latitude: 1, longitude: -122.5 },
        scope: "area",
        objectId: "source-area",
        providerId: "openbeta",
        name: "Containing area",
      },
    }),
  ],
};

export const detailPageCachedTimedClimb = climbingLogEntryFixture({
  id: "cached-log",
  title: "Cached climb",
  chartAnnotations: [
    {
      id: "cached-log",
      label: "Cached timed climb",
      startedAt: "2026-03-18T07:15:00Z",
      endedAt: null,
    },
  ],
});
export const detailPageSuggestedClimb = climbingLogEntryFixture({
  id: "suggested-log",
  title: "Suggested climb",
});
export const detailPageSummitOuting = climbingLogEntryFixture({
  id: "cached-log",
  title: "Summit outing",
});
export const detailPageRidgeTraverse = climbingLogEntryFixture({
  id: "suggested-log",
  title: "Ridge traverse",
});
export const detailPageCorner = climbingLogEntryFixture({ id: "tick-1", title: "The Corner" });
export const detailPageCachedRouteSuggestion = climbingLogEntryFixture({
  id: "cached-suggestion",
  mapLocation: {
    coordinates: { latitude: 42, longitude: -100 },
    scope: "area",
    objectId: "cached-area",
    providerId: "openbeta",
    name: "Cached area",
  },
});

export const detailPageAvailableArete = climbingLogEntryFixture({
  id: "available-tick",
  providerId: "openbeta",
  climbId: "available-tick-climb",
  discipline: "rock_climbing",
  sourceName: "OpenBeta",
  sourceLinks: [],
  displayGrade: "5.10a",
  board: null,
  wallAngle: null,
  holdTypes: null,
  recordedClimbAttemptCount: 1,
  recordedClimbOutcome: "completed",
  climb: {
    ...climbingClimbFixture("openbeta"),
    id: "available-tick-climb",
    name: "Available Arete",
    kind: "route",
    areaId: "available-tick-area-0",
    areaPath: [
      {
        id: "available-tick-area-0",
        userId: "20000000-0000-4000-8000-000000000002",
        providerId: "openbeta",
        externalId: null,
        name: "Test Crag",
        parentAreaId: null,
        coordinates: null,
      },
    ],
    publishedGrades: [{ value: "5.10a", system: "yds" }],
  },
  attempts: [
    climbingAttemptFixture("available-tick", {
      id: "available-tick-attempt-0",
      outcome: "completed",
      ropeMethod: "lead",
      usedAid: false,
      fellOrHung: false,
      rockResultLabels: ["sent", "Onsight"],
      attemptIndex: 1,
      receivedBeta: false,
      hadCompletedBefore: false,
    }),
  ],
});

export const detailPageHangboardDetails = {
  planName: "7/3 Repeaters",
  boardName: "Tension Board",
  segmentsError: null,
  summary: {
    durationSeconds: 600,
    workIntervalCount: 1,
    totalWorkDurationSeconds: 7,
    totalRestDurationSeconds: 3,
    exercises: [{ label: "Repeaters", workIntervalCount: 1, workDurationSeconds: 7 }],
  },
};
