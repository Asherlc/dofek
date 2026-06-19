import type { Database } from "dofek/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { osmTilePreview, osmTileUrl } from "../lib/osm-tile.ts";
import { ActivitySourceAttribution } from "../models/activity-source-attribution.ts";
import type { CalendarActivityEntry } from "./activities-calendar-repository.ts";
import { ActivitiesCalendarRepository, mergeDayGroups } from "./activities-calendar-repository.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";

function makeDatabase(rows: Record<string, unknown>[] = []) {
  return {
    execute: vi.fn().mockResolvedValue(rows),
  } satisfies Pick<Database, "execute">;
}

function makeSensorStore(rowSets: Record<string, unknown>[][]): ActivitySensorStore {
  const query = vi.fn();
  for (const rows of rowSets) {
    query.mockImplementationOnce((schema: { parse: (row: Record<string, unknown>) => unknown }) =>
      Promise.resolve(rows.map((row) => schema.parse(row))),
    );
  }
  query.mockImplementation(() => {
    throw new Error("Unexpected sensor query");
  });
  return {
    query,
    getActivitySummaries: vi.fn().mockResolvedValue([]),
    getStream: vi.fn().mockResolvedValue([]),
    getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerCurveSamples: vi.fn().mockResolvedValue([]),
    getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
    getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
    getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
    getPaceCurveRows: vi.fn().mockResolvedValue([]),
  };
}

function makeActivityRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "activity-1",
    name: "Trainer Ride",
    activity_type: "indoor_cycling",
    started_at: "2026-03-18T07:00:00.000Z",
    ended_at: "2026-03-18T08:00:00.000Z",
    duration_min: 60,
    avg_hr: null,
    max_hr: null,
    avg_power: 250,
    total_distance: null,
    elevation_gain_m: null,
    centroid_lat: null,
    centroid_lng: null,
    local_date: new Date("2026-03-18T00:00:00.000Z"),
    ...overrides,
  };
}

function normalizeSql(queryText: string | undefined): string {
  return queryText?.replace(/\s+/g, " ").trim() ?? "";
}

function expectDedupedActivitiesWithSummaryMetrics(queryText: string | undefined): void {
  const normalizedQueryText = normalizeSql(queryText);
  expect(normalizedQueryText).toContain("FROM analytics.deduped_activities AS activity FINAL");
  expect(normalizedQueryText).toContain("LEFT JOIN analytics.activity_summary asum");
  expect(normalizedQueryText).not.toContain("analytics.v_activity");
}

function expectDedupedActivitiesOnly(queryText: string | undefined): void {
  const normalizedQueryText = normalizeSql(queryText);
  expect(normalizedQueryText).toContain("FROM analytics.deduped_activities AS activity FINAL");
  expect(normalizedQueryText).not.toContain("analytics.v_activity");
}

function expectDedupedActivitiesDriveActivityListIdentity(queryText: string | undefined): void {
  const normalizedQueryText = normalizeSql(queryText);
  expect(normalizedQueryText).toContain("FROM analytics.deduped_activities AS activity FINAL");
  expect(normalizedQueryText).toContain("LEFT JOIN analytics.activity_summary asum");
  expect(normalizedQueryText).toContain("toString(activity.activity_id) AS id");
  expect(normalizedQueryText).toContain("activity.name AS name");
  expect(normalizedQueryText).toContain("activity.activity_type AS activity_type");
  expect(normalizedQueryText).toContain("toString(activity.started_at) AS started_at");
  expect(normalizedQueryText).toContain("toString(activity.ended_at) AS ended_at");
}

function makeCalendarEntry(
  overrides: Partial<CalendarActivityEntry> & Pick<CalendarActivityEntry, "id" | "startedAt">,
): CalendarActivityEntry {
  return {
    name: overrides.name ?? overrides.id,
    activityType: overrides.activityType ?? "running",
    endedAt: overrides.endedAt ?? overrides.startedAt,
    durationMin: overrides.durationMin ?? 60,
    location: overrides.location ?? null,
    calories: overrides.calories ?? null,
    tss: overrides.tss ?? null,
    stats: overrides.stats ?? [],
    ...overrides,
  };
}

