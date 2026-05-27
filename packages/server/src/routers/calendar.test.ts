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
            durationMin: 60,
            location: null,
            calories: null,
            tss: null,
            stats: [
              { label: "Training Stress Score", value: "—" },
              { label: "Calories", value: "—" },
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
    });
  });

  it("returns server-computed activity overview totals", async () => {
    repositoryResultMock.mockResolvedValueOnce([
      {
        date: "2026-03-18",
        activities: [
          {
            id: "activity-1",
            name: "Run",
            activityType: "running",
            startedAt: "2026-03-18T07:00:00.000Z",
            endedAt: "2026-03-18T08:00:00.000Z",
            durationMin: 60,
            location: {
              centroidLat: 37.7749,
              centroidLng: -122.4194,
              tileUrl: "https://tile.openstreetmap.org/13/1310/3166.png",
              distanceMeters: 5000,
              elevationGainM: 120,
            },
            calories: 420,
            tss: 50,
            stats: [
              { label: "Training Stress Score", value: "50" },
              { label: "Calories", value: "420 kcal" },
            ],
          },
          {
            id: "activity-2",
            name: "Ride",
            activityType: "cycling",
            startedAt: "2026-03-17T07:00:00.000Z",
            endedAt: "2026-03-17T08:30:00.000Z",
            durationMin: 90,
            location: {
              centroidLat: 37.7749,
              centroidLng: -122.4194,
              tileUrl: "https://tile.openstreetmap.org/13/1310/3166.png",
              distanceMeters: 25000,
              elevationGainM: 300,
            },
            calories: 800,
            tss: 70,
            stats: [
              { label: "Training Stress Score", value: "70" },
              { label: "Calories", value: "800 kcal" },
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

    await expect(caller.activityOverview({ weeks: 4, endDate: "2026-03-20" })).resolves.toEqual({
      activityCount: 2,
      totalMinutes: 150,
      totalDistanceMeters: 30000,
      totalElevationGainM: 420,
      activityTypes: ["cycling", "running"],
    });
  });
});
