import type {
  GhostSessionsCompareResponse,
  GhostSessionsGetResponse,
  GhostSessionsPassesResponse,
} from "@dofek/training/ghost-sessions";

export const ghostActivityId = "00000000-0000-4000-8000-000000000001";
export const recentGhostActivityId = "00000000-0000-4000-8000-000000000002";
export const olderGhostActivityId = "00000000-0000-4000-8000-000000000003";
const startedAtMs = Date.UTC(2026, 10, 24, 15);

function recordedInterval(offsetMs: number, elapsedMs: number, lat: number) {
  const start = { timestampMs: startedAtMs + offsetMs, distanceMeters: 0, lat, lng: -122.425 };
  return {
    start,
    end: {
      ...start,
      timestampMs: start.timestampMs + elapsedMs,
      distanceMeters: 1_600,
      lng: -122.403,
    },
    elapsedMs,
  };
}

const fullRoute = recordedInterval(0, 480_000, 37.78);
const overlap = recordedInterval(60_000, 300_000, 37.78);
export const ghostFullSection = {
  kind: "route" as const,
  sectionId: "route:fixture",
  anchor: fullRoute,
  suggestedGhost: { passId: "recent-pass", reason: "most-recent" as const },
  geometry: [
    [
      { lat: 37.78, lng: -122.425 },
      { lat: 37.781, lng: -122.421 },
    ],
    [
      { lat: 37.782, lng: -122.417 },
      { lat: 37.78, lng: -122.403 },
    ],
  ],
};

export const ghostNamedSections = [
  {
    kind: "named-road" as const,
    sectionId: "named:road-fixture",
    name: "Cedar Road",
    attribution: "© OpenStreetMap contributors · Powered by Geoapify",
    anchor: fullRoute,
    suggestedGhost: { passId: "road-pass", reason: "most-recent" as const },
  },
  {
    kind: "named-trail" as const,
    sectionId: "named:trail-fixture",
    name: "Ridge Trail",
    attribution: "© OpenStreetMap contributors · Powered by Geoapify",
    anchor: overlap,
    suggestedGhost: null,
  },
];

export const ghostReady: GhostSessionsGetResponse = {
  availability: "ready",
  sport: "running",
  gpsCoverage: "partial",
  historyCoverage: "partial",
  nameStatus: "disabled",
  sections: [ghostFullSection],
};

export const ghostNamesReady: GhostSessionsGetResponse = {
  ...ghostReady,
  nameStatus: "ready",
  mapCoverage: "partial",
  sections: [ghostFullSection, ...ghostNamedSections],
};

export const ghostFirstVisit: GhostSessionsGetResponse = {
  ...ghostReady,
  historyCoverage: "complete",
  sections: [{ ...ghostFullSection, firstVisit: true, suggestedGhost: null }],
};

const recentCandidate = recordedInterval(-86_400_000, 320_000, 37.781);
const olderCandidate = recordedInterval(-172_800_000, 290_000, 37.782);
export const ghostFirstPage: GhostSessionsPassesResponse = {
  passes: [
    {
      passId: "recent-pass",
      activityId: recentGhostActivityId,
      elapsedMs: recentCandidate.elapsedMs,
      startedAt: new Date(recentCandidate.start.timestampMs).toISOString(),
    },
  ],
  nextCursor: "second-page",
};
export const ghostSecondPage: GhostSessionsPassesResponse = {
  passes: [
    {
      passId: "older-pass",
      activityId: olderGhostActivityId,
      elapsedMs: olderCandidate.elapsedMs,
      startedAt: new Date(olderCandidate.start.timestampMs).toISOString(),
    },
  ],
  nextCursor: null,
};

export function ghostComparison(passId: string): GhostSessionsCompareResponse {
  const candidate = passId === "older-pass" ? olderCandidate : recentCandidate;
  return {
    anchor: overlap,
    candidate,
    elapsedDifferenceMs: overlap.elapsedMs - candidate.elapsedMs,
    timeBasis: "elapsed-including-recorded-stops",
    replay: [
      { anchor: overlap.start, candidate: candidate.start },
      { anchor: overlap.end, candidate: candidate.end },
    ],
    replayDownsampled: false,
    metrics: {
      paceSecondsPerKm: { anchor: 240, candidate: 260 },
      heartRateBpm: null,
      powerWatts: null,
    },
  };
}
