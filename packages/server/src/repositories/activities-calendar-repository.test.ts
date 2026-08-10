import type { Database } from "dofek/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { osmTilePreview } from "../lib/osm-tile.ts";
import type { CalendarActivityEntry } from "./activities-calendar-repository.ts";
import { ActivitiesCalendarRepository, mergeDayGroups } from "./activities-calendar-repository.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";

const dialect = new PgDialect();

type TestDatabaseRow = Record<string, unknown>;

function isQueuedRowSets(
  rowsOrRowSets: TestDatabaseRow[] | TestDatabaseRow[][],
): rowsOrRowSets is TestDatabaseRow[][] {
  return rowsOrRowSets.some(Array.isArray);
}

function makeDatabase(rowsOrRowSets: TestDatabaseRow[] | TestDatabaseRow[][] = []) {
  if (isQueuedRowSets(rowsOrRowSets)) {
    const execute = vi.fn();
    for (const rows of rowsOrRowSets) {
      execute.mockResolvedValueOnce(rows);
    }
    execute.mockResolvedValue([]);
    return {
      execute,
    } satisfies Pick<Database, "execute">;
  }

  const execute = vi.fn().mockImplementation(async (query) => {
    const compiled = dialect.sqlToQuery(query);
    if (compiled.sql.includes("fitness.v_activity") || compiled.sql.includes("fitness.activity")) {
      const stringParams = compiled.params.filter(
        (param): param is string => typeof param === "string",
      );
      return stringParams.slice(1).map((id) => ({ id }));
    }
    return [];
  });
  return {
    execute,
  } satisfies Pick<Database, "execute">;
}

