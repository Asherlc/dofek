import type { ActivityMetricSources } from "../../server/src/contracts/activity-metric-sources.ts";
import {
  climbingAttemptFixture,
  climbingClimbFixture,
  climbingLogEntryFixture,
} from "../../server/src/repositories/climbing-test-helpers.ts";
import { activityImageFixture } from "../components/activity-images-test-helpers";

export const baseCyclingActivity = {
  id: "00000000-0000-0000-0000-000000000001",
  activityType: "cycling",
  modality: null,
  primaryActivityType: null,
  displayedDate: "2026-04-14",
  startedAt: "2026-04-14T10:00:00.000Z",
  endedAt: "2026-04-14T11:00:00.000Z",
  durationMin: 60,
  climbingLogSessions: [],
  localTimeContext: {
    timezone: "America/Los_Angeles",
    startUtcOffsetMinutes: -420,
    endUtcOffsetMinutes: -420,
    source: "provider_timezone",
  },
  name: "Morning Ride",
  notes: null,
  perceivedExertion: null,
  providerId: "wahoo",
  subsource: null,
  sourceProviders: ["wahoo"],
  sourceLinks: [],
  sourceDecision: null,
  fitRecoveryWarning: null,
  sourceTree: { primary: null, otherSources: [] },
  avgHr: 145,
  avgHrState: { status: "available" },
  maxHr: 172,
  maxHrState: { status: "available" },
  avgPower: 220,
  avgPowerState: { status: "available" },
  maxPower: 350,
  maxPowerState: { status: "available" },
  avgSpeed: 30,
  avgSpeedState: { status: "available" },
  maxSpeed: 50,
  maxSpeedState: { status: "available" },
  avgCadence: 88,
  avgCadenceState: { status: "available" },
  totalDistance: 30000,
  totalDistanceState: { status: "available" },
  elevationGain: 400,
  elevationGainState: { status: "available" },
  elevationLoss: 380,
  elevationLossState: { status: "available" },
  sampleCount: 200,
  sampleCountState: { status: "available" },
};

export const attachedClimbingEntry = climbingLogEntryFixture({
  id: "attached-climb",
  providerId: "kaya",
  climbId: "attached-climb-climb",
  discipline: "rock_climbing",
  sourceName: "Kaya",
  sourceLinks: [],
  displayGrade: "V3",
  board: null,
  wallAngle: null,
  holdTypes: null,
  recordedClimbAttemptCount: 1,
  recordedClimbOutcome: "completed",
  climb: {
    ...climbingClimbFixture("kaya"),
    ...{
      id: "attached-climb-climb",
      name: "Attached Boulder",
      kind: "boulder",
      areaId: "attached-climb-area-0",
      areaPath: [
        {
          id: "attached-climb-area-0",
          userId: "20000000-0000-4000-8000-000000000002",
          providerId: "kaya",
          externalId: null,
          name: "Pacific Pipe",
          parentAreaId: null,
          coordinates: null,
        },
      ],
      publishedGrades: [{ value: "V3", system: "v_scale" }],
    },
  },
  attempts: [
    climbingAttemptFixture("attached-climb", {
      id: "attached-climb-attempt-0",
      outcome: "completed",
      ropeMethod: null,
      usedAid: false,
      fellOrHung: false,
      dabbed: false,
      rockResultLabels: ["sent", "Flash"],
      attemptIndex: 1,
      receivedBeta: true,
      hadCompletedBefore: false,
    }),
  ],
});

export const streamPointsWithHrAndPower = Array.from({ length: 5 }, (_, index) => ({
  recordedAt: `2026-04-14T10:0${index}:00.000Z`,
  heartRate: 140 + index,
  power: 210 + index * 5,
  speed: 8.0 + index * 0.1,
  cadence: 87 + index,
  altitude: 100 + index * 2,
  lat: null,
  lng: null,
}));
export const zeroPowerStreamPoints = streamPointsWithHrAndPower.map((point) => ({
  ...point,
  power: 0,
}));
export const noPowerStreamPoints = streamPointsWithHrAndPower.map((point) => ({
  ...point,
  power: null,
}));

export const kilterClimbingActivity = {
  ...baseCyclingActivity,
  activityType: "climbing",
  endedAt: null,
  durationMin: null,
  climbingLogSessions: [
    {
      id: "kilter-session-1",
      providerId: "kilter",
      memberActivityIds: ["kilter-point-1"],
      firstLoggedAt: "2026-04-14T10:02:00.000Z",
      lastLoggedAt: "2026-04-14T10:02:00.000Z",
    },
  ],
};

export const kilterAndKayaClimbingEntries = [
  climbingLogEntryFixture({ id: "kaya-climb", providerId: "kaya", title: "Kaya wall climb" }),
  climbingLogEntryFixture({
    id: "kilter-climb",
    providerId: "kilter",
    title: "Kilter board climb",
  }),
];

