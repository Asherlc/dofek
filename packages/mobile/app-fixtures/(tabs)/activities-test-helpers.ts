import type { ActivityLocation } from "dofek-server/types";

export interface MockQuery {
  data: unknown[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
}

export interface WeekListQueryOptions {
  placeholderData?: (previousData: unknown) => unknown;
  refetchInterval?: (query: { state: { data: unknown } }) => number | false;
}

export interface MockOverviewQuery {
  data:
    | {
        activityCount: number;
        totalMinutes: number;
        totalDistanceMeters: number | null;
        totalDistanceState: { status: "available" } | { status: "missing"; reason: string };
        totalElevationGainM: number | null;
        totalElevationState: { status: "available" } | { status: "missing"; reason: string };
        activityTypes: string[];
        comparison?: {
          periodLabel: string;
          activityCount: { magnitude: number; trend: "higher" | "lower" | "unchanged" };
          totalMinutes: { magnitude: number; trend: "higher" | "lower" | "unchanged" };
          totalDistanceMeters: {
            magnitude: number | null;
            trend: "higher" | "lower" | "unchanged" | "unavailable";
            state: { status: "available" } | { status: "missing"; reason: string };
          };
          totalElevationGainM: {
            magnitude: number | null;
            trend: "higher" | "lower" | "unchanged" | "unavailable";
            state: { status: "available" } | { status: "missing"; reason: string };
          };
        };
      }
    | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
}

export function activity(overrides: Record<string, unknown> = {}) {
  return {
    id: "activity-1",
    name: "Trainer Ride",
    activityType: "indoor_cycling",
    primaryActivityType: null,
    modality: null,
    startedAt: "2026-03-18T07:00:00.000Z",
    endedAt: "2026-03-18T08:00:00.000Z",
    localTimeContext: {
      timezone: null,
      startUtcOffsetMinutes: 60,
      endUtcOffsetMinutes: 60,
      source: "provider_offset",
    },
    durationMin: 60,
    source: {
      tree: { primary: null, otherSources: [] },
      origin: { status: "unresolved", candidateMemberActivityIds: [] },
      primarySourceLabel: "Wahoo",
      sourceCount: 1,
      overlapSummary: null,
    },
    lastProcessedAt: "2026-03-18T08:05:00.000Z",
    distanceMeters: null,
    distanceState: { status: "missing", reason: "Distance not recorded" },
    elevationGainM: null,
    elevationState: { status: "missing", reason: "Elevation not recorded" },
    location: null,
    tss: 100,
    stats: [{ status: "available", label: "Training Stress Score", value: "100" }],
    ...overrides,
  };
}

export function emptyActivityOverviewQuery(): MockOverviewQuery {
  return {
    data: {
      activityCount: 0,
      totalMinutes: 0,
      totalDistanceMeters: 0,
      totalDistanceState: { status: "available" },
      totalElevationGainM: 0,
      totalElevationState: { status: "available" },
      activityTypes: [],
    },
    isLoading: false,
    isError: false,
    error: null,
  };
}

export function activityListQuery(activities: ReturnType<typeof activity>[]): MockQuery {
  return {
    data: [{ date: "2026-03-18", activities }],
    isLoading: false,
    isError: false,
    error: null,
  };
}

type RecordedGpsLocation = Extract<ActivityLocation, { kind: "recorded_gps" }>;

export const routeMapTiles = [
  {
    url: "https://tile.openstreetmap.org/15/5241/12665.png",
    x: 0,
    y: 0,
    width: 256,
    height: 256,
  },
  {
    url: "https://tile.openstreetmap.org/15/5242/12665.png",
    x: 256,
    y: 0,
    width: 256,
    height: 256,
  },
];

export function recordedGpsLocation(
  mapPreview: Partial<RecordedGpsLocation["mapPreview"]> = {},
): RecordedGpsLocation {
  return {
    kind: "recorded_gps",
    centroidLat: 37.7749,
    centroidLng: -122.4194,
    mapPreview: {
      width: 1024,
      height: 576,
      tiles: routeMapTiles.slice(0, 1),
      routePath: null,
      ...mapPreview,
    },
  };
}

export function climbingSourceLocation(pointCount: number): ActivityLocation {
  return {
    kind: "climbing_source",
    mapPreview: {
      width: 1024,
      height: 576,
      tiles: [
        {
          url: "https://tile.openstreetmap.org/15/6800/12400.png",
          x: 0,
          y: 0,
          width: 256,
          height: 256,
        },
      ],
      routePath: null,
    },
    sourcePoints: (
      [
        {
          x: 512,
          y: 288,
          location: {
            coordinates: { latitude: 40.015, longitude: -105.29 },
            scope: "area",
            objectId: "source-area-1",
            providerId: "mountain-project",
            name: "Boulder Canyon",
          },
        },
        {
          x: 700,
          y: 200,
          location: {
            coordinates: { latitude: 40.016, longitude: -105.288 },
            scope: "climb",
            objectId: "source-climb-2",
            providerId: "openbeta",
            name: "Second climb",
          },
        },
      ] satisfies Extract<ActivityLocation, { kind: "climbing_source" }>["sourcePoints"]
    ).slice(0, pointCount),
  };
}
