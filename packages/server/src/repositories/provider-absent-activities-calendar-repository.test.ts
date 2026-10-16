import { describe, expect, it, vi } from "vitest";
import { osmTilePreview } from "../lib/osm-tile.ts";
import { makeDatabase, makeSensorStore, normalizeSql } from "./activity-calendar-test-helpers.ts";
import { ProviderAbsentActivitiesCalendarRepository } from "./provider-absent-activities-calendar-repository.ts";

describe("ProviderAbsentActivitiesCalendarRepository", () => {
  it("includes provider-absent activities from ClickHouse when requested", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
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
    const repository = new ProviderAbsentActivitiesCalendarRepository(
      database,
      "user-1",
      "UTC",
      sensorStore,
    );

    const result = await repository.getWeekList({
      weeks: 1,
      endDate: "2026-03-20",
      includeProviderAbsent: true,
    });
    const hiddenQuery = String(vi.mocked(sensorStore.query).mock.calls[0]?.[1]);
    expect(hiddenQuery.match(/activity\.provider_id = 'mountain-project'/g)).toHaveLength(2);

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
    const hiddenQueryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
    expect(normalizeSql(hiddenQueryText)).toContain(
      "FROM postgres_fitness.activity AS activity FINAL",
    );
    expect(normalizeSql(hiddenQueryText)).toContain("provider_absent_at IS NOT NULL");
    expect(sensorStore.query).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.stringContaining("FROM analytics.activity_summary_rows FINAL"),
      expect.objectContaining({
        userId: "user-1",
        activityIds: ["hidden-1"],
      }),
    );
    expect(sensorStore.query).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      expect.stringContaining("FROM postgres_fitness.user_profile_current"),
      { userId: "user-1" },
    );
    expect(sensorStore.query).toHaveBeenNthCalledWith(
      1,
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

  it("enriches hidden activities with summary metrics and route previews", async () => {
    const routePoints = [
      { lat: 37.8, lng: -122.4 },
      { lat: 37.801, lng: -122.399 },
      { lat: 37.802, lng: -122.398 },
    ];
    const routePreview = osmTilePreview(routePoints);
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
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
    const repository = new ProviderAbsentActivitiesCalendarRepository(
      database,
      "user-1",
      "UTC",
      sensorStore,
    );

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
      kind: "recorded_gps",
      centroidLat: 37.8,
      centroidLng: -122.4,
      mapPreview: routePreview,
    });
  });

  it("passes the user id to hidden activity enrichment queries", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
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
    const repository = new ProviderAbsentActivitiesCalendarRepository(
      database,
      "user-1",
      "UTC",
      sensorStore,
    );

    await repository.getWeekList({
      weeks: 1,
      endDate: "2026-03-20",
      includeProviderAbsent: true,
    });

    expect(sensorStore.query).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      expect.stringContaining("FROM postgres_fitness.user_profile_current"),
      { userId: "user-1" },
    );
  });

  it("does not apply limited access filters when the access window is full", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
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
    const repository = new ProviderAbsentActivitiesCalendarRepository(
      database,
      "user-1",
      "UTC",
      sensorStore,
      {
        kind: "full",
        paid: true,
        reason: "paid_grant",
      },
    );

    await repository.getWeekList({
      weeks: 1,
      endDate: "2026-03-20",
      includeProviderAbsent: true,
    });

    const hiddenQueryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
    expect(normalizeSql(hiddenQueryText)).not.toContain("accessStartDate");
    expect(sensorStore.query).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.not.stringContaining("accessStartDate"),
      expect.not.objectContaining({ accessStartDate: expect.anything() }),
    );
  });

  it("filters hidden activities by activity type when requested", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
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
    const repository = new ProviderAbsentActivitiesCalendarRepository(
      database,
      "user-1",
      "UTC",
      sensorStore,
    );

    const result = await repository.getWeekList({
      weeks: 1,
      endDate: "2026-03-20",
      activityType: "running",
      includeProviderAbsent: true,
    });

    expect(result[0]?.activities[0]?.id).toBe("hidden-run");
    const hiddenQueryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
    expect(normalizeSql(hiddenQueryText)).toContain(
      "activity.canonical_type = {activityType:String}",
    );
    expect(sensorStore.query).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.stringContaining("activity.canonical_type = {activityType:String}"),
      expect.objectContaining({ activityType: "running" }),
    );
  });

  it("applies limited access windows to hidden activity queries", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
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
    const repository = new ProviderAbsentActivitiesCalendarRepository(
      database,
      "user-1",
      "UTC",
      sensorStore,
      {
        kind: "limited",
        paid: false,
        reason: "free_recent_week",
        startDate: "2026-03-01",
        endDateExclusive: "2026-03-31",
      },
    );

    await repository.getWeekList({
      weeks: 1,
      endDate: "2026-03-20",
      includeProviderAbsent: true,
    });

    const hiddenQueryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
    expect(normalizeSql(hiddenQueryText)).toContain("accessStartDate");
    expect(sensorStore.query).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.stringContaining("accessStartDate"),
      expect.objectContaining({
        accessStartDate: "2026-03-01",
        accessEndDateExclusive: "2026-03-31",
      }),
    );
  });
});