export const surroundingClimbingHeartRate = {
  window: { startedAt: "2026-04-14T09:55:00.000Z", endedAt: "2026-04-14T11:05:00.000Z" },
  points: [
    { recordedAt: "2026-04-14T09:55:00.000Z", value: 91 },
    { recordedAt: "2026-04-14T11:05:00.000Z", value: 92 },
  ],
};

export const refreshedGarminHardware = {
  items: [
    {
      id: "watch",
      activityId: "garmin-record",
      providerId: "garmin",
      sourceName: null,
      role: "recorder",
      label: "Edge 530",
      model: "Edge 530",
      manufacturer: "Garmin",
      evidence: "Reported recording device.",
      details: [],
    },
  ],
  power: [],
};

export const downloadedActivityImages = {
  images: [
    {
      ...activityImageFixture,
      id: "shared-photo",
      url: "https://images.example.test/photo.jpg",
      sources: activityImageFixture.sources.map((source) => ({
        ...source,
        caption: "At the summit",
      })),
    },
  ],
  coverage: [],
  acquisition: [],
};

export const repeatedClimbingEntries = (() => {
  const climb = climbingClimbFixture("mountain-project");
  const firstId = "10000000-0000-4000-8000-000000000311";
  const first = climbingLogEntryFixture({
    id: firstId,
    climb,
    climbId: climb.id,
    notes: "First occurrence notes",
    mapLocation: {
      coordinates: { latitude: 37, longitude: -122 },
      scope: "climb",
      objectId: climb.id,
      providerId: "mountain-project",
      name: climb.name,
    },
  });
  return [
    first,
    { ...first, id: "10000000-0000-4000-8000-000000000312", notes: "Second occurrence notes" },
  ];
})();

export const unconfiguredCyclingPowerZones = {
  ftp: null,
  activityDate: "2026-05-15",
  zones: [],
  thresholdEvidence: {
    value: null,
    unit: "watt" as const,
    method: "configured" as const,
    effective_from: null,
    source_record_id: null,
    unavailable_reason: "No FTP is configured.",
  },
};

export const hangboardActivity = {
  ...baseCyclingActivity,
  activityType: "hangboard",
  name: "Repeaters",
};
export const importedHangboardDetails = {
  planName: "Imported 7/3",
  boardName: "Tension Board",
  segmentsError: null,
  summary: {
    durationSeconds: 300,
    workIntervalCount: 0,
    totalWorkDurationSeconds: null,
    totalRestDurationSeconds: null,
    exercises: [],
  },
};

export const yogaActivity = {
  ...baseCyclingActivity,
  activityType: "yoga",
  avgPower: null,
  maxPower: null,
  name: "Yoga Session",
};
export const heartRateOnlyStreamPoints = streamPointsWithHrAndPower.map((point) => ({
  ...point,
  power: null,
  altitude: null,
}));

export const sparseTemperatureStreamPoints = [
  {
    recordedAt: "2026-04-14T10:00:00.000Z",
    heartRate: null,
    power: null,
    speed: null,
    cadence: null,
    altitude: null,
    lat: 1,
    lng: -121,
    skinTemperature: null,
    skinTemperatureRecordedAt: null,
  },
  {
    recordedAt: "2026-04-14T10:30:00.000Z",
    heartRate: null,
    power: null,
    speed: null,
    cadence: null,
    altitude: null,
    lat: 2,
    lng: -122,
    skinTemperature: 32.18,
    skinTemperatureRecordedAt: "2026-04-14T10:30:00.000Z",
  },
];

