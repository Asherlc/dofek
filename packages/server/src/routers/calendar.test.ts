import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

const repositoryResultMock = vi.hoisted(() => vi.fn());
const repositoryInputMock = vi.hoisted(() => vi.fn());
const cachedQueryOptions = vi.hoisted(() => vi.fn());

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      userId: string | null;
      timezone: string;
      sensorStore?: unknown;
      accessWindow?: unknown;
    }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: (options: unknown) => {
      cachedQueryOptions(options);
      return trpc.procedure;
    },
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

vi.mock("../repositories/activities-calendar-repository.ts", () => ({
  ActivitiesCalendarRepository: class {
    getWeekList(input: unknown) {
      repositoryInputMock(input);
      return repositoryResultMock();
    }
  },
}));

vi.mock("../repositories/activity-overview-repository.ts", () => ({
  ActivityOverviewRepository: class {
    getActivityOverview(input: unknown) {
      repositoryInputMock(input);
      return repositoryResultMock();
    }
  },
}));

import { calendarRouter } from "./calendar.ts";

const createCaller = createTestCallerFactory(calendarRouter);

describe("calendarRouter", () => {
  beforeEach(() => {
    repositoryResultMock.mockReset();
    repositoryInputMock.mockReset();
  });

  it("versions the activity state cache contract", () => {
    expect(cachedQueryOptions).toHaveBeenCalledWith({
      maxAge: 600_000,
      keyVersion: "activity-calendar-maplibre-v9",
    });
    expect(cachedQueryOptions).toHaveBeenCalledWith({
      maxAge: 600_000,
      keyVersion: "activity-calendar-states-v2",
    });
    expect(cachedQueryOptions).toHaveBeenCalledWith({
      maxAge: 3_600_000,
      keyVersion: "calendar-calendarData-v2",
    });
    expect(cachedQueryOptions).toHaveBeenCalledTimes(3);
  });

  it("surfaces missing ClickHouse analytics store as a precondition error", async () => {
    const caller = createCaller({ db: {}, userId: "user-1", timezone: "UTC" });

    await expect(caller.weekList({ weeks: 4, endDate: "2026-03-20" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message:
        "Activity calendar requires the ClickHouse activity analytics store. Set CLICKHOUSE_URL and retry.",
    });
  });

  it("validates weekList output at the API boundary", async () => {
    repositoryResultMock.mockResolvedValueOnce([{ date: "2026-03-18", activities: [{ id: 123 }] }]);
    const caller = createCaller({
      db: {},
      userId: "user-1",
      timezone: "UTC",
      sensorStore: { query: vi.fn() },
    });

    await expect(caller.weekList({ weeks: 4, endDate: "2026-03-20" })).rejects.toBeInstanceOf(
      TRPCError,
    );
  });

  it.each(["indoor", "virtual", "road", null])(
    "preserves cycling modality %s and normalizes weekList dates at the API boundary",
    async (modality) => {
      repositoryResultMock.mockResolvedValueOnce([
        {
          date: new Date("2026-03-18T12:00:00.000Z"),
          activities: [
            {
              id: "activity-1",
              name: "Trainer Ride",
              activityType: "cycling",
              primaryActivityType: "running",
              modality,
              startedAt: new Date("2026-03-18T07:00:00.000Z"),
              endedAt: "2026-03-18 08:00:00+00",
              localTimeContext: {
                timezone: null,
                startUtcOffsetMinutes: null,
                endUtcOffsetMinutes: null,
                source: "unknown",
              },
              durationMin: 60,
              source: {
                origin: { status: "unresolved", candidateMemberActivityIds: [] },
                primarySourceLabel: null,
                sourceCount: 2,
                overlapSummary: "2 matched source records",
                tree: { primary: null, otherSources: [] },
              },
              lastProcessedAt: "2026-03-18 08:07:00+00",
              distanceMeters: 0,
              distanceState: { status: "available" },
              elevationGainM: 0,
              elevationState: { status: "available" },
              location: null,
              tss: null,
              stats: [
                {
                  status: "missing",
                  label: "Training Stress Score",
                  reason:
                    "Record average power and set functional threshold power, or record average heart rate and set maximum heart rate.",
                },
              ],
            },
          ],
        },
      ]);
      const caller = createCaller({
        db: {},
        userId: "user-1",
        timezone: "UTC",
        sensorStore: { query: vi.fn() },
      });

      await expect(caller.weekList({ weeks: 4, endDate: "2026-03-20" })).resolves.toEqual([
        {
          date: "2026-03-18",
          activities: [
            expect.objectContaining({
              activityType: "cycling",
              primaryActivityType: "running",
              modality,
              startedAt: "2026-03-18T07:00:00.000Z",
              endedAt: "2026-03-18T08:00:00.000Z",
              source: {
                origin: { status: "unresolved", candidateMemberActivityIds: [] },
                primarySourceLabel: null,
                sourceCount: 2,
                overlapSummary: "2 matched source records",
                tree: { primary: null, otherSources: [] },
              },
              lastProcessedAt: "2026-03-18T08:07:00.000Z",
            }),
          ],
        },
      ]);
    },
  );

  it("accepts a server-authored unavailable activity stat at the API boundary", async () => {
    repositoryResultMock.mockResolvedValueOnce([
      {
        date: "2026-03-18",
        activities: [
          {
            id: "activity-1",
            name: "Trainer Ride",
            activityType: "indoor_cycling",
            primaryActivityType: null,
            modality: "indoor",
            startedAt: "2026-03-18T07:00:00.000Z",
            endedAt: "2026-03-18T08:00:00.000Z",
            localTimeContext: {
              timezone: null,
              startUtcOffsetMinutes: null,
              endUtcOffsetMinutes: null,
              source: "unknown",
            },
            durationMin: 60,
            source: {
              origin: { status: "unresolved", candidateMemberActivityIds: [] },
              primarySourceLabel: null,
              sourceCount: 1,
              overlapSummary: null,
              tree: { primary: null, otherSources: [] },
            },
            lastProcessedAt: "2026-03-18T08:07:00.000Z",
            distanceMeters: null,
            distanceState: { status: "missing", reason: "Distance not recorded" },
            elevationGainM: null,
            elevationState: { status: "missing", reason: "Elevation gain not recorded" },
            location: null,
            tss: null,
            stats: [
              {
                status: "missing",
                label: "Training Stress Score",
                reason:
                  "Record average power, or record average heart rate and set maximum heart rate.",
              },
            ],
          },
        ],
      },
    ]);
    const caller = createCaller({
      db: {},
      userId: "user-1",
      timezone: "UTC",
      sensorStore: { query: vi.fn() },
    });

    await expect(caller.weekList({ weeks: 4, endDate: "2026-03-20" })).resolves.toEqual([
      {
        date: "2026-03-18",
        activities: [
          expect.objectContaining({
            stats: [
              {
                status: "missing",
                label: "Training Stress Score",
                reason:
                  "Record average power, or record average heart rate and set maximum heart rate.",
              },
            ],
          }),
        ],
      },
    ]);
  });

  it("preserves exported map previews on activity location at the API boundary", async () => {
    repositoryResultMock.mockResolvedValueOnce([
      {
        date: "2026-03-18",
        activities: [
          {
            id: "activity-1",
            name: "Morning Run",
            activityType: "running",
            primaryActivityType: null,
            modality: null,
            startedAt: "2026-03-18T07:00:00.000Z",
            endedAt: "2026-03-18T08:00:00.000Z",
            localTimeContext: {
              timezone: null,
              startUtcOffsetMinutes: null,
              endUtcOffsetMinutes: null,
              source: "unknown",
            },
            durationMin: 60,
            source: {
              origin: { status: "unresolved", candidateMemberActivityIds: [] },
              primarySourceLabel: null,
              sourceCount: 1,
              overlapSummary: null,
              tree: { primary: null, otherSources: [] },
            },
            lastProcessedAt: "2026-03-18T08:07:00.000Z",
            distanceMeters: 5000,
            distanceState: { status: "available" },
            elevationGainM: 120,
            elevationState: { status: "available" },
            location: {
              kind: "recorded_gps",
              centroidLat: 37.7749,
              centroidLng: -122.4194,
              mapPreview: {
                width: 1024,
                height: 576,
                center: [-122.40966797, 37.77505678],
                zoom: 14,
                routePath: [
                  { x: 400, y: 250 },
                  { x: 480, y: 220 },
                ],
              },
            },
            tss: null,
            stats: [
              {
                status: "missing",
                label: "Training Stress Score",
                reason:
                  "Record average power and set functional threshold power, or record average heart rate and set maximum heart rate.",
              },
            ],
          },
        ],
      },
    ]);
    const caller = createCaller({
      db: {},
      userId: "user-1",
      timezone: "UTC",
      sensorStore: { query: vi.fn() },
    });

    await expect(caller.weekList({ weeks: 4, endDate: "2026-03-20" })).resolves.toEqual([
      {
        date: "2026-03-18",
        activities: [
          expect.objectContaining({
            location: {
              kind: "recorded_gps",
              centroidLat: 37.7749,
              centroidLng: -122.4194,
              mapPreview: {
                width: 1024,
                height: 576,
                center: [-122.40966797, 37.77505678],
                zoom: 14,
                routePath: [
                  { x: 400, y: 250 },
                  { x: 480, y: 220 },
                ],
              },
            },
          }),
        ],
      },
    ]);
  });

  it("passes the selected activity type through to weekList", async () => {
    repositoryResultMock.mockResolvedValueOnce([]);
    const caller = createCaller({
      db: {},
      userId: "user-1",
      timezone: "UTC",
      sensorStore: { query: vi.fn() },
    });

    await caller.weekList({ weeks: 8, endDate: "2026-03-20", activityType: "running" });

    expect(repositoryInputMock).toHaveBeenCalledWith({
      weeks: 8,
      endDate: "2026-03-20",
      activityType: "running",
      includeProviderAbsent: false,
    });
  });

  it("returns server-computed activity overview totals", async () => {
    repositoryResultMock.mockResolvedValueOnce({
      activityCount: 2,
      totalMinutes: 150,
      totalDistanceMeters: null,
      totalDistanceState: { status: "missing", reason: "Distance not recorded" },
      totalElevationGainM: null,
      totalElevationState: { status: "missing", reason: "Elevation gain not recorded" },
      activityTypes: ["cycling", "running"],
      comparison: {
        periodLabel: "previous 4 weeks",
        activityCount: { magnitude: 2, trend: "higher" },
        totalMinutes: { magnitude: 150, trend: "higher" },
        totalDistanceMeters: {
          magnitude: null,
          trend: "unavailable",
          state: { status: "missing", reason: "Distance not recorded" },
        },
        totalElevationGainM: {
          magnitude: null,
          trend: "unavailable",
          state: { status: "missing", reason: "Elevation gain not recorded" },
        },
      },
    });
    const caller = createCaller({
      db: {},
      userId: "user-1",
      timezone: "UTC",
      sensorStore: { query: vi.fn() },
    });

    await expect(caller.activityOverview({ weeks: 4, endDate: "2026-03-20" })).resolves.toEqual({
      activityCount: 2,
      totalMinutes: 150,
      totalDistanceMeters: null,
      totalDistanceState: { status: "missing", reason: "Distance not recorded" },
      totalElevationGainM: null,
      totalElevationState: { status: "missing", reason: "Elevation gain not recorded" },
      activityTypes: ["cycling", "running"],
      comparison: {
        periodLabel: "previous 4 weeks",
        activityCount: { magnitude: 2, trend: "higher" },
        totalMinutes: { magnitude: 150, trend: "higher" },
        totalDistanceMeters: {
          magnitude: null,
          trend: "unavailable",
          state: { status: "missing", reason: "Distance not recorded" },
        },
        totalElevationGainM: {
          magnitude: null,
          trend: "unavailable",
          state: { status: "missing", reason: "Elevation gain not recorded" },
        },
      },
    });
  });

  it("passes the selected activity type through to activityOverview", async () => {
    repositoryResultMock.mockResolvedValueOnce({
      activityCount: 1,
      totalMinutes: 60,
      totalDistanceMeters: 5000,
      totalDistanceState: { status: "available" },
      totalElevationGainM: 120,
      totalElevationState: { status: "available" },
      activityTypes: ["cycling", "running"],
      comparison: {
        periodLabel: "previous 4 weeks",
        activityCount: { magnitude: 1, trend: "higher" },
        totalMinutes: { magnitude: 60, trend: "higher" },
        totalDistanceMeters: {
          magnitude: 5000,
          trend: "higher",
          state: { status: "available" },
        },
        totalElevationGainM: {
          magnitude: 120,
          trend: "higher",
          state: { status: "available" },
        },
      },
    });
    const caller = createCaller({
      db: {},
      userId: "user-1",
      timezone: "UTC",
      sensorStore: { query: vi.fn() },
    });

    await caller.activityOverview({ weeks: 4, endDate: "2026-03-20", activityType: "running" });

    expect(repositoryInputMock).toHaveBeenCalledWith({
      weeks: 4,
      endDate: "2026-03-20",
      activityType: "running",
      includeProviderAbsent: false,
    });
  });
});