function makeSensorStore(rowSets: Record<string, unknown>[][]): ActivitySensorStore {
  const query = vi.fn();
  for (const rows of rowSets) {
    query.mockImplementationOnce((schema: { parse: (row: Record<string, unknown>) => unknown }) =>
      Promise.resolve(
        rows.map((row) =>
          schema.parse(
            ("canonical_type" in row || "activity_type" in row) && "started_at" in row
              ? {
                  timezone: null,
                  start_utc_offset_minutes: null,
                  end_utc_offset_minutes: null,
                  local_time_source: "unknown",
                  provider_id: "wahoo",
                  source_name: null,
                  source_external_ids: [],
                  absent_source_external_ids: [],
                  last_processed_at: null,
                  ...row,
                }
              : row,
          ),
        ),
      ),
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
    canonical_type: "cycling",
    started_at: "2026-03-18T07:00:00.000Z",
    ended_at: "2026-03-18T08:00:00.000Z",
    provider_id: "wahoo",
    source_name: null,
    source_external_ids: [
      {
        providerId: "wahoo",
        externalId: "wahoo-activity-1",
      },
    ],
    absent_source_external_ids: [],
    last_processed_at: "2026-03-18T08:05:00.000Z",
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
}

function expectDedupedActivitiesDriveActivityListIdentity(queryText: string | undefined): void {
  const normalizedQueryText = normalizeSql(queryText);
  expect(normalizedQueryText).toContain("FROM analytics.deduped_activities AS activity FINAL");
  expect(normalizedQueryText).toContain("LEFT JOIN analytics.activity_summary asum");
  expect(normalizedQueryText).toContain("toString(activity.activity_id) AS id");
  expect(normalizedQueryText).toContain("activity.name AS name");
  expect(normalizedQueryText).toContain("activity.canonical_type AS canonical_type");
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
    localTimeContext: overrides.localTimeContext ?? {
      timezone: null,
      startUtcOffsetMinutes: null,
      endUtcOffsetMinutes: null,
      source: "unknown",
    },
    durationMin: overrides.durationMin ?? 60,
    source: overrides.source ?? {
      primarySourceLabel: "Wahoo",
      sourceCount: 1,
      overlapSummary: null,
    },
    lastProcessedAt: overrides.lastProcessedAt ?? "2026-03-18T08:05:00.000Z",
    distanceMeters: overrides.distanceMeters ?? null,
    distanceState: overrides.distanceState ?? {
      status: "missing",
      reason: "Distance not recorded",
    },
    elevationGainM: overrides.elevationGainM ?? null,
    elevationState: overrides.elevationState ?? {
      status: "missing",
      reason: "Elevation gain not recorded",
    },
    location: overrides.location ?? null,
    tss: overrides.tss ?? null,
    stats: overrides.stats ?? [],
    ...overrides,
  };
}

describe("ActivitiesCalendarRepository", () => {
  it("returns canonical source attribution and read-model processing freshness", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [
        makeActivityRow({
          provider_id: "wahoo",
          source_external_ids: [
            {
              providerId: "wahoo",
              externalId: "wahoo-activity-1",
            },
            {
              providerId: "strava",
              externalId: "strava-activity-1",
            },
          ],
          last_processed_at: "2026-03-18T08:07:00.000Z",
        }),
      ],
      [{ max_hr: null, resting_hr: null, ftp: 250 }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({ weeks: 4, endDate: "2026-03-20" });

    expect(result[0]?.activities[0]).toEqual(
      expect.objectContaining({
        source: {
          primarySourceLabel: "Wahoo",
          sourceCount: 2,
          overlapSummary: "2 matched source records · Wahoo selected by source priority",
        },
        lastProcessedAt: "2026-03-18T08:07:00.000Z",
      }),
    );
    const listQuery = String(vi.mocked(sensorStore.query).mock.calls[0]?.[1]);
    expect(normalizeSql(listQuery)).toMatch(
      /greatest\(\s*activity\.refreshed_at,\s*coalesce\(asum\.refreshed_at, activity\.refreshed_at\)\s*\)/,
    );
  });

  it("groups activities by normalized local date and returns display-ready indoor stats", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [
        makeActivityRow({
          avg_power: 251,
          timezone: "America/Los_Angeles",
          start_utc_offset_minutes: -480,
          end_utc_offset_minutes: -420,
          local_time_source: "provider_timezone",
        }),
      ],
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
            localTimeContext: {
              timezone: "America/Los_Angeles",
              startUtcOffsetMinutes: -480,
              endUtcOffsetMinutes: -420,
              source: "provider_timezone",
            },
            tss: 100.8,
            location: null,
            stats: [{ status: "available", label: "Training Stress Score", value: "100.8" }],
          }),
        ],
      },
    ]);
  });

  it("exposes timezone fields only for authoritative timezone provenance", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [
        makeActivityRow({
          id: "offset-context",
          timezone: "America/Los_Angeles",
          start_utc_offset_minutes: -480,
          end_utc_offset_minutes: -480,
          local_time_source: "provider_offset",
        }),
        makeActivityRow({
          id: "device-timezone-context",
          timezone: "America/Los_Angeles",
          start_utc_offset_minutes: -480,
          end_utc_offset_minutes: -420,
          local_time_source: "device_timezone",
        }),
      ],
      [{ max_hr: null, resting_hr: null, ftp: 250 }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({ weeks: 4, endDate: "2026-03-20" });
    const contextById = new Map(
      (result[0]?.activities ?? []).map((entry) => [entry.id, entry.localTimeContext]),
    );

    expect(contextById.get("offset-context")).toEqual({
      timezone: null,
      startUtcOffsetMinutes: -480,
      endUtcOffsetMinutes: -480,
      source: "provider_offset",
    });
    expect(contextById.get("device-timezone-context")).toEqual({
      timezone: "America/Los_Angeles",
      startUtcOffsetMinutes: -480,
      endUtcOffsetMinutes: -420,
      source: "device_timezone",
    });
  });

  it("adds a clamped location tile and preserves distance/elevation for outdoor activities", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [
        makeActivityRow({
          canonical_type: "running",
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

    expect(result[0]?.activities[0]).toEqual(
      expect.objectContaining({
        distanceMeters: 5000,
        distanceState: { status: "available" },
        elevationGainM: 125,
        elevationState: { status: "available" },
      }),
    );
    expect(result[0]?.activities[0]?.location).toEqual({
      centroidLat: 90,
      centroidLng: 180,
      mapPreview: osmTilePreview([{ lat: 90, lng: 180 }]),
    });
  });

  it("adds route preview path points for outdoor activities", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [
        makeActivityRow({
          id: "00000000-0000-0000-0000-000000000001",
          canonical_type: "running",
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
      mapPreview: osmTilePreview([
        { lat: 37.7749, lng: -122.4194 },
        { lat: 37.7752, lng: -122.4188 },
        { lat: 37.7756, lng: -122.4182 },
      ]),
    });
  });

  it("omits locations when only one centroid coordinate is present", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [
        makeActivityRow({
          id: "latitude-only",
          canonical_type: "running",
          centroid_lat: 37.8,
          centroid_lng: null,
        }),
        makeActivityRow({
          id: "longitude-only",
          canonical_type: "running",
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
    expect(sensorStore.query).toHaveBeenCalledTimes(2);
  });

  it("filters activities by activity type before grouping days", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [
        makeActivityRow({
          id: "ride",
          canonical_type: "cycling",
          local_date: "2026-03-18",
        }),
        makeActivityRow({
          id: "run",
          canonical_type: "running",
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
      expect.stringContaining("activity.canonical_type = {activityType:String}"),
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
        makeActivityRow({
          id: "activity-1",
          total_distance: 5000,
          centroid_lat: 37.7749,
          centroid_lng: -122.4194,
        }),
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
        activityIds: ["activity-1"],
        maxPoints: 96,
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

  it("excludes activities hidden in Postgres even when ClickHouse is stale", async () => {
    const database = makeDatabase([[]]);
    const sensorStore = makeSensorStore([
      [makeActivityRow({ id: "activity-1" })],
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

    expect(result).toEqual([]);
    expect(database.execute).toHaveBeenCalledTimes(1);
    const sqlObject = database.execute.mock.calls[0]?.[0];
    const compiledQuery = dialect.sqlToQuery(sqlObject);
    expect(normalizeSql(compiledQuery.sql)).toContain("FROM fitness.activity");
    expect(sensorStore.query).toHaveBeenCalledTimes(2);
  });

  it("returns activity overview totals from authorized ClickHouse activity rows", async () => {
    const database = makeDatabase([
      [{ id: "running-activity" }, { id: "cycling-activity" }],
      [{ id: "running-activity" }, { id: "cycling-activity" }],
    ]);
    const sensorStore = makeSensorStore([
      [
        {
          current_activity_count: "1",
          current_total_minutes: "60.2",
          current_total_distance_meters: "10000.1",
          current_total_elevation_gain_m: "120.1",
          current_distance_measurement_count: "1",
          current_elevation_measurement_count: "1",
          previous_activity_count: "0",
          previous_total_minutes: "0",
          previous_total_distance_meters: null,
          previous_total_elevation_gain_m: null,
          previous_distance_measurement_count: "0",
          previous_elevation_measurement_count: "0",
        },
      ],
      [{ canonical_type: "cycling" }, { canonical_type: "running" }],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getActivityOverview({
      weeks: 4,
      endDate: "2026-03-20",
      activityType: "running",
    });

    expect(result).toMatchObject({
      activityCount: 1,
      totalMinutes: 60.2,
      totalDistanceMeters: 10000.1,
      totalDistanceState: { status: "available" },
      totalElevationGainM: 120.1,
      totalElevationState: { status: "available" },
      activityTypes: ["cycling", "running"],
    });
    expect(sensorStore.query).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.stringContaining("activity.canonical_type = {activityType:String}"),
      expect.objectContaining({
        activityIds: ["running-activity", "cycling-activity"],
        activityType: "running",
      }),
    );
    expect(sensorStore.query).toHaveBeenCalledTimes(2);
    expect(database.execute).toHaveBeenCalledTimes(2);
  });

  it("returns server-computed changes from the immediately preceding comparable period", async () => {
    const database = makeDatabase([
      [{ id: "running-activity" }, { id: "prior-activity" }],
      [{ id: "running-activity" }],
    ]);
    const sensorStore = makeSensorStore([
      [
        {
          current_activity_count: "2",
          current_total_minutes: "150.4",
          current_total_distance_meters: "13000",
          current_total_elevation_gain_m: "240",
          current_distance_measurement_count: "2",
          current_elevation_measurement_count: "2",
          previous_activity_count: "1",
          previous_total_minutes: "60.2",
          previous_total_distance_meters: "5000",
          previous_total_elevation_gain_m: "100",
          previous_distance_measurement_count: "1",
          previous_elevation_measurement_count: "1",
        },
      ],
      [{ canonical_type: "running" }],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getActivityOverview({ weeks: 4, endDate: "2026-03-20" });

    expect(result.comparison).toEqual({
      periodLabel: "previous 4 weeks",
      activityCount: { magnitude: 1, trend: "higher" },
      totalMinutes: { magnitude: 90.2, trend: "higher" },
      totalDistanceMeters: {
        magnitude: 8000,
        trend: "higher",
        state: { status: "available" },
      },
      totalElevationGainM: {
        magnitude: 140,
        trend: "higher",
        state: { status: "available" },
      },
    });

    expect(sensorStore.query.mock.calls[0]?.[1]).toContain("previousWindowStart");
    expect(sensorStore.query).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.any(String),
      expect.objectContaining({
        previousWindowStart: "2026-01-24",
        currentWindowStart: "2026-02-21",
        endDateExclusive: "2026-03-21",
      }),
    );
    expect(normalizeSql(vi.mocked(sensorStore.query).mock.calls[0]?.[1])).toContain(
      "activity_date < toDate({endDateExclusive:String})",
    );
    expect(normalizeSql(vi.mocked(sensorStore.query).mock.calls[0]?.[1])).toContain(
      "activity_date < toDate({currentWindowStart:String})",
    );
    expect(sensorStore.query).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.stringContaining("activity_date >= toDate({currentWindowStart:String})"),
      expect.objectContaining({
        currentWindowStart: "2026-02-21",
        endDateExclusive: "2026-03-21",
        activityIds: ["running-activity"],
      }),
    );
  });

  it("uses only current-period visible IDs for the activity-types query", async () => {
    const database = makeDatabase([
      [{ id: "current-activity" }, { id: "previous-only-activity" }],
      [{ id: "current-activity" }],
    ]);
    const sensorStore = makeSensorStore([
      [
        {
          current_activity_count: 1,
          current_total_minutes: 60,
          current_total_distance_meters: null,
          current_total_elevation_gain_m: null,
          current_distance_measurement_count: 0,
          current_elevation_measurement_count: 0,
          previous_activity_count: 1,
          previous_total_minutes: 45,
          previous_total_distance_meters: null,
          previous_total_elevation_gain_m: null,
          previous_distance_measurement_count: 0,
          previous_elevation_measurement_count: 0,
        },
      ],
      [{ canonical_type: "running" }],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    await repository.getActivityOverview({ weeks: 4, endDate: "2026-03-20" });

    expect(sensorStore.query).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.any(String),
      expect.objectContaining({
        activityIds: ["current-activity", "previous-only-activity"],
      }),
    );
    expect(sensorStore.query).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.stringContaining("SELECT DISTINCT"),
      expect.objectContaining({ activityIds: ["current-activity"] }),
    );
  });

  it("preserves unavailable overview measurements as null", async () => {
    const database = makeDatabase([
      [{ id: "activity-without-measurements" }],
      [{ id: "activity-without-measurements" }],
    ]);
    const sensorStore = makeSensorStore([
      [
        {
          current_activity_count: "1",
          current_total_minutes: "60",
          current_total_distance_meters: null,
          current_total_elevation_gain_m: null,
          current_distance_measurement_count: "0",
          current_elevation_measurement_count: "0",
          previous_activity_count: "0",
          previous_total_minutes: "0",
          previous_total_distance_meters: null,
          previous_total_elevation_gain_m: null,
          previous_distance_measurement_count: "0",
          previous_elevation_measurement_count: "0",
        },
      ],
      [{ canonical_type: "walking" }],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    await expect(
      repository.getActivityOverview({ weeks: 4, endDate: "2026-03-20" }),
    ).resolves.toMatchObject({
      activityCount: 1,
      totalMinutes: 60,
      totalDistanceMeters: null,
      totalDistanceState: {
        status: "missing",
        reason: "Distance was not recorded for every activity.",
      },
      totalElevationGainM: null,
      totalElevationState: {
        status: "missing",
        reason: "Elevation gain was not recorded for every activity.",
      },
      activityTypes: ["walking"],
      comparison: {
        periodLabel: "previous 4 weeks",
        activityCount: { magnitude: 1, trend: "higher" },
        totalMinutes: { magnitude: 60, trend: "higher" },
        totalDistanceMeters: {
          magnitude: null,
          trend: "unavailable",
          state: {
            status: "missing",
            reason: "Distance was not recorded for every activity.",
          },
        },
        totalElevationGainM: {
          magnitude: null,
          trend: "unavailable",
          state: {
            status: "missing",
            reason: "Elevation gain was not recorded for every activity.",
          },
        },
      },
    });
  });

  it("authors lower, unchanged, and previous-period unavailable comparisons", async () => {
    const database = makeDatabase([
      [{ id: "current" }, { id: "previous-1" }, { id: "previous-2" }],
      [{ id: "current" }],
    ]);
    const sensorStore = makeSensorStore([
      [
        {
          current_activity_count: 1,
          current_total_minutes: 60,
          current_total_distance_meters: 10000,
          current_total_elevation_gain_m: 120,
          current_distance_measurement_count: 1,
          current_elevation_measurement_count: 1,
          previous_activity_count: 2,
          previous_total_minutes: 60,
          previous_total_distance_meters: null,
          previous_total_elevation_gain_m: 120,
          previous_distance_measurement_count: 0,
          previous_elevation_measurement_count: 2,
        },
      ],
      [{ canonical_type: "running" }],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    await expect(
      repository.getActivityOverview({ weeks: 4, endDate: "2026-03-20" }),
    ).resolves.toMatchObject({
      comparison: {
        activityCount: { magnitude: 1, trend: "lower" },
        totalMinutes: { magnitude: 0, trend: "unchanged" },
        totalDistanceMeters: {
          magnitude: null,
          trend: "unavailable",
          state: {
            status: "missing",
            reason: "Previous period: Distance was not recorded for every activity.",
          },
        },
        totalElevationGainM: {
          magnitude: 0,
          trend: "unchanged",
          state: { status: "available" },
        },
      },
    });
  });

  it("does not report partial overview totals as available", async () => {
    const database = makeDatabase([
      [{ id: "run" }, { id: "ride" }],
      [{ id: "run" }, { id: "ride" }],
    ]);
    const sensorStore = makeSensorStore([
      [
        {
          current_activity_count: 2,
          current_total_minutes: 120,
          current_total_distance_meters: 5000,
          current_total_elevation_gain_m: 100,
          current_distance_measurement_count: 1,
          current_elevation_measurement_count: 2,
          previous_activity_count: 0,
          previous_total_minutes: 0,
          previous_total_distance_meters: null,
          previous_total_elevation_gain_m: null,
          previous_distance_measurement_count: 0,
          previous_elevation_measurement_count: 0,
        },
      ],
      [{ canonical_type: "running" }, { canonical_type: "cycling" }],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    await expect(
      repository.getActivityOverview({ weeks: 4, endDate: "2026-03-20" }),
    ).resolves.toMatchObject({
      activityCount: 2,
      totalDistanceMeters: null,
      totalDistanceState: {
        status: "missing",
        reason: "Distance was not recorded for every activity.",
      },
      totalElevationGainM: 100,
      totalElevationState: { status: "available" },
    });
  });

  it("counts indoor and virtual zero distance as measured with outdoor totals", async () => {
    const database = makeDatabase([
      [{ id: "indoor" }, { id: "run" }],
      [{ id: "indoor" }, { id: "run" }],
    ]);
    const sensorStore = makeSensorStore([
      [
        {
          current_activity_count: 2,
          current_total_minutes: 120,
          current_total_distance_meters: 5000,
          current_total_elevation_gain_m: 100,
          current_distance_measurement_count: 2,
          current_elevation_measurement_count: 2,
          previous_activity_count: 0,
          previous_total_minutes: 0,
          previous_total_distance_meters: null,
          previous_total_elevation_gain_m: null,
          previous_distance_measurement_count: 0,
          previous_elevation_measurement_count: 0,
        },
      ],
      [{ canonical_type: "indoor_cycling" }, { canonical_type: "running" }],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    await expect(
      repository.getActivityOverview({ weeks: 4, endDate: "2026-03-20" }),
    ).resolves.toMatchObject({
      activityCount: 2,
      totalDistanceMeters: 5000,
      totalDistanceState: { status: "available" },
    });

    const overviewQuery = normalizeSql(vi.mocked(sensorStore.query).mock.calls[0]?.[1]);
    expect(overviewQuery).toContain("sumOrNullIf(");
    expect(overviewQuery).toContain("summary.total_distance IS NOT NULL");
  });

  it("returns an empty overview without querying ClickHouse when no activities are visible", async () => {
    const database = makeDatabase([[]]);
    const sensorStore = makeSensorStore([]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    await expect(
      repository.getActivityOverview({ weeks: 4, endDate: "2026-03-20" }),
    ).resolves.toMatchObject({
      activityCount: 0,
      totalMinutes: 0,
      totalDistanceMeters: null,
      totalDistanceState: { status: "missing", reason: "Distance not recorded" },
      totalElevationGainM: null,
      totalElevationState: { status: "missing", reason: "Elevation gain not recorded" },
      activityTypes: [],
      comparison: {
        periodLabel: "previous 4 weeks",
        activityCount: { magnitude: 0, trend: "unchanged" },
        totalMinutes: { magnitude: 0, trend: "unchanged" },
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
    expect(sensorStore.query).not.toHaveBeenCalled();
    expect(database.execute).toHaveBeenCalledTimes(1);
  });

  it("uses empty aggregate rows to author an unavailable comparison", async () => {
    const database = makeDatabase([[{ id: "activity" }], [{ id: "activity" }]]);
    const sensorStore = makeSensorStore([[], [{ canonical_type: "running" }]]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    await expect(
      repository.getActivityOverview({ weeks: 4, endDate: "2026-03-20" }),
    ).resolves.toMatchObject({
      activityCount: 0,
      activityTypes: ["running"],
      comparison: {
        activityCount: { magnitude: 0, trend: "unchanged" },
        totalDistanceMeters: {
          magnitude: null,
          trend: "unavailable",
          state: { status: "missing", reason: "Distance not recorded" },
        },
      },
    });
  });

  it("excludes unauthorized activities from overview totals, types, and type-filter paths", async () => {
    const database = makeDatabase([
      [{ id: "authorized-run" }],
      [{ id: "authorized-run" }],
      [{ id: "authorized-run" }],
      [{ id: "authorized-run" }],
    ]);
    const sensorStore = makeSensorStore([
      [
        {
          current_activity_count: 1,
          current_total_minutes: 45,
          current_total_distance_meters: 5000,
          current_total_elevation_gain_m: 100,
          current_distance_measurement_count: 1,
          current_elevation_measurement_count: 1,
          previous_activity_count: 0,
          previous_total_minutes: 0,
          previous_total_distance_meters: null,
          previous_total_elevation_gain_m: null,
          previous_distance_measurement_count: 0,
          previous_elevation_measurement_count: 0,
        },
      ],
      [{ canonical_type: "running" }],
      [
        {
          current_activity_count: 0,
          current_total_minutes: 0,
          current_total_distance_meters: null,
          current_total_elevation_gain_m: null,
          current_distance_measurement_count: 0,
          current_elevation_measurement_count: 0,
          previous_activity_count: 0,
          previous_total_minutes: 0,
          previous_total_distance_meters: null,
          previous_total_elevation_gain_m: null,
          previous_distance_measurement_count: 0,
          previous_elevation_measurement_count: 0,
        },
      ],
      [{ canonical_type: "running" }],
    ]);
    const repository = new ActivitiesCalendarRepository(
      database,
      "00000000-0000-0000-0000-000000000001",
      "UTC",
      sensorStore,
    );

    await expect(
      repository.getActivityOverview({ weeks: 4, endDate: "2026-03-20" }),
    ).resolves.toMatchObject({
      activityCount: 1,
      totalMinutes: 45,
      totalDistanceMeters: 5000,
      totalDistanceState: { status: "available" },
      totalElevationGainM: 100,
      totalElevationState: { status: "available" },
      activityTypes: ["running"],
    });
    await expect(
      repository.getActivityOverview({
        weeks: 4,
        endDate: "2026-03-20",
        activityType: "cycling",
      }),
    ).resolves.toMatchObject({
      activityCount: 0,
      totalMinutes: 0,
      totalDistanceMeters: null,
      totalDistanceState: { status: "missing", reason: "Distance not recorded" },
      totalElevationGainM: null,
      totalElevationState: { status: "missing", reason: "Elevation gain not recorded" },
      activityTypes: ["running"],
    });
    for (const queryCall of vi.mocked(sensorStore.query).mock.calls) {
      expect(queryCall[2]).toMatchObject({ activityIds: ["authorized-run"] });
      expect(queryCall[2]).not.toEqual(
        expect.objectContaining({ activityIds: expect.arrayContaining(["unauthorized-ride"]) }),
      );
    }
  });

  it("computes overview totals from canonical one-row-per-activity summaries", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [
        {
          current_activity_count: "1",
          current_total_minutes: "60",
          current_total_distance_meters: "0",
          current_total_elevation_gain_m: "0",
          current_distance_measurement_count: "1",
          current_elevation_measurement_count: "1",
          previous_activity_count: "0",
          previous_total_minutes: "0",
          previous_total_distance_meters: null,
          previous_total_elevation_gain_m: null,
          previous_distance_measurement_count: "0",
          previous_elevation_measurement_count: "0",
        },
      ],
      [{ canonical_type: "cycling" }],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    await repository.getActivityOverview({ weeks: 1, endDate: "2026-03-20" });

    const overviewQueryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
    const normalizedOverviewQuery = normalizeSql(overviewQueryText);
    expect(normalizedOverviewQuery).toContain(
      "FROM analytics.deduped_activities AS activity FINAL",
    );
    expect(normalizedOverviewQuery).not.toContain("analytics.v_activity");
    expect(normalizedOverviewQuery).toContain("LEFT JOIN analytics.activity_summary AS summary");
    expect(normalizedOverviewQuery).toContain(
      "sumIf( dateDiff('second', activity.started_at, activity.ended_at) / 60.0",
    );
    expect(normalizedOverviewQuery).toContain("sumOrNullIf( summary.total_distance");
    expect(normalizedOverviewQuery).toContain("sumOrNullIf( summary.elevation_gain_m");
    expect(normalizedOverviewQuery).toContain("summary.total_distance IS NOT NULL");
    expect(normalizedOverviewQuery).toContain("summary.elevation_gain_m IS NOT NULL");
    expect(normalizedOverviewQuery).toContain("activity.activity_id IN {activityIds:Array(UUID)}");
  });

  it("uses deduped activities as the activity overview identity source", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [
        {
          current_activity_count: "1",
          current_total_minutes: "60",
          current_total_distance_meters: "0",
          current_total_elevation_gain_m: "0",
          current_distance_measurement_count: "1",
          current_elevation_measurement_count: "1",
          previous_activity_count: "0",
          previous_total_minutes: "0",
          previous_total_distance_meters: null,
          previous_total_elevation_gain_m: null,
          previous_distance_measurement_count: "0",
          previous_elevation_measurement_count: "0",
        },
      ],
      [{ canonical_type: "cycling" }],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    await repository.getActivityOverview({ weeks: 1, endDate: "2026-03-20" });

    const overviewQueryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
    const normalizedOverviewQuery = normalizeSql(overviewQueryText);
    expect(normalizedOverviewQuery).toContain(
      "FROM analytics.deduped_activities AS activity FINAL",
    );
    expect(normalizedOverviewQuery).not.toContain("analytics.v_activity");
    expect(normalizedOverviewQuery).toContain("activity.activity_id IN {activityIds:Array(UUID)}");
  });

  it("reads precomputed centroids from activity summary without a runtime location query", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [
        makeActivityRow({
          id: "indoor",
          canonical_type: "cycling",
          total_distance: null,
          elevation_gain_m: null,
        }),
        makeActivityRow({
          id: "outdoor-without-route",
          canonical_type: "running",
          total_distance: null,
          elevation_gain_m: null,
        }),
        makeActivityRow({
          id: "outdoor-with-route",
          canonical_type: "running",
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

    expect(result[0]?.activities.find((activity) => activity.id === "outdoor-with-route")).toEqual(
      expect.objectContaining({
        distanceMeters: 5000,
        distanceState: { status: "available" },
        elevationGainM: 125,
        elevationState: { status: "available" },
      }),
    );
    expect(
      result[0]?.activities.find((activity) => activity.id === "outdoor-with-route")?.location,
    ).toEqual({
      centroidLat: 37.8,
      centroidLng: -122.4,
      mapPreview: osmTilePreview([{ lat: 37.8, lng: -122.4 }]),
    });
    expect(sensorStore.query).toHaveBeenCalledTimes(3);
    expect(sensorStore.query).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("FROM analytics.deduped_location"),
      expect.anything(),
    );
  });

  it("preserves metric values and states when no centroid can produce a map", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [
        makeActivityRow({
          id: "indoor-zero",
          canonical_type: "indoor_cycling",
          total_distance: 0,
          elevation_gain_m: 0,
          centroid_lat: null,
          centroid_lng: null,
        }),
        makeActivityRow({
          id: "route-less-missing",
          canonical_type: "running",
          total_distance: null,
          elevation_gain_m: null,
          centroid_lat: null,
          centroid_lng: null,
        }),
      ],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({ weeks: 1, endDate: "2026-03-20" });
    const activities = result[0]?.activities ?? [];

    expect(activities.find((activity) => activity.id === "indoor-zero")).toEqual(
      expect.objectContaining({
        location: null,
        distanceMeters: 0,
        distanceState: { status: "available" },
        elevationGainM: 0,
        elevationState: { status: "available" },
      }),
    );
    expect(activities.find((activity) => activity.id === "route-less-missing")).toEqual(
      expect.objectContaining({
        location: null,
        distanceMeters: null,
        distanceState: { status: "missing", reason: "Distance not recorded" },
        elevationGainM: null,
        elevationState: { status: "missing", reason: "Elevation gain not recorded" },
      }),
    );
  });

  it("authors missing and available states without treating zero as missing", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [
        makeActivityRow({
          id: "missing-route-measurements",
          canonical_type: "running",
          total_distance: null,
          elevation_gain_m: null,
          centroid_lat: 37.7749,
          centroid_lng: -122.4194,
        }),
        makeActivityRow({
          id: "zero-route-measurements",
          canonical_type: "running",
          total_distance: 0,
          elevation_gain_m: 0,
          centroid_lat: 37.7749,
          centroid_lng: -122.4194,
        }),
      ],
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({ weeks: 1, endDate: "2026-03-20" });
    const activities = result[0]?.activities ?? [];

    expect(activities.find((activity) => activity.id === "missing-route-measurements")).toEqual(
      expect.objectContaining({
        distanceMeters: null,
        distanceState: { status: "missing", reason: "Distance not recorded" },
        elevationGainM: null,
        elevationState: { status: "missing", reason: "Elevation gain not recorded" },
      }),
    );
    expect(activities.find((activity) => activity.id === "zero-route-measurements")).toEqual(
      expect.objectContaining({
        distanceMeters: 0,
        distanceState: { status: "available" },
        elevationGainM: 0,
        elevationState: { status: "available" },
      }),
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

  it("explains every missing prerequisite when activities have no usable stress data", async () => {
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
          {
            status: "missing",
            label: "Training Stress Score",
            reason:
              "Record average power, or record average heart rate and set maximum heart rate.",
          },
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
          {
            status: "missing",
            label: "Training Stress Score",
            reason: "Record an activity duration greater than zero.",
          },
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

    expect(result[0]?.activities[0]).toEqual(
      expect.objectContaining({
        tss: null,
        stats: [
          {
            status: "missing",
            label: "Training Stress Score",
            reason:
              "Set functional threshold power, or record average heart rate and set maximum heart rate.",
          },
        ],
      }),
    );
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
        stats: [{ status: "available", label: "Training Stress Score", value: "45.1" }],
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

    expect(result[0]?.activities[0]).toEqual(
      expect.objectContaining({
        tss: null,
        stats: [
          {
            status: "missing",
            label: "Training Stress Score",
            reason:
              "Record average power and set functional threshold power, or set maximum heart rate.",
          },
        ],
      }),
    );
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

    expect(result[0]?.activities[0]).toEqual(
      expect.objectContaining({
        tss: null,
        stats: [
          {
            status: "missing",
            label: "Training Stress Score",
            reason:
              "Record average power and set functional threshold power, or set maximum heart rate above resting heart rate.",
          },
        ],
      }),
    );
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
          canonical_type: "cycling",
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
          timezone: "America/Los_Angeles",
          start_utc_offset_minutes: -480,
          end_utc_offset_minutes: -480,
          local_time_source: "unknown",
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
          expect.objectContaining({
            id: "hidden-1",
            name: "Hidden Ride",
            isProviderAbsent: true,
            providerId: "strava",
            providerAbsentAt: "2026-03-05T14:30:00.000Z",
            localTimeContext: {
              timezone: null,
              startUtcOffsetMinutes: null,
              endUtcOffsetMinutes: null,
              source: "unknown",
            },
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
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [makeActivityRow({ id: "activity-1" })],
      [{ max_hr: null, resting_hr: null, ftp: 250 }],
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
    expect(sensorStore.query).toHaveBeenCalledTimes(3);
  });

  it("merges active and hidden activities by date while preferring active entries for duplicate ids", async () => {
    const database = makeDatabase([]);
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
      [
        {
          id: "shared-id",
          name: "Hidden Ride",
          canonical_type: "cycling",
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
          timezone: "America/Los_Angeles",
          start_utc_offset_minutes: -480,
          end_utc_offset_minutes: -480,
          local_time_source: "unknown",
        },
        {
          id: "hidden-only",
          name: "Hidden Run",
          canonical_type: "running",
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
          canonical_type: "running",
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

    expect(result[0]?.activities[0]).toEqual(
      expect.objectContaining({
        distanceMeters: 5000,
        distanceState: { status: "available" },
        elevationGainM: 125,
        elevationState: { status: "available" },
      }),
    );
    expect(result[0]?.activities[0]?.location).toEqual({
      centroidLat: 37.8,
      centroidLng: -122.4,
      mapPreview: routePreview,
    });
  });

  it("includes partial absence summaries for canonical activities with absent source links", async () => {
    const database = makeDatabase([]);
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
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getWeekList({ weeks: 1, endDate: "2026-03-20" });

    expect(result[0]?.activities[0]?.partialAbsentSources).toEqual([
      {
        providerId: "strava",
        providerAbsentAt: "2026-03-05T14:30:00.000Z",
      },
    ]);
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
          canonical_type: "cycling",
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
      activityType: "cycling",
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
        primarySourceLabel: "Strava",
        sourceCount: 1,
        overlapSummary: null,
      },
      lastProcessedAt: null,
      distanceMeters: null,
      distanceState: { status: "missing", reason: "Distance not recorded" },
      elevationGainM: null,
      elevationState: { status: "missing", reason: "Elevation gain not recorded" },
      location: null,
      tss: 100,
      stats: [{ status: "available", label: "Training Stress Score", value: "100" }],
      isProviderAbsent: true,
      providerId: "strava",
      providerAbsentAt: "2026-03-05T14:30:00.000Z",
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
          canonical_type: "running",
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
          canonical_type: "running",
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

    expect(result[0]?.activities[0]).toEqual(
      expect.objectContaining({
        distanceMeters: 5000,
        distanceState: { status: "available" },
        elevationGainM: 125,
        elevationState: { status: "available" },
      }),
    );
    expect(result[0]?.activities[0]?.location).toEqual({
      centroidLat: 37.7749,
      centroidLng: -122.4194,
      mapPreview: routePreview,
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
          canonical_type: "running",
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

    expect(result[0]?.activities[0]).toEqual(
      expect.objectContaining({
        distanceMeters: 5000,
        distanceState: { status: "available" },
        elevationGainM: 125,
        elevationState: { status: "available" },
      }),
    );
    expect(result[0]?.activities[0]?.location).toEqual({
      centroidLat: 37.8,
      centroidLng: -122.4,
      mapPreview: osmTilePreview([{ lat: 37.8, lng: -122.4 }]),
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
          canonical_type: "running",
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
        },
        {
          id: "hidden-newer",
          name: "Newer Hidden",
          canonical_type: "running",
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
      {
        status: "missing",
        label: "Training Stress Score",
        reason:
          "Record average power and set functional threshold power, or record average heart rate and set maximum heart rate.",
      },
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
          canonical_type: "cycling",
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
          canonical_type: "cycling",
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
          canonical_type: "running",
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
          canonical_type: "running",
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
        },
        {
          id: "hidden-late",
          name: "Late Hidden",
          canonical_type: "running",
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
    const database = makeDatabase([]);
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
      [
        {
          id: "hidden-late",
          name: "Hidden Late",
          canonical_type: "running",
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
          canonical_type: "running",
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
      "activity.canonical_type = {activityType:String}",
    );
    expect(sensorStore.query).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      expect.stringContaining("activity.canonical_type = {activityType:String}"),
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
          canonical_type: "cycling",
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
          canonical_type: "running",
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
        stats: [{ status: "available", label: "Training Stress Score", value: "45.1" }],
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