export const activityDetailMetricSources: ActivityMetricSources = [
  {
    key: "heartRate",
    label: "Heart Rate",
    defaultSourceId: "whoop",
    sources: [
      {
        id: "whoop",
        label: "WHOOP",
        presentation: {
          displayName: "WHOOP",
          providerId: "whoop",
          sourceName: null,
          attribution: null,
        },
      },
      {
        id: "garmin",
        label: "Garmin",
        presentation: {
          displayName: "Garmin",
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
    defaultSourceId: "wahoo",
    sources: [
      {
        id: "wahoo",
        label: "Wahoo",
        presentation: {
          displayName: "Wahoo",
          providerId: "wahoo",
          sourceName: null,
          attribution: null,
        },
      },
      {
        id: "garmin",
        label: "Garmin",
        presentation: {
          displayName: "Garmin",
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
    defaultSourceId: "wahoo",
    sources: [
      {
        id: "wahoo",
        label: "Wahoo",
        presentation: {
          displayName: "Wahoo",
          providerId: "wahoo",
          sourceName: null,
          attribution: null,
        },
      },
      {
        id: "garmin",
        label: "Garmin",
        presentation: {
          displayName: "Garmin",
          providerId: "garmin",
          sourceName: null,
          attribution: null,
        },
      },
    ],
  },
  {
    key: "skinTemperature",
    label: "Skin Temperature",
    defaultSourceId: '["whoop_ble","strap-a"]',
    sources: [
      {
        id: '["whoop_ble","strap-a"]',
        label: "WHOOP Bluetooth · strap-a",
        presentation: {
          displayName: "strap-a",
          providerId: "whoop_ble",
          sourceName: "strap-a",
          attribution: { kind: "bluetooth", label: "Bluetooth" },
        },
      },
    ],
  },
];

export const climbingActivity = { ...baseCyclingActivity, activityType: "climbing" };
export const processingRoute = { status: "processing" };
export const readyActivityRoute = {
  status: "ready",
  points: [
    { lat: 37.1, lng: -122.1 },
    { lat: 37.9, lng: -122.9 },
  ],
};
export const scopedCyclingRoute = {
  status: "ready",
  points: [
    { lat: 7, lng: 8 },
    { lat: 9, lng: 10 },
  ],
};
export const cachedClimbingRoute = { status: "ready", points: [{ lat: 7, lng: 8 }] };
export const readySparseTemperatureRoute = {
  status: "ready",
  points: [
    { lat: 1, lng: -121 },
    { lat: 2, lng: -122 },
  ],
};

export const restorableActivity = {
  ...baseCyclingActivity,
  providerAbsentAt: "2026-03-05T14:30:00.000Z",
};
export const visibleRestoredActivity = { ...baseCyclingActivity, providerAbsentAt: null };
export const aliasedRestorableActivity = {
  ...baseCyclingActivity,
  id: "00000000-0000-4000-8000-000000000201",
  providerId: "strava",
  providerAbsentAt: "2026-03-05T14:30:00.000Z",
};
export const activityAliasRouteId = "00000000-0000-4000-8000-000000000999";

export const powerWorkBySource = {
  wahoo: { workKilojoules: 720, coverage: { coveredSeconds: 3600, coveragePct: 100 } },
  garmin: { workKilojoules: 810, coverage: { coveredSeconds: 3600, coveragePct: 100 } },
};
export const partialRouteStreamPoint = { ...streamPointsWithHrAndPower[0], lat: 37.1, lng: -122.1 };

export const configuredThresholdEvidence = {
  value: 250,
  unit: "watt" as const,
  method: "configured" as const,
  effective_from: "2026-02-01",
  source_record_id: "00000000-0000-4000-8000-000000000101",
  unavailable_reason: null,
};
export const configuredPowerZones = {
  ftp: 250,
  activityDate: "2026-05-15",
  thresholdEvidence: configuredThresholdEvidence,
  zones: [{ zone: 2, label: "Endurance", minPct: 56, maxPct: 75, seconds: 600, percent: 100 }],
};

export const climbingMapRecords = {
  unlocated: climbingLogEntryFixture({ id: "unlocated", title: "Unknown location" }),
  located: climbingLogEntryFixture({
    id: "10000000-0000-4000-8000-000000000301",
    title: "Located climb",
    mapLocation: {
      coordinates: { latitude: 0, longitude: -122.25 },
      scope: "climb",
      objectId: "10000000-0000-4000-8000-000000000302",
      providerId: "mountain-project",
      name: "Located climb",
    },
  }),
  suggested: climbingLogEntryFixture({
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
};

export const cachedClimbingErrorEntries = {
  attached: climbingLogEntryFixture({ id: "cached-log", title: "Summit outing" }),
  suggested: climbingLogEntryFixture({ id: "suggested-log", title: "Ridge traverse" }),
};
export const cachedAreaSuggestion = climbingLogEntryFixture({
  id: "cached-suggestion",
  mapLocation: {
    coordinates: { latitude: 42, longitude: -100 },
    scope: "area",
    objectId: "cached-area",
    providerId: "openbeta",
    name: "Cached area",
  },
});
export const attachableSuggestedClimb = {
  ...attachedClimbingEntry,
  id: "suggested-climb",
  climb: attachedClimbingEntry.climb && {
    ...attachedClimbingEntry.climb,
    name: "Suggested Boulder",
  },
  attempts: attachedClimbingEntry.attempts.map((attempt) => ({
    ...attempt,
    climbingLogEntryId: "suggested-climb",
  })),
};

export const expectedClimbingMapMarkers = [
  {
    entryId: "10000000-0000-4000-8000-000000000301",
    entryNumber: 2,
    label: "Located climb",
    location: {
      coordinates: { latitude: 0, longitude: -122.25 },
      scope: "climb",
      objectId: "10000000-0000-4000-8000-000000000302",
      providerId: "mountain-project",
      name: "Located climb",
    },
  },
  {
    entryId: "suggested",
    entryNumber: 3,
    label: "Suggested climb",
    location: {
      coordinates: { latitude: 1, longitude: -122.5 },
      scope: "area",
      objectId: "source-area",
      providerId: "openbeta",
      name: "Containing area",
    },
  },
];