describe("ActivitiesCalendarRepository", () => {
  const dialect = new PgDialect();

  it("groups activities by normalized local date and returns display-ready indoor stats", async () => {
    const database = makeDatabase([{ id: "activity-1", calories: 421.6 }]);
    const sensorStore = makeSensorStore([
      [makeActivityRow({ avg_power: 251 })],
      [{ max_hr: null, resting_hr: null, ftp: 250 }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({ weeks: 4, endDate: "2026-03-20" });

    expect(result).toEqual([
      {
        date: "2026-03-18",
        activities: [
          expect.objectContaining({
            id: "activity-1",
            durationMin: 60,
            tss: 100.8,
            location: null,
            stats: [
              { label: "Training Stress Score", value: "100.8" },
              { label: "Calories", value: "422 kcal" },
            ],
          }),
        ],
      },
    ]);
  });

  it("adds a clamped location tile and preserves distance/elevation for outdoor activities", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [
        makeActivityRow({
          activity_type: "running",
          total_distance: 5000,
          elevation_gain_m: 125,
          centroid_lat: 90,
          centroid_lng: 180,
          avg_power: null,
          local_date: "2026-03-19",
        }),
      ],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({ weeks: 1, endDate: "2026-03-20" });

    expect(result[0]?.activities[0]?.location).toEqual({
      centroidLat: 90,
      centroidLng: 180,
      tileUrl: "https://tile.openstreetmap.org/13/0/0.png",
      routePath: null,
      distanceMeters: 5000,
      elevationGainM: 125,
    });
  });

  it("adds route preview path points for outdoor activities", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [
        makeActivityRow({
          id: "00000000-0000-0000-0000-000000000001",
          activity_type: "running",
          total_distance: 5000,
          elevation_gain_m: 125,
          centroid_lat: 37.7749,
          centroid_lng: -122.4194,
          avg_power: null,
        }),
      ],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [
        {
          activity_id: "00000000-0000-0000-0000-000000000001",
          lat: 37.7749,
          lng: -122.4194,
        },
        {
          activity_id: "00000000-0000-0000-0000-000000000001",
          lat: 37.7752,
          lng: -122.4188,
        },
        {
          activity_id: "00000000-0000-0000-0000-000000000001",
          lat: 37.7756,
          lng: -122.4182,
        },
      ],
    ]);
    const repository = new ActivitiesCalendarRepository(
      database,
      "00000000-0000-0000-0000-000000000001",
      "UTC",
      sensorStore,
    );

    const result = await repository.getWeekList({ weeks: 1, endDate: "2026-03-20" });

    expect(result[0]?.activities[0]?.location).toMatchObject({
      tileUrl: "https://tile.openstreetmap.org/13/1310/3166.png",
      routePath: [
        { x: 27.854, y: 37.951 },
        { x: 29.22, y: 37.088 },
        { x: 30.585, y: 35.936 },
      ],
    });
  });

  it("omits locations when only one centroid coordinate is present", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [
        makeActivityRow({
          id: "latitude-only",
          activity_type: "running",
          centroid_lat: 37.8,
          centroid_lng: null,
        }),
        makeActivityRow({
          id: "longitude-only",
          activity_type: "running",
          centroid_lat: null,
          centroid_lng: -122.4,
        }),
      ],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({ weeks: 1, endDate: "2026-03-20" });

    expect(result[0]?.activities).toEqual([
      expect.objectContaining({ id: "latitude-only", location: null }),
      expect.objectContaining({ id: "longitude-only", location: null }),
    ]);
  });

  it("filters activities by activity type before grouping days", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [
        makeActivityRow({
          id: "ride",
          activity_type: "indoor_cycling",
          local_date: "2026-03-18",
        }),
        makeActivityRow({
          id: "run",
          activity_type: "running",
          local_date: "2026-03-19",
          avg_power: null,
        }),
      ],
      [{ max_hr: null, resting_hr: null, ftp: 250 }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({
      weeks: 1,
      endDate: "2026-03-20",
      activityType: "running",
    });

    expect(result).toEqual([
      {
        date: "2026-03-19",
        activities: [expect.objectContaining({ id: "run", activityType: "running" })],
      },
    ]);
    expect(sensorStore.query).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.stringContaining("activity.activity_type = {activityType:String}"),
      expect.objectContaining({ activityType: "running" }),
    );
    const sqlObject = database.execute.mock.calls[0]?.[0];
    const compiledQuery = dialect.sqlToQuery(sqlObject);
    expect(compiledQuery.params).toContain("run");
    expect(compiledQuery.params).not.toContain("ride");
  });

  it("passes the requested user, timezone, activity ids, and date window to backing stores", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [
        makeActivityRow({ id: "activity-1", total_distance: 5000 }),
        makeActivityRow({ id: "activity-2", elevation_gain_m: 50 }),
      ],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(
      database,
      "00000000-0000-0000-0000-000000000001",
      "America/Los_Angeles",
      sensorStore,
    );

    await repository.getWeekList({ weeks: 2, endDate: "2026-03-20" });

    expect(sensorStore.query).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.stringContaining("FROM analytics.deduped_activities"),
      {
        userId: "00000000-0000-0000-0000-000000000001",
        timezone: "America/Los_Angeles",
        windowStart: "2026-03-06",
      },
    );
    expect(sensorStore.query).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.stringContaining("FROM postgres_fitness.user_profile_current"),
      { userId: "00000000-0000-0000-0000-000000000001" },
    );
    expect(sensorStore.query).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      expect.stringContaining("FROM analytics.activity_location_sample"),
      {
        activityIds: ["activity-1", "activity-2"],
        maxPoints: 24,
        userId: "00000000-0000-0000-0000-000000000001",
      },
    );
    expect(sensorStore.query).toHaveBeenCalledTimes(3);
  });

  it("lists only canonical deduped activity summary rows", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [makeActivityRow({ id: "canonical-activity" })],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    await repository.getWeekList({ weeks: 1, endDate: "2026-03-20" });

    const queryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
    expectDedupedActivitiesWithSummaryMetrics(queryText);
  });

  it("uses deduped activities as the activity page identity source", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [makeActivityRow({ id: "canonical-activity" })],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    await repository.getWeekList({ weeks: 1, endDate: "2026-03-20" });

    const queryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
    expectDedupedActivitiesDriveActivityListIdentity(queryText);
  });

  it("returns activity overview totals directly from ClickHouse", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [
        {
          activity_count: "2",
          total_minutes: "150.45",
          total_distance_meters: "30000.25",
          total_elevation_gain_m: "420.25",
        },
      ],
      [{ activity_type: "cycling" }, { activity_type: "running" }],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getActivityOverview({
      weeks: 4,
      endDate: "2026-03-20",
      activityType: "running",
    });

    expect(result).toEqual({
      activityCount: 2,
      totalMinutes: 150.5,
      totalDistanceMeters: 30000.3,
      totalElevationGainM: 420.3,
      activityTypes: ["cycling", "running"],
    });
    expect(sensorStore.query).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.stringContaining("activity.activity_type = {activityType:String}"),
      expect.objectContaining({ activityType: "running" }),
    );
    expect(sensorStore.query).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.not.stringContaining("activity.activity_type = {activityType:String}"),
      expect.not.objectContaining({ activityType: "running" }),
    );
    expect(database.execute).not.toHaveBeenCalled();
  });

  it("computes overview totals and type filters from canonical deduped activity summaries", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [
        {
          activity_count: "1",
          total_minutes: "60",
          total_distance_meters: "0",
          total_elevation_gain_m: "0",
        },
      ],
      [{ activity_type: "cycling" }],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    await repository.getActivityOverview({ weeks: 1, endDate: "2026-03-20" });

    const overviewQueryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
    const typeQueryText = vi.mocked(sensorStore.query).mock.calls[1]?.[1];
    expectDedupedActivitiesWithSummaryMetrics(overviewQueryText);
    expect(normalizeSql(overviewQueryText)).toContain(
      "sum(dateDiff('second', activity.started_at, activity.ended_at) / 60.0)",
    );
    expectDedupedActivitiesOnly(typeQueryText);
  });

  it("uses deduped activities as the activity overview identity source", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [
        {
          activity_count: "1",
          total_minutes: "60",
          total_distance_meters: "0",
          total_elevation_gain_m: "0",
        },
      ],
      [{ activity_type: "cycling" }],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    await repository.getActivityOverview({ weeks: 1, endDate: "2026-03-20" });

    const overviewQueryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
    const typeQueryText = vi.mocked(sensorStore.query).mock.calls[1]?.[1];
    expectDedupedActivitiesWithSummaryMetrics(overviewQueryText);
    expect(normalizeSql(overviewQueryText)).toContain(
      "sum(dateDiff('second', activity.started_at, activity.ended_at) / 60.0)",
    );
    expect(normalizeSql(typeQueryText)).toContain(
      "FROM analytics.deduped_activities AS activity FINAL",
    );
  });

  it("reads precomputed centroids from activity summary without a runtime location query", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [
        makeActivityRow({
          id: "indoor",
          activity_type: "indoor_cycling",
          total_distance: null,
          elevation_gain_m: null,
        }),
        makeActivityRow({
          id: "outdoor-without-route",
          activity_type: "running",
          total_distance: null,
          elevation_gain_m: null,
        }),
        makeActivityRow({
          id: "outdoor-with-route",
          activity_type: "running",
          total_distance: 5000,
          elevation_gain_m: 125,
          centroid_lat: 37.8,
          centroid_lng: -122.4,
        }),
      ],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(
      database,
      "00000000-0000-0000-0000-000000000001",
      "UTC",
      sensorStore,
    );

    const result = await repository.getWeekList({ weeks: 1, endDate: "2026-03-20" });

    expect(
      result[0]?.activities.find((activity) => activity.id === "outdoor-with-route")?.location,
    ).toEqual({
      centroidLat: 37.8,
      centroidLng: -122.4,
      tileUrl: "https://tile.openstreetmap.org/13/1310/3165.png",
      routePath: null,
      distanceMeters: 5000,
      elevationGainM: 125,
    });
    expect(sensorStore.query).toHaveBeenCalledTimes(3);
    expect(sensorStore.query).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("FROM analytics.deduped_location"),
      expect.anything(),
    );
  });

  it("builds the calories activity id filter without a Postgres row expression", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [makeActivityRow({ id: "activity-1" }), makeActivityRow({ id: "activity-2" })],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(
      database,
      "00000000-0000-0000-0000-000000000001",
      "UTC",
      sensorStore,
    );

    await repository.getWeekList({ weeks: 1, endDate: "2026-03-20" });

    const sqlObject = database.execute.mock.calls[0]?.[0];
    const compiledQuery = dialect.sqlToQuery(sqlObject);
    expect(compiledQuery.sql).toContain("a.id IN (");
    expect(compiledQuery.sql).not.toContain("AND a.id::text IN (");
    expect(compiledQuery.sql).not.toContain("ANY(($");
    expect(compiledQuery.params).toEqual(
      expect.arrayContaining(["00000000-0000-0000-0000-000000000001", "activity-1", "activity-2"]),
    );
  });

  it("returns days in descending date order", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [
        makeActivityRow({ id: "middle", local_date: "2026-03-19" }),
        makeActivityRow({ id: "newest", local_date: "2026-03-20" }),
        makeActivityRow({ id: "oldest", local_date: "2026-03-18" }),
      ],
      [{ max_hr: null, resting_hr: null, ftp: 250 }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({ weeks: 1, endDate: "2026-03-20" });

    expect(result.map((day) => day.date)).toEqual(["2026-03-20", "2026-03-19", "2026-03-18"]);
  });

  it("skips enrichment queries when no activities are in the requested window", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([[], [{ max_hr: null, resting_hr: null, ftp: null }]]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    await expect(repository.getWeekList({ weeks: 1, endDate: "2026-03-20" })).resolves.toEqual([]);

    expect(sensorStore.query).toHaveBeenCalledTimes(2);
    expect(database.execute).not.toHaveBeenCalled();
  });

  it("returns null and dash stats when activities have no usable stress or calorie data", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [makeActivityRow({ avg_power: null, avg_hr: null })],
      [{ max_hr: null, resting_hr: null, ftp: 250 }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({ weeks: 1, endDate: "2026-03-20" });

    expect(result[0]?.activities[0]).toEqual(
      expect.objectContaining({
        tss: null,
        stats: [
          { label: "Training Stress Score", value: "—" },
          { label: "Calories", value: "—" },
        ],
      }),
    );
  });

  it("does not compute stress for zero-duration activities", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [makeActivityRow({ duration_min: 0 })],
      [{ max_hr: null, resting_hr: null, ftp: 250 }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({ weeks: 1, endDate: "2026-03-20" });

    expect(result[0]?.activities[0]).toEqual(
      expect.objectContaining({
        tss: null,
        stats: [
          { label: "Training Stress Score", value: "—" },
          { label: "Calories", value: "—" },
        ],
      }),
    );
  });

  it("does not compute power stress from zero power", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [makeActivityRow({ avg_power: 0, avg_hr: null })],
      [{ max_hr: null, resting_hr: null, ftp: 250 }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({ weeks: 1, endDate: "2026-03-20" });

    expect(result[0]?.activities[0]?.tss).toBeNull();
  });

  it("does not compute power stress from zero functional threshold power", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [makeActivityRow({ avg_power: 250, avg_hr: null })],
      [{ max_hr: null, resting_hr: null, ftp: 0 }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({ weeks: 1, endDate: "2026-03-20" });

    expect(result[0]?.activities[0]?.tss).toBeNull();
  });

  it("falls back to heart-rate stress when power stress cannot be computed", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [
        makeActivityRow({
          duration_min: 45,
          avg_power: null,
          avg_hr: 150,
          max_hr: 190,
        }),
      ],
      [{ max_hr: null, resting_hr: null, ftp: 250 }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({ weeks: 1, endDate: "2026-03-20" });

    expect(result[0]?.activities[0]).toEqual(
      expect.objectContaining({
        tss: 45.1,
        stats: [
          { label: "Training Stress Score", value: "45.1" },
          { label: "Calories", value: "—" },
        ],
      }),
    );
  });

  it("uses profile heart-rate baseline before activity max heart rate", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [
        makeActivityRow({
          duration_min: 45,
          avg_power: null,
          avg_hr: 150,
          max_hr: 190,
        }),
      ],
      [{ max_hr: 200, resting_hr: 50, ftp: null }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({ weeks: 1, endDate: "2026-03-20" });

    expect(result[0]?.activities[0]?.tss).toBe(41.4);
  });

  it("does not compute heart-rate stress from zero average heart rate", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [
        makeActivityRow({
          avg_power: null,
          avg_hr: 0,
          max_hr: 190,
        }),
      ],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({ weeks: 1, endDate: "2026-03-20" });

    expect(result[0]?.activities[0]?.tss).toBeNull();
  });

  it("does not compute heart-rate stress without a max heart-rate baseline", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [
        makeActivityRow({
          avg_power: null,
          avg_hr: 150,
          max_hr: null,
        }),
      ],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({ weeks: 1, endDate: "2026-03-20" });

    expect(result[0]?.activities[0]?.tss).toBeNull();
  });

  it("does not compute heart-rate stress when max heart rate equals resting heart rate", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [
        makeActivityRow({
          avg_power: null,
          avg_hr: 150,
          max_hr: 60,
        }),
      ],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({ weeks: 1, endDate: "2026-03-20" });

    expect(result[0]?.activities[0]?.tss).toBeNull();
  });

  it("includes provider-absent activities from ClickHouse when requested", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [
        {
          id: "hidden-1",
          name: "Hidden Ride",
          activity_type: "cycling",
          started_at: "2026-03-18T07:00:00.000Z",
          ended_at: "2026-03-18T08:00:00.000Z",
          duration_min: 60,
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          total_distance: null,
          elevation_gain_m: null,
          centroid_lat: null,
          centroid_lng: null,
          local_date: "2026-03-18",
          provider_id: "strava",
          provider_absent_at: "2026-03-05T14:30:00.000Z",
          calories: 300,
        },
      ],
      [],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [],
    ]);
    const providerLookup = (providerId: string) =>
      providerId === "strava" ? { name: "Strava" } : { name: providerId };
    const repository = new ActivitiesCalendarRepository(
      database,
      "user-1",
      "UTC",
      sensorStore,
      undefined,
      providerLookup,
    );

    const result = await repository.getWeekList({
      weeks: 1,
      endDate: "2026-03-20",
      includeProviderAbsent: true,
    });

    expect(result).toEqual([
      {
        date: "2026-03-18",
        activities: [
          expect.objectContaining({
            id: "hidden-1",
            name: "Hidden Ride",
            isProviderAbsent: true,
            providerId: "strava",
            providerAbsentAt: "2026-03-05T14:30:00.000Z",
            calories: 300,
            tombstoneSummary: expect.stringMatching(/Removed from Strava · Mar 5,/),
          }),
        ],
      },
    ]);
    const hiddenQueryText = vi.mocked(sensorStore.query).mock.calls[2]?.[1];
    expect(normalizeSql(hiddenQueryText)).toContain(
      "FROM postgres_fitness.activity AS activity FINAL",
    );
    expect(normalizeSql(hiddenQueryText)).toContain("provider_absent_at IS NOT NULL");
    expect(sensorStore.query).toHaveBeenNthCalledWith(
      4,
      expect.anything(),
      expect.stringContaining("FROM analytics.activity_summary_rows FINAL"),
      expect.objectContaining({
        userId: "user-1",
        activityIds: ["hidden-1"],
      }),
    );
    expect(sensorStore.query).toHaveBeenNthCalledWith(
      5,
      expect.anything(),
      expect.stringContaining("FROM postgres_fitness.user_profile_current"),
      { userId: "user-1" },
    );
    expect(sensorStore.query).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      expect.stringContaining("FROM postgres_fitness.activity AS activity FINAL"),
      expect.objectContaining({
        userId: "user-1",
        timezone: "UTC",
        windowStart: "2026-03-13",
      }),
    );
    expect(database.execute).not.toHaveBeenCalled();
  });

  it("returns only active days when includeProviderAbsent is requested but no hidden activities match", async () => {
    const database = makeDatabase([{ id: "activity-1", calories: 421.6 }]);
    const sensorStore = makeSensorStore([
      [makeActivityRow({ id: "activity-1" })],
      [{ max_hr: null, resting_hr: null, ftp: 250 }],
      [],
      [],
      [{ max_hr: null, resting_hr: null, ftp: null }],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({
      weeks: 1,
      endDate: "2026-03-20",
      includeProviderAbsent: true,
    });

    expect(result).toEqual([
      {
        date: "2026-03-18",
        activities: [expect.objectContaining({ id: "activity-1", name: "Trainer Ride" })],
      },
    ]);
    expect(sensorStore.query).toHaveBeenCalledTimes(4);
  });

  it("merges active and hidden activities by date while preferring active entries for duplicate ids", async () => {
    const database = makeDatabase([{ id: "shared-id", calories: 300 }]);
    const sensorStore = makeSensorStore([
      [
        makeActivityRow({
          id: "shared-id",
          name: "Active Ride",
          local_date: "2026-03-18",
        }),
        makeActivityRow({
          id: "active-only",
          name: "Other Ride",
          local_date: "2026-03-19",
        }),
      ],
      [{ max_hr: null, resting_hr: null, ftp: 250 }],
      [],
      [
        {
          id: "shared-id",
          name: "Hidden Ride",
          activity_type: "cycling",
          started_at: "2026-03-18T07:00:00.000Z",
          ended_at: "2026-03-18T08:00:00.000Z",
          duration_min: 60,
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          total_distance: null,
          elevation_gain_m: null,
          centroid_lat: null,
          centroid_lng: null,
          local_date: "2026-03-18",
          provider_id: "strava",
          provider_absent_at: "2026-03-05T14:30:00.000Z",
          calories: 100,
        },
        {
          id: "hidden-only",
          name: "Hidden Run",
          activity_type: "running",
          started_at: "2026-03-17T07:00:00.000Z",
          ended_at: "2026-03-17T08:00:00.000Z",
          duration_min: 45,
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          total_distance: null,
          elevation_gain_m: null,
          centroid_lat: null,
          centroid_lng: null,
          local_date: "2026-03-17",
          provider_id: "garmin",
          provider_absent_at: "2026-03-04T14:30:00.000Z",
          calories: null,
        },
      ],
      [],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({
      weeks: 1,
      endDate: "2026-03-20",
      includeProviderAbsent: true,
    });

    expect(result.map((day) => day.date)).toEqual(["2026-03-19", "2026-03-18", "2026-03-17"]);
    expect(result.find((day) => day.date === "2026-03-18")?.activities).toEqual([
      expect.objectContaining({
        id: "shared-id",
        name: "Active Ride",
      }),
    ]);
    expect(
      result.find((day) => day.date === "2026-03-18")?.activities[0]?.isProviderAbsent,
    ).toBeUndefined();
    expect(result.find((day) => day.date === "2026-03-17")?.activities[0]).toEqual(
      expect.objectContaining({
        id: "hidden-only",
        isProviderAbsent: true,
      }),
    );
  });

  it("enriches hidden activities with summary metrics and route previews", async () => {
    const routePoints = [
      { lat: 37.8, lng: -122.4 },
      { lat: 37.801, lng: -122.399 },
      { lat: 37.802, lng: -122.398 },
    ];
    const routePreview = osmTilePreview(routePoints);
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [
        {
          id: "hidden-outdoor",
          name: "Hidden Run",
          activity_type: "running",
          started_at: "2026-03-18T07:00:00.000Z",
          ended_at: "2026-03-18T08:00:00.000Z",
          duration_min: 60,
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          total_distance: null,
          elevation_gain_m: null,
          centroid_lat: null,
          centroid_lng: null,
          local_date: "2026-03-18",
          provider_id: "strava",
          provider_absent_at: "2026-03-05T14:30:00.000Z",
          calories: null,
        },
      ],
      [
        {
          id: "hidden-outdoor",
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          total_distance: 5000,
          elevation_gain_m: 125,
          centroid_lat: 37.8,
          centroid_lng: -122.4,
        },
      ],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      routePoints.map((point) => ({
        activity_id: "hidden-outdoor",
        lat: point.lat,
        lng: point.lng,
      })),
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({
      weeks: 1,
      endDate: "2026-03-20",
      includeProviderAbsent: true,
    });

    expect(result[0]?.activities[0]?.location).toEqual({
      centroidLat: 37.8,
      centroidLng: -122.4,
      tileUrl: routePreview.tileUrl,
      routePath: routePreview.routePath,
      distanceMeters: 5000,
      elevationGainM: 125,
    });
  });

  it("includes partial absence summaries for canonical activities with absent source links", async () => {
    const database = makeDatabase([]);
    const providerLookup = (providerId: string) =>
      providerId === "strava" ? { name: "Strava" } : { name: providerId };
    const sensorStore = makeSensorStore([
      [
        makeActivityRow({
          id: "canonical-activity",
          source_external_ids: [
            {
              providerId: "garmin",
              externalId: "123",
            },
          ],
          absent_source_external_ids: [
            {
              providerId: "strava",
              externalId: "99999",
              memberActivityId: "member-strava",
              providerAbsentAt: "2026-03-05T14:30:00.000Z",
            },
          ],
        }),
      ],
      [{ max_hr: null, resting_hr: null, ftp: 250 }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(
      database,
      "user-1",
      "UTC",
      sensorStore,
      undefined,
      providerLookup,
    );

    const result = await repository.getWeekList({ weeks: 1, endDate: "2026-03-20" });

    expect(result[0]?.activities[0]?.partialAbsenceSummary).toMatch(/Strava removed · Mar 5,/);
  });

  it("builds complete hidden activity entries with stress, stats, and tombstone metadata", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [
        {
          id: "hidden-power",
          name: "Hidden Ride",
          activity_type: "indoor_cycling",
          started_at: "2026-03-18T07:00:00.000Z",
          ended_at: "2026-03-18T08:00:00.000Z",
          duration_min: 60,
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          total_distance: null,
          elevation_gain_m: null,
          centroid_lat: null,
          centroid_lng: null,
          local_date: "2026-03-18",
          provider_id: "strava",
          provider_absent_at: "2026-03-05T14:30:00.000Z",
          calories: 300,
        },
      ],
      [
        {
          id: "hidden-power",
          avg_hr: null,
          max_hr: null,
          avg_power: 250,
          total_distance: null,
          elevation_gain_m: null,
          centroid_lat: null,
          centroid_lng: null,
        },
      ],
      [{ max_hr: null, resting_hr: null, ftp: 250 }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({
      weeks: 1,
      endDate: "2026-03-20",
      includeProviderAbsent: true,
    });

    expect(result[0]?.activities[0]).toEqual({
      id: "hidden-power",
      name: "Hidden Ride",
      activityType: "indoor_cycling",
      startedAt: "2026-03-18T07:00:00.000Z",
      endedAt: "2026-03-18T08:00:00.000Z",
      durationMin: 60,
      location: null,
      calories: 300,
      tss: 100,
      stats: [
        { label: "Training Stress Score", value: "100" },
        { label: "Calories", value: "300 kcal" },
      ],
      isProviderAbsent: true,
      providerId: "strava",
      providerAbsentAt: "2026-03-05T14:30:00.000Z",
      tombstoneSummary: ActivitySourceAttribution.hiddenActivityTombstoneSummary(
        "strava",
        "2026-03-05T14:30:00.000Z",
      ),
    });
  });

  it("omits hidden locations when only longitude is present", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [
        {
          id: "hidden-longitude-only",
          name: "Hidden Run",
          activity_type: "running",
          started_at: "2026-03-18T07:00:00.000Z",
          ended_at: "2026-03-18T08:00:00.000Z",
          duration_min: 60,
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          total_distance: null,
          elevation_gain_m: null,
          centroid_lat: null,
          centroid_lng: null,
          local_date: "2026-03-18",
          provider_id: "strava",
          provider_absent_at: "2026-03-05T14:30:00.000Z",
          calories: null,
        },
      ],
      [
        {
          id: "hidden-longitude-only",
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          total_distance: 5000,
          elevation_gain_m: 125,
          centroid_lat: null,
          centroid_lng: -122.4,
        },
      ],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({
      weeks: 1,
      endDate: "2026-03-20",
      includeProviderAbsent: true,
    });

    expect(result[0]?.activities[0]?.location).toBeNull();
  });

  it("uses the route preview tile for hidden outdoor activities when available", async () => {
    const routePoints = [
      { lat: 37.7749, lng: -122.4194 },
      { lat: 37.7752, lng: -122.4188 },
      { lat: 37.7756, lng: -122.4182 },
    ];
    const routePreview = osmTilePreview(routePoints);
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [
        {
          id: "hidden-outdoor-route",
          name: "Hidden Run",
          activity_type: "running",
          started_at: "2026-03-18T07:00:00.000Z",
          ended_at: "2026-03-18T08:00:00.000Z",
          duration_min: 60,
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          total_distance: null,
          elevation_gain_m: null,
          centroid_lat: null,
          centroid_lng: null,
          local_date: "2026-03-18",
          provider_id: "strava",
          provider_absent_at: "2026-03-05T14:30:00.000Z",
          calories: null,
        },
      ],
      [
        {
          id: "hidden-outdoor-route",
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          total_distance: 5000,
          elevation_gain_m: 125,
          centroid_lat: 37.7749,
          centroid_lng: -122.4194,
        },
      ],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      routePoints.map((point) => ({
        activity_id: "hidden-outdoor-route",
        lat: point.lat,
        lng: point.lng,
      })),
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({
      weeks: 1,
      endDate: "2026-03-20",
      includeProviderAbsent: true,
    });

    expect(result[0]?.activities[0]?.location).toEqual({
      centroidLat: 37.7749,
      centroidLng: -122.4194,
      tileUrl: routePreview.tileUrl,
      routePath: routePreview.routePath,
      distanceMeters: 5000,
      elevationGainM: 125,
    });
  });

  it("falls back to an osm tile when hidden activities have no route preview", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [
        {
          id: "hidden-outdoor-fallback",
          name: "Hidden Run",
          activity_type: "running",
          started_at: "2026-03-18T07:00:00.000Z",
          ended_at: "2026-03-18T08:00:00.000Z",
          duration_min: 60,
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          total_distance: null,
          elevation_gain_m: null,
          centroid_lat: null,
          centroid_lng: null,
          local_date: "2026-03-18",
          provider_id: "strava",
          provider_absent_at: "2026-03-05T14:30:00.000Z",
          calories: null,
        },
      ],
      [
        {
          id: "hidden-outdoor-fallback",
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          total_distance: 5000,
          elevation_gain_m: 125,
          centroid_lat: 37.8,
          centroid_lng: -122.4,
        },
      ],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({
      weeks: 1,
      endDate: "2026-03-20",
      includeProviderAbsent: true,
    });

    expect(result[0]?.activities[0]?.location).toEqual({
      centroidLat: 37.8,
      centroidLng: -122.4,
      tileUrl: osmTileUrl(37.8, -122.4),
      routePath: null,
      distanceMeters: 5000,
      elevationGainM: 125,
    });
  });

  it("returns hidden-only days in descending date order", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [
        {
          id: "hidden-older",
          name: "Older Hidden",
          activity_type: "running",
          started_at: "2026-03-17T07:00:00.000Z",
          ended_at: "2026-03-17T08:00:00.000Z",
          duration_min: 45,
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          total_distance: null,
          elevation_gain_m: null,
          centroid_lat: null,
          centroid_lng: null,
          local_date: "2026-03-17",
          provider_id: "strava",
          provider_absent_at: "2026-03-05T14:30:00.000Z",
          calories: null,
        },
        {
          id: "hidden-newer",
          name: "Newer Hidden",
          activity_type: "running",
          started_at: "2026-03-18T07:00:00.000Z",
          ended_at: "2026-03-18T08:00:00.000Z",
          duration_min: 60,
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          total_distance: null,
          elevation_gain_m: null,
          centroid_lat: null,
          centroid_lng: null,
          local_date: "2026-03-18",
          provider_id: "garmin",
          provider_absent_at: "2026-03-04T14:30:00.000Z",
          calories: null,
        },
      ],
      [],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({
      weeks: 1,
      endDate: "2026-03-20",
      includeProviderAbsent: true,
    });

    expect(result.map((day) => day.date)).toEqual(["2026-03-18", "2026-03-17"]);
    expect(result[0]?.activities[0]?.tss).toBeNull();
    expect(result[0]?.activities[0]?.stats).toEqual([
      { label: "Training Stress Score", value: "—" },
      { label: "Calories", value: "—" },
    ]);
  });

  it("passes the user id to hidden activity enrichment queries", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [
        {
          id: "hidden-1",
          name: "Hidden Ride",
          activity_type: "cycling",
          started_at: "2026-03-18T07:00:00.000Z",
          ended_at: "2026-03-18T08:00:00.000Z",
          duration_min: 60,
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          total_distance: null,
          elevation_gain_m: null,
          centroid_lat: null,
          centroid_lng: null,
          local_date: "2026-03-18",
          provider_id: "strava",
          provider_absent_at: "2026-03-05T14:30:00.000Z",
          calories: null,
        },
      ],
      [],
      [{ max_hr: 180, resting_hr: 55, ftp: 250 }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    await repository.getWeekList({
      weeks: 1,
      endDate: "2026-03-20",
      includeProviderAbsent: true,
    });

    expect(sensorStore.query).toHaveBeenNthCalledWith(
      5,
      expect.anything(),
      expect.stringContaining("FROM postgres_fitness.user_profile_current"),
      { userId: "user-1" },
    );
  });

  it("does not apply limited access filters when the access window is full", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [
        {
          id: "hidden-1",
          name: "Hidden Ride",
          activity_type: "cycling",
          started_at: "2026-03-18T07:00:00.000Z",
          ended_at: "2026-03-18T08:00:00.000Z",
          duration_min: 60,
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          total_distance: null,
          elevation_gain_m: null,
          centroid_lat: null,
          centroid_lng: null,
          local_date: "2026-03-18",
          provider_id: "strava",
          provider_absent_at: "2026-03-05T14:30:00.000Z",
          calories: null,
        },
      ],
      [],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore, {
      kind: "full",
      paid: true,
      reason: "paid_grant",
    });

    await repository.getWeekList({
      weeks: 1,
      endDate: "2026-03-20",
      includeProviderAbsent: true,
    });

    const hiddenQueryText = vi.mocked(sensorStore.query).mock.calls[2]?.[1];
    expect(normalizeSql(hiddenQueryText)).not.toContain("accessStartDate");
    expect(sensorStore.query).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      expect.not.stringContaining("accessStartDate"),
      expect.not.objectContaining({ accessStartDate: expect.anything() }),
    );
  });

  it("omits hidden locations when only one centroid coordinate is present", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [
        {
          id: "hidden-latitude-only",
          name: "Hidden Run",
          activity_type: "running",
          started_at: "2026-03-18T07:00:00.000Z",
          ended_at: "2026-03-18T08:00:00.000Z",
          duration_min: 60,
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          total_distance: null,
          elevation_gain_m: null,
          centroid_lat: null,
          centroid_lng: null,
          local_date: "2026-03-18",
          provider_id: "strava",
          provider_absent_at: "2026-03-05T14:30:00.000Z",
          calories: null,
        },
      ],
      [
        {
          id: "hidden-latitude-only",
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          total_distance: 5000,
          elevation_gain_m: 125,
          centroid_lat: 37.8,
          centroid_lng: null,
        },
      ],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({
      weeks: 1,
      endDate: "2026-03-20",
      includeProviderAbsent: true,
    });

    expect(result[0]?.activities[0]?.location).toBeNull();
  });

  it("sorts merged hidden activities on the same day by startedAt descending", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [
        {
          id: "hidden-early",
          name: "Early Hidden",
          activity_type: "running",
          started_at: "2026-03-18T07:00:00.000Z",
          ended_at: "2026-03-18T08:00:00.000Z",
          duration_min: 60,
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          total_distance: null,
          elevation_gain_m: null,
          centroid_lat: null,
          centroid_lng: null,
          local_date: "2026-03-18",
          provider_id: "strava",
          provider_absent_at: "2026-03-05T14:30:00.000Z",
          calories: null,
        },
        {
          id: "hidden-late",
          name: "Late Hidden",
          activity_type: "running",
          started_at: "2026-03-18T10:00:00.000Z",
          ended_at: "2026-03-18T11:00:00.000Z",
          duration_min: 60,
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          total_distance: null,
          elevation_gain_m: null,
          centroid_lat: null,
          centroid_lng: null,
          local_date: "2026-03-18",
          provider_id: "garmin",
          provider_absent_at: "2026-03-04T14:30:00.000Z",
          calories: null,
        },
      ],
      [],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({
      weeks: 1,
      endDate: "2026-03-20",
      includeProviderAbsent: true,
    });

    expect(result[0]?.activities.map((activity) => activity.id)).toEqual([
      "hidden-late",
      "hidden-early",
    ]);
  });

  it("sorts merged active and hidden activities on the same day by startedAt descending", async () => {
    const database = makeDatabase([{ id: "active-early", calories: 200 }]);
    const sensorStore = makeSensorStore([
      [
        makeActivityRow({
          id: "active-early",
          name: "Active Early",
          started_at: "2026-03-18T07:00:00.000Z",
          ended_at: "2026-03-18T08:00:00.000Z",
          local_date: "2026-03-18",
        }),
      ],
      [{ max_hr: null, resting_hr: null, ftp: 250 }],
      [],
      [
        {
          id: "hidden-late",
          name: "Hidden Late",
          activity_type: "running",
          started_at: "2026-03-18T10:00:00.000Z",
          ended_at: "2026-03-18T11:00:00.000Z",
          duration_min: 60,
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          total_distance: null,
          elevation_gain_m: null,
          centroid_lat: null,
          centroid_lng: null,
          local_date: "2026-03-18",
          provider_id: "strava",
          provider_absent_at: "2026-03-05T14:30:00.000Z",
          calories: null,
        },
      ],
      [],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({
      weeks: 1,
      endDate: "2026-03-20",
      includeProviderAbsent: true,
    });

    expect(result).toEqual([
      {
        date: "2026-03-18",
        activities: [
          expect.objectContaining({ id: "hidden-late" }),
          expect.objectContaining({ id: "active-early" }),
        ],
      },
    ]);
  });

  it("filters hidden activities by activity type when requested", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [
        {
          id: "hidden-run",
          name: "Hidden Run",
          activity_type: "running",
          started_at: "2026-03-18T07:00:00.000Z",
          ended_at: "2026-03-18T08:00:00.000Z",
          duration_min: 45,
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          total_distance: null,
          elevation_gain_m: null,
          centroid_lat: null,
          centroid_lng: null,
          local_date: "2026-03-18",
          provider_id: "strava",
          provider_absent_at: "2026-03-05T14:30:00.000Z",
          calories: null,
        },
      ],
      [],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({
      weeks: 1,
      endDate: "2026-03-20",
      activityType: "running",
      includeProviderAbsent: true,
    });

    expect(result[0]?.activities[0]?.id).toBe("hidden-run");
    const hiddenQueryText = vi.mocked(sensorStore.query).mock.calls[2]?.[1];
    expect(normalizeSql(hiddenQueryText)).toContain(
      "activity.activity_type = {activityType:String}",
    );
    expect(sensorStore.query).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      expect.stringContaining("activity.activity_type = {activityType:String}"),
      expect.objectContaining({ activityType: "running" }),
    );
  });

  it("applies limited access windows to hidden activity queries", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [
        {
          id: "hidden-1",
          name: "Hidden Ride",
          activity_type: "cycling",
          started_at: "2026-03-18T07:00:00.000Z",
          ended_at: "2026-03-18T08:00:00.000Z",
          duration_min: 60,
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          total_distance: null,
          elevation_gain_m: null,
          centroid_lat: null,
          centroid_lng: null,
          local_date: "2026-03-18",
          provider_id: "strava",
          provider_absent_at: "2026-03-05T14:30:00.000Z",
          calories: null,
        },
      ],
      [],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore, {
      kind: "limited",
      paid: false,
      reason: "free_signup_week",
      startDate: "2026-03-01",
      endDateExclusive: "2026-03-31",
    });

    await repository.getWeekList({
      weeks: 1,
      endDate: "2026-03-20",
      includeProviderAbsent: true,
    });

    const hiddenQueryText = vi.mocked(sensorStore.query).mock.calls[2]?.[1];
    expect(normalizeSql(hiddenQueryText)).toContain("accessStartDate");
    expect(sensorStore.query).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      expect.stringContaining("accessStartDate"),
      expect.objectContaining({
        accessStartDate: "2026-03-01",
        accessEndDateExclusive: "2026-03-31",
      }),
    );
  });

  it("computes hidden heart-rate stress from enriched summary metrics when baseline is missing", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [
        {
          id: "hidden-hr",
          name: "Hidden Run",
          activity_type: "running",
          started_at: "2026-03-18T07:00:00.000Z",
          ended_at: "2026-03-18T08:00:00.000Z",
          duration_min: 45,
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          total_distance: null,
          elevation_gain_m: null,
          centroid_lat: null,
          centroid_lng: null,
          local_date: "2026-03-18",
          provider_id: "strava",
          provider_absent_at: "2026-03-05T14:30:00.000Z",
          calories: null,
        },
      ],
      [
        {
          id: "hidden-hr",
          avg_hr: 150,
          max_hr: 190,
          avg_power: null,
          total_distance: null,
          elevation_gain_m: null,
          centroid_lat: null,
          centroid_lng: null,
        },
      ],
      [],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({
      weeks: 1,
      endDate: "2026-03-20",
      includeProviderAbsent: true,
    });

    expect(result[0]?.activities[0]).toEqual(
      expect.objectContaining({
        id: "hidden-hr",
        tss: 45.1,
        stats: [
          { label: "Training Stress Score", value: "45.1" },
          { label: "Calories", value: "—" },
        ],
      }),
    );
  });
});

