import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

const repositoryResultMock = vi.hoisted(() => vi.fn());
const repositoryInputMock = vi.hoisted(() => vi.fn());
const cachedQueryOptions = vi.hoisted(() => vi.fn());
const calendarConstructorMock = vi.hoisted(() => vi.fn());
const searchIndexMock = vi.hoisted(() => vi.fn());
const titleSearchMock = vi.hoisted(() => vi.fn());
const searchHydrationMock = vi.hoisted(() => vi.fn());
const captureSearchErrorMock = vi.hoisted(() => vi.fn());

vi.mock("dofek/activity-search/config", () => ({
  createActivitySearchIndexFromEnv: searchIndexMock,
}));
vi.mock("dofek/lib/error-reporting", async (importOriginal) => ({
  ...(await importOriginal<typeof import("dofek/lib/error-reporting")>()),
  captureException: captureSearchErrorMock,
}));
vi.mock("../repositories/activity-title-search.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../repositories/activity-title-search.ts")>()),
  searchActivityTitles: titleSearchMock,
}));

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
    constructor(...args: unknown[]) {
      calendarConstructorMock(...args);
    }
    findByIds(ids: string[], activityType?: string) {
      return searchHydrationMock(ids, activityType);
    }
    getWeekList(input: unknown) {
      repositoryInputMock(input);
      return repositoryResultMock();
    }
    async getPage(input: { page: number; pageSize: number }) {
      repositoryInputMock(input);
      const days = await repositoryResultMock();
      return {
        days,
        totalCount: days.flatMap((day: { activities: unknown[] }) => day.activities).length,
        page: input.page,
        pageSize: input.pageSize,
      };
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
    calendarConstructorMock.mockReset();
    searchIndexMock.mockReset();
    titleSearchMock.mockReset();
    searchHydrationMock.mockReset();
    captureSearchErrorMock.mockReset();
  });

  describe("searchActivities", () => {
    const context = {
      db: {},
      userId: "user-1",
      timezone: "America/Los_Angeles",
      sensorStore: { query: vi.fn() },
      accessWindow: { kind: "limited", startDate: "2026-11-11", endDateExclusive: "2026-11-18" },
    };

    it("passes the current user, entitlement and normalized search to the index and card lookup", async () => {
      const index = { name: "reader" };
      const ids = ["candidate-1", "candidate-2"];
      searchIndexMock.mockReturnValue(index);
      searchHydrationMock.mockResolvedValue([]);
      titleSearchMock.mockImplementation(async (_index, hydrate) => ({
        activities: await hydrate(ids),
        next: null,
      }));
      await expect(
        createCaller(context).searchActivities({
          title: "  golden hill  ",
          activityType: "cycling",
          cursor: null,
        }),
      ).resolves.toEqual({ activities: [], next: null });
      expect(searchIndexMock).toHaveBeenCalledWith("ACTIVITY_SEARCH_READ_URL");
      expect(calendarConstructorMock).toHaveBeenCalledWith(
        context.db,
        context.userId,
        context.timezone,
        context.sensorStore,
        context.accessWindow,
      );
      expect(titleSearchMock).toHaveBeenCalledWith(index, expect.any(Function), {
        title: "golden hill",
        activityType: "cycling",
        pageSize: 20,
        cursor: undefined,
        userId: context.userId,
        timezone: context.timezone,
        accessWindow: context.accessWindow,
      });
      expect(searchHydrationMock).toHaveBeenCalledWith(ids, "cycling");
    });

    it("reports disabled search before constructing the calendar repository", async () => {
      await expect(createCaller(context).searchActivities({ title: "hill" })).rejects.toMatchObject(
        {
          code: "PRECONDITION_FAILED",
          message: "Activity search is unavailable in this environment.",
        },
      );
      expect(titleSearchMock).not.toHaveBeenCalled();
      expect(calendarConstructorMock).not.toHaveBeenCalled();
      expect(captureSearchErrorMock).not.toHaveBeenCalled();
    });

    it("preserves client-safe errors and sanitizes unexpected failures", async () => {
      const caller = createCaller(context);
      searchIndexMock.mockReturnValue({});
      const known = new TRPCError({ code: "BAD_REQUEST", message: "Start a new search." });
      const unexpected = new Error("internal search provider error");
      titleSearchMock.mockRejectedValueOnce(known).mockRejectedValueOnce(unexpected);
      await expect(caller.searchActivities({ title: "hill" })).rejects.toBe(known);
      expect(captureSearchErrorMock).not.toHaveBeenCalled();
      await expect(caller.searchActivities({ title: "hill" })).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        message: "Activity search is temporarily unavailable. Try again in a minute.",
      });
      expect(captureSearchErrorMock).toHaveBeenCalledWith(unexpected, {
        tags: { trpcPath: "calendar.searchActivities" },
      });
    });

    it.each([
      { title: "   " },
      { title: "a".repeat(201) },
      { title: "hill", activityType: "" },
      { title: "hill", pageSize: 0 },
      { title: "hill", pageSize: 51 },
      { title: "hill", pageSize: 1.5 },
    ])("rejects invalid search inputs before calling the index", async (input) => {
      await expect(createCaller(context).searchActivities(input)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      expect(searchIndexMock).not.toHaveBeenCalled();
    });
  });

  it("keeps the released unpaged API and returns a page envelope from V2", async () => {
    const caller = createCaller({
      db: {},
      userId: "user-1",
      timezone: "UTC",
      sensorStore: { query: vi.fn() },
    });
    repositoryResultMock.mockResolvedValueOnce([]);
    await expect(caller.weekList({ weeks: 4, endDate: "2026-03-20" })).resolves.toEqual([]);
    repositoryResultMock.mockResolvedValueOnce([]);
    await expect(
      caller.weekListV2({ weeks: 4, endDate: "2026-03-20", page: 2, pageSize: 10 }),
    ).resolves.toEqual({ days: [], totalCount: 0, page: 2, pageSize: 10 });
    expect(repositoryInputMock).toHaveBeenLastCalledWith({
      weeks: 4,
      endDate: "2026-03-20",
      includeProviderAbsent: false,
      page: 2,
      pageSize: 10,
    });
  });

  it.each([{ page: -1 }, { page: 0.5 }, { pageSize: 0 }, { pageSize: 101 }])(
    "rejects invalid pagination %j",
    async (pagination) => {
      const caller = createCaller({
        db: {},
        userId: "user-1",
        timezone: "UTC",
        sensorStore: { query: vi.fn() },
      });
      await expect(
        caller.weekListV2({ weeks: 4, endDate: "2026-03-20", ...pagination }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(repositoryInputMock).not.toHaveBeenCalled();
    },
  );

  it("versions the activity state cache contract", () => {
    expect(cachedQueryOptions).toHaveBeenCalledWith({
      maxAge: 600_000,
      keyVersion: "activity-calendar-page-power-stress-v3",
    });
    expect(cachedQueryOptions).toHaveBeenCalledWith({
      maxAge: 600_000,
      keyVersion: "activity-calendar-primary-type-v4",
    });
    expect(cachedQueryOptions).toHaveBeenCalledWith({
      maxAge: 3_600_000,
      keyVersion: "calendar-calendarData-v2",
    });
    expect(cachedQueryOptions).toHaveBeenCalledTimes(4);
  });

  it.each(["weekList", "weekListV2"] as const)(
    "surfaces missing ClickHouse analytics store for %s as a precondition error",
    async (procedure) => {
      const caller = createCaller({ db: {}, userId: "user-1", timezone: "UTC" });

      await expect(caller[procedure]({ weeks: 4, endDate: "2026-03-20" })).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message:
          "Activity calendar requires the ClickHouse activity analytics store. Set CLICKHOUSE_URL and retry.",
      });
    },
  );

  it("validates weekList output at the API boundary", async () => {
    repositoryResultMock.mockResolvedValueOnce([{ date: "2026-03-18", activities: [{ id: 123 }] }]);
    const caller = createCaller({
      db: {},
      userId: "user-1",
      timezone: "UTC",
      sensorStore: { query: vi.fn() },
    });

    await expect(caller.weekListV2({ weeks: 4, endDate: "2026-03-20" })).rejects.toBeInstanceOf(
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

      await expect(
        caller.weekListV2({ weeks: 4, endDate: "2026-03-20" }).then((result) => result.days),
      ).resolves.toEqual([
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

    await expect(
      caller.weekListV2({ weeks: 4, endDate: "2026-03-20" }).then((result) => result.days),
    ).resolves.toEqual([
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

    await expect(
      caller.weekListV2({ weeks: 4, endDate: "2026-03-20" }).then((result) => result.days),
    ).resolves.toEqual([
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

    await caller.weekListV2({ weeks: 8, endDate: "2026-03-20", activityType: "running" });

    expect(repositoryInputMock).toHaveBeenCalledWith({
      weeks: 8,
      endDate: "2026-03-20",
      activityType: "running",
      includeProviderAbsent: false,
      page: 0,
      pageSize: 20,
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
