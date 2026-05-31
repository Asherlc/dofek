import type { Database } from "dofek/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { ActivitiesCalendarRepository } from "./activities-calendar-repository.ts";
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
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({ weeks: 1, endDate: "2026-03-20" });

    expect(result[0]?.activities[0]?.location).toEqual({
      centroidLat: 90,
      centroidLng: 180,
      tileUrl: "https://tile.openstreetmap.org/13/0/0.png",
      distanceMeters: 5000,
      elevationGainM: 125,
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
      expect.stringContaining("asum.activity_type = {activityType:String}"),
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
      expect.stringContaining("FROM analytics.activity_summary"),
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
    expect(sensorStore.query).toHaveBeenCalledTimes(2);
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
    expect(queryText).toContain("INNER JOIN analytics.v_activity AS activity");
    expect(queryText).toContain("activity.id = asum.activity_id");
    expect(queryText).toContain("activity.user_id = asum.user_id");
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
      expect.stringContaining("asum.activity_type = {activityType:String}"),
      expect.objectContaining({ activityType: "running" }),
    );
    expect(sensorStore.query).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.not.stringContaining("asum.activity_type = {activityType:String}"),
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
    expect(overviewQueryText).toContain("INNER JOIN analytics.v_activity AS activity");
    expect(overviewQueryText).toContain("activity.id = asum.activity_id");
    expect(overviewQueryText).toContain("activity.user_id = asum.user_id");
    expect(typeQueryText).toContain("INNER JOIN analytics.v_activity AS activity");
    expect(typeQueryText).toContain("activity.id = asum.activity_id");
    expect(typeQueryText).toContain("activity.user_id = asum.user_id");
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
      distanceMeters: 5000,
      elevationGainM: 125,
    });
    expect(sensorStore.query).toHaveBeenCalledTimes(2);
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
});
