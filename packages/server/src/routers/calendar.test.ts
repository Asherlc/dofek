import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

const repositoryResultMock = vi.hoisted(() => vi.fn());
const repositoryInputMock = vi.hoisted(() => vi.fn());

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
    cachedProtectedQuery: () => trpc.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

vi.mock("../repositories/activities-calendar-repository.ts", () => ({
  ActivitiesCalendarRepository: class {
    getWeekList(input: unknown) {
      repositoryInputMock(input);
      return repositoryResultMock();
    }

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

  it("normalizes weekList output date and timestamp fields at the API boundary", async () => {
    repositoryResultMock.mockResolvedValueOnce([
      {
        date: new Date("2026-03-18T12:00:00.000Z"),
        activities: [
          {
            id: "activity-1",
            name: "Trainer Ride",
            activityType: "indoor_cycling",
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
              primarySourceLabel: "Wahoo",
              sourceCount: 2,
              overlapSummary: "2 matched source records · Wahoo selected by source priority",
            },
            lastProcessedAt: "2026-03-18 08:07:00+00",
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
            startedAt: "2026-03-18T07:00:00.000Z",
            endedAt: "2026-03-18T08:00:00.000Z",
            source: {
              primarySourceLabel: "Wahoo",
              sourceCount: 2,
              overlapSummary: "2 matched source records · Wahoo selected by source priority",
            },
            lastProcessedAt: "2026-03-18T08:07:00.000Z",
          }),
        ],
      },
    ]);
  });

  it("accepts a server-authored unavailable activity stat at the API boundary", async () => {
    repositoryResultMock.mockResolvedValueOnce([
      {
        date: "2026-03-18",
        activities: [
          {
            id: "activity-1",
            name: "Trainer Ride",
            activityType: "indoor_cycling",
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
              primarySourceLabel: "Wahoo",
              sourceCount: 1,
              overlapSummary: null,
            },
            lastProcessedAt: "2026-03-18T08:07:00.000Z",
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
              primarySourceLabel: "Wahoo",
              sourceCount: 1,
              overlapSummary: null,
            },
            lastProcessedAt: "2026-03-18T08:07:00.000Z",
            location: {
              centroidLat: 37.7749,
              centroidLng: -122.4194,
              mapPreview: {
                width: 1024,
                height: 576,
                tiles: [
                  {
                    url: "https://tile.openstreetmap.org/15/5241/12665.png",
                    x: 256,
                    y: 160,
                    width: 256,
                    height: 256,
                  },
                ],
                routePath: [
                  { x: 400, y: 250 },
                  { x: 480, y: 220 },
                ],
              },
              distanceMeters: 5000,
              distanceState: { status: "available" },
              elevationGainM: 120,
              elevationState: { status: "available" },
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
              centroidLat: 37.7749,
              centroidLng: -122.4194,
              mapPreview: {
                width: 1024,
                height: 576,
                tiles: [
                  {
                    url: "https://tile.openstreetmap.org/15/5241/12665.png",
                    x: 256,
                    y: 160,
                    width: 256,
                    height: 256,
                  },
                ],
                routePath: [
                  { x: 400, y: 250 },
                  { x: 480, y: 220 },
                ],
              },
              distanceMeters: 5000,
              distanceState: { status: "available" },
              elevationGainM: 120,
              elevationState: { status: "available" },
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
      totalElevationState: { status: "missing", reason: "Elevation not recorded" },
      activityTypes: ["cycling", "running"],
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
      totalElevationState: { status: "missing", reason: "Elevation not recorded" },
      activityTypes: ["cycling", "running"],
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