describe("mergeDayGroups", () => {
  it("sorts day groups in descending date order", () => {
    const activeDays = [
      {
        date: "2026-03-17",
        activities: [
          makeCalendarEntry({ id: "active-old", startedAt: "2026-03-17T07:00:00.000Z" }),
        ],
      },
    ];
    const hiddenDays = [
      {
        date: "2026-03-18",
        activities: [
          makeCalendarEntry({ id: "hidden-new", startedAt: "2026-03-18T07:00:00.000Z" }),
        ],
      },
    ];

    expect(mergeDayGroups(activeDays, hiddenDays).map((day) => day.date)).toEqual([
      "2026-03-18",
      "2026-03-17",
    ]);
  });

  it("sorts activities within a day by startedAt descending", () => {
    const activeDays = [
      {
        date: "2026-03-18",
        activities: [
          makeCalendarEntry({
            id: "early",
            startedAt: "2026-03-18T07:00:00.000Z",
          }),
          makeCalendarEntry({
            id: "late",
            startedAt: "2026-03-18T10:00:00.000Z",
          }),
        ],
      },
    ];

    expect(
      mergeDayGroups(activeDays, []).flatMap((day) =>
        day.activities.map((activity) => activity.id),
      ),
    ).toEqual(["late", "early"]);
  });

  it("keeps equal startedAt entries in insertion order", () => {
    const activeDays = [
      {
        date: "2026-03-18",
        activities: [
          makeCalendarEntry({
            id: "first",
            startedAt: "2026-03-18T07:00:00.000Z",
          }),
          makeCalendarEntry({
            id: "second",
            startedAt: "2026-03-18T07:00:00.000Z",
          }),
        ],
      },
    ];

    expect(
      mergeDayGroups(activeDays, []).flatMap((day) =>
        day.activities.map((activity) => activity.id),
      ),
    ).toEqual(["first", "second"]);
  });

  it("prefers active entries when active and hidden activities share the same id", () => {
    const activeDays = [
      {
        date: "2026-03-18",
        activities: [
          makeCalendarEntry({
            id: "shared-id",
            name: "Active Ride",
            startedAt: "2026-03-18T07:00:00.000Z",
          }),
        ],
      },
    ];
    const hiddenDays = [
      {
        date: "2026-03-18",
        activities: [
          makeCalendarEntry({
            id: "shared-id",
            name: "Hidden Ride",
            startedAt: "2026-03-18T07:00:00.000Z",
            isProviderAbsent: true,
          }),
        ],
      },
    ];

    expect(mergeDayGroups(activeDays, hiddenDays)).toEqual([
      {
        date: "2026-03-18",
        activities: [expect.objectContaining({ id: "shared-id", name: "Active Ride" })],
      },
    ]);
  });
});
