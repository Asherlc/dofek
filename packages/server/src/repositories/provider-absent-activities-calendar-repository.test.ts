import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { routeMapPreview } from "../lib/map-preview.ts";
import {
  makeActivityRow,
  makeDatabase,
  makeSensorStore,
  normalizeSql,
} from "./activity-calendar-test-helpers.ts";
import type { CyclingActivityPowerMetrics } from "./cycling-threshold-repository.ts";
import { CyclingThresholdRepository } from "./cycling-threshold-repository.ts";
import { ProviderAbsentActivitiesCalendarRepository } from "./provider-absent-activities-calendar-repository.ts";

const dialect = new PgDialect();

describe("ProviderAbsentActivitiesCalendarRepository", () => {
  it("includes provider-absent activities from ClickHouse when requested", async () => {
    const database = makeDatabase([]);
    const hiddenId = "00000000-0000-4000-8000-000000000010";
    vi.mocked(database.execute).mockImplementation(async (query) => {
      expect(normalizeSql(dialect.sqlToQuery(query).sql)).toContain("WITH requested AS");
      return [
        {
          requested_id: hiddenId,
          activity_id: hiddenId,
          started_at: "2026-03-18T07:00:00.000Z",
          ended_at: "2026-03-18T08:00:00.000Z",
          activity_date: "2026-03-18",
          canonical_type: "cycling",
          ftp: null,
          threshold_effective_from: null,
          threshold_source_record_id: null,
        },
      ];
    });
    const sensorStore = makeSensorStore([
      [
        {
          id: hiddenId,
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
      [],
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
            id: hiddenId,
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
      expect.stringContaining("FROM analytics.activity_summary_rows AS summary FINAL"),
      expect.objectContaining({
        userId: "user-1",
        activityIds: [hiddenId],
      }),
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
    expect(database.execute).toHaveBeenCalledExactlyOnceWith(expect.anything());
    const thresholdQuery = dialect.sqlToQuery(database.execute.mock.calls[0]?.[0]);
    expect(normalizeSql(thresholdQuery.sql)).toContain("FROM fitness.activity AS absent_activity");
    expect(normalizeSql(thresholdQuery.sql)).toContain(
      "absent_activity.provider_absent_at IS NOT NULL",
    );
    expect(thresholdQuery.params).toContain(hiddenId);
    expect(result[0]?.activities[0]).toMatchObject({ isProviderAbsent: true, tss: null });
  });

  it("enriches hidden activities with summary metrics and route previews", async () => {
    const routePoints = [
      { lat: 37.8, lng: -122.4 },
      { lat: 37.801, lng: -122.399 },
      { lat: 37.802, lng: -122.398 },
    ];
    const routePreview = routeMapPreview(routePoints);
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

  it("preserves positive stress and missing stress in hidden cycling cards", async () => {
    const poweredId = "00000000-0000-4000-8000-000000000031";
    const missingId = "00000000-0000-4000-8000-000000000032";
    vi.spyOn(CyclingThresholdRepository.prototype, "getForActivities").mockResolvedValue(
      new Map<string, CyclingActivityPowerMetrics>([
        [
          poweredId,
          {
            activity_id: poweredId,
            started_at: "2026-03-18T07:00:00.000Z",
            ended_at: "2026-03-18T08:00:00.000Z",
            activity_date: "2026-03-18",
            canonical_type: "cycling",
            normalized_power: 250,
            power_sample_count: 3600,
            ftp: 250,
            power_tss: 100,
            intensity_factor: 1,
            threshold: {
              value: 250,
              unit: "watt",
              effective_from: "2026-01-01",
              source_record_id: "00000000-0000-4000-8000-000000000033",
              kind: "configured",
            },
          },
        ],
      ]),
    );
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [
        {
          id: poweredId,
          name: "Hidden powered ride",
          canonical_type: "cycling",
          started_at: "2026-03-18T07:00:00.000Z",
          ended_at: "2026-03-18T08:00:00.000Z",
          duration_min: 60,
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          total_distance: null,
          elevation_gain_m: null,
          centroid_lat: 37.8,
          centroid_lng: -122.4,
          local_date: "2026-03-18",
          provider_id: "strava",
          provider_absent_at: "2026-03-05T14:30:00.000Z",
        },
        {
          id: missingId,
          name: "Hidden ride without NP",
          canonical_type: "cycling",
          started_at: "2026-03-18T09:00:00.000Z",
          ended_at: "2026-03-18T10:00:00.000Z",
          duration_min: 60,
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          total_distance: null,
          elevation_gain_m: null,
          centroid_lat: 37.81,
          centroid_lng: -122.41,
          local_date: "2026-03-18",
          provider_id: "strava",
          provider_absent_at: "2026-03-05T14:30:00.000Z",
        },
      ],
      [
        {
          id: poweredId,
          avg_hr: null,
          max_hr: null,
          avg_power: 250,
          total_distance: 10000,
          elevation_gain_m: 50,
          centroid_lat: 37.8,
          centroid_lng: -122.4,
        },
        {
          id: missingId,
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          total_distance: 8000,
          elevation_gain_m: 25,
          centroid_lat: 37.81,
          centroid_lng: -122.41,
        },
      ],
      [],
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

    expect(result[0]?.activities.map((activity) => [activity.id, activity.tss])).toEqual([
      [poweredId, 100],
      [missingId, null],
    ]);
  });

  it("passes the user id to hidden activity summary queries", async () => {
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
      2,
      expect.anything(),
      expect.stringContaining("FROM analytics.activity_summary_rows"),
      { userId: "user-1", activityIds: ["hidden-1"] },
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

  it("passes inclusive windowStart and windowEnd for explicit agenda ranges", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([[]]);
    const repository = new ProviderAbsentActivitiesCalendarRepository(
      database,
      "user-1",
      "UTC",
      sensorStore,
    );

    await repository.getWeekList({
      weeks: 1,
      startDate: "2026-03-01",
      endDate: "2026-03-20",
      includeProviderAbsent: true,
    });

    expect(sensorStore.query).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.stringMatching(
        />= toDate\(\{windowStart:String\}\).*<= toDate\(\{windowEnd:String\}\)/s,
      ),
      expect.objectContaining({
        windowStart: "2026-03-01",
        windowEnd: "2026-03-20",
      }),
    );
  });

  it.each([
    ["processing", { kind: "processing" }],
    ["awaiting_summary", null],
    ["unavailable", null],
  ] as const)(
    "projects absent-source map readiness %s using its canonical route",
    async (status, location) => {
      const sensorStore = makeSensorStore([
        [
          makeActivityRow({
            id: "absent-member",
            route_activity_id: "canonical-route",
            member_activity_ids: ["absent-member"],
            provider_absent_at: "2026-03-18T09:00:00.000Z",
          }),
        ],
        [],
        [],
        [{ activity_id: "absent-member", status }],
      ]);
      const repository = new ProviderAbsentActivitiesCalendarRepository(
        makeDatabase([]),
        "user-1",
        "UTC",
        sensorStore,
      );

      const [day] = await repository.getWeekList({
        weeks: 1,
        endDate: "2026-03-20",
        includeProviderAbsent: true,
      });

      expect(day?.activities).toEqual([
        expect.objectContaining({ id: "absent-member", isProviderAbsent: true, location }),
      ]);
      expect(vi.mocked(sensorStore.query).mock.lastCall?.[2]).toEqual({
        userId: "user-1",
        activityIds: ["absent-member"],
        routeActivityIds: ["canonical-route"],
        memberActivityIds: ["absent-member"],
      });
    },
  );

  it("checks absent-source readiness after summary enrichment only for incomplete GPS", async () => {
    const coordinates = [
      { id: "no-centroid", centroid_lat: null, centroid_lng: null },
      { id: "missing-latitude", centroid_lat: null, centroid_lng: -105.4 },
      { id: "missing-longitude", centroid_lat: 40.007, centroid_lng: null },
      { id: "recorded-gps", centroid_lat: 0, centroid_lng: 0 },
    ];
    const sensorStore = makeSensorStore([
      coordinates.map(({ id }) =>
        makeActivityRow({
          id,
          route_activity_id: `canonical-${id}`,
          member_activity_ids: [id],
          provider_absent_at: "2026-03-18T09:00:00.000Z",
        }),
      ),
      coordinates.map((row) => ({
        avg_hr: null,
        max_hr: null,
        avg_power: null,
        total_distance: null,
        elevation_gain_m: null,
        ...row,
      })),
      [],
      ["no-centroid", "missing-latitude", "missing-longitude"].map((id) => ({
        activity_id: id,
        status: "processing",
      })),
    ]);
    const repository = new ProviderAbsentActivitiesCalendarRepository(
      makeDatabase([]),
      "user-1",
      "UTC",
      sensorStore,
    );

    const [day] = await repository.getWeekList({
      weeks: 1,
      endDate: "2026-03-20",
      includeProviderAbsent: true,
    });

    expect(vi.mocked(sensorStore.query).mock.lastCall?.[2]).toEqual({
      userId: "user-1",
      activityIds: ["no-centroid", "missing-latitude", "missing-longitude"],
      routeActivityIds: [
        "canonical-no-centroid",
        "canonical-missing-latitude",
        "canonical-missing-longitude",
      ],
      memberActivityIds: ["no-centroid", "missing-latitude", "missing-longitude"],
    });
    expect(day?.activities.map((entry) => entry.location?.kind)).toEqual([
      "processing",
      "processing",
      "processing",
      "recorded_gps",
    ]);
    expect(day?.activities[3]?.location).toMatchObject({ centroidLat: 0, centroidLng: 0 });
  });
});
