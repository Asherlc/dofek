import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { osmTilePreview } from "../lib/osm-tile.ts";
import { ActivitiesCalendarRepository } from "./activities-calendar-repository.ts";
import {
  expectDedupedActivitiesDriveActivityListIdentity,
  expectDedupedActivitiesWithSummaryMetrics,
  makeActivityRow,
  makeDatabase,
  makeSensorStore,
  normalizeSql,
} from "./activity-calendar-test-helpers.ts";
import { ClimbingActivityLogEntryRepository } from "./climbing-activity-log-entry-repository.ts";
import { climbingClimbFixture, climbingLogEntryFixture } from "./climbing-test-helpers.ts";

const dialect = new PgDialect();

describe("ActivitiesCalendarRepository", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(
    [false, true].flatMap((isProviderAbsent) =>
      ["indoor", "virtual", "road", null].map((modality) => ({ isProviderAbsent, modality })),
    ),
  )(
    "preserves stored cycling modality $modality (provider absent: $isProviderAbsent)",
    async ({ modality, isProviderAbsent }) => {
      const row = makeActivityRow({
        modality,
        ...(isProviderAbsent ? { provider_absent_at: "2026-03-19T12:00:00.000Z" } : {}),
      });
      const baseline = [{ max_hr: null, resting_hr: null, ftp: null }];
      const sensorStore = makeSensorStore(
        isProviderAbsent ? [[], baseline, [row], [], baseline, []] : [[row], baseline],
      );
      const repository = new ActivitiesCalendarRepository(
        makeDatabase([]),
        "user-1",
        "UTC",
        sensorStore,
      );

      const days = await repository.getWeekList({
        weeks: 1,
        endDate: "2026-03-20",
        includeProviderAbsent: isProviderAbsent,
      });

      expect(days[0]?.activities[0]).toMatchObject({
        activityType: "cycling",
        modality,
        ...(isProviderAbsent ? { isProviderAbsent: true } : {}),
      });
    },
  );

  it("requests source locations only for activities missing either recorded coordinate", async () => {
    const rows = [
      { id: "30000000-0000-4000-8000-000000000001", centroid_lat: null, centroid_lng: null },
      { id: "30000000-0000-4000-8000-000000000002", centroid_lat: null, centroid_lng: -105.4 },
      { id: "30000000-0000-4000-8000-000000000003", centroid_lat: 40.007, centroid_lng: null },
      { id: "30000000-0000-4000-8000-000000000004", centroid_lat: 0, centroid_lng: 0 },
    ];
    const source = {
      ...climbingClimbFixture("mountain-project"),
      coordinates: { latitude: 40.007, longitude: -105.4 },
    };
    const database = makeDatabase(
      [],
      rows.map((row) => climbingLogEntryFixture({ activityId: row.id, climb: source })),
    );
    const locations = vi.spyOn(
      ClimbingActivityLogEntryRepository.prototype,
      "getActivityMapLocations",
    );
    const sensorStore = makeSensorStore([
      rows.map((row) => makeActivityRow({ ...row, canonical_type: "climbing" })),
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [],
    ]);
    const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);
    const [day] = await repository.getWeekList({ weeks: 4, endDate: "2026-03-20" });

    expect(locations).toHaveBeenCalledExactlyOnceWith(rows.slice(0, 3).map((row) => row.id));
    expect(day?.activities.slice(0, 3).map((entry) => entry.location)).toEqual(
      rows.slice(0, 3).map(() =>
        expect.objectContaining({
          kind: "climbing_source",
          sourcePoints: [
            expect.objectContaining({ location: expect.objectContaining({ objectId: source.id }) }),
          ],
        }),
      ),
    );
    expect(day?.activities[3]?.location).toMatchObject({
      kind: "recorded_gps",
      centroidLat: 0,
      centroidLng: 0,
    });
  });

  it.each([false, true])(
    "uses attached source GPS only when recorded GPS is absent (recorded=%s)",
    async (recorded) => {
      const climb = climbingClimbFixture("mountain-project");
      const source = {
        ...climb,
        coordinates: { latitude: 40.007, longitude: -105.4 },
      };
      const activityId = "30000000-0000-4000-8000-000000000001";
      const database = makeDatabase([], [climbingLogEntryFixture({ activityId, climb: source })]);
      const sensorStore = makeSensorStore([
        [
          makeActivityRow({
            id: activityId,
            canonical_type: "climbing",
            centroid_lat: recorded ? 37.8 : null,
            centroid_lng: recorded ? -122.4 : null,
          }),
        ],
        [{ max_hr: null, resting_hr: null, ftp: null }],
        [],
      ]);
      const repository = new ActivitiesCalendarRepository(database, "user-1", "UTC", sensorStore);
      const [day] = await repository.getWeekList({ weeks: 4, endDate: "2026-03-20" });
      const location = day?.activities[0]?.location;
      if (recorded) {
        expect(location).toMatchObject({
          kind: "recorded_gps",
          centroidLat: 37.8,
          centroidLng: -122.4,
        });
      } else {
        expect(location).toMatchObject({
          kind: "climbing_source",
          mapPreview: { routePath: null },
          sourcePoints: [
            {
              x: 512,
              y: 288,
              location: {
                scope: "climb",
                objectId: source.id,
                providerId: "mountain-project",
                coordinates: source.coordinates,
              },
            },
          ],
        });
      }
    },
  );

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
          origin: { status: "unresolved", candidateMemberActivityIds: [] },
          primarySourceLabel: null,
          sourceCount: 2,
          overlapSummary: "2 matched source records",
          tree: {
            primary: null,
            otherSources: [
              {
                id: "strava:strava-activity-1:",
                providerId: "strava",
                sourceName: null,
                label: "Strava",
                description: null,
                url: null,
                children: [],
              },
              {
                id: "wahoo:wahoo-activity-1:",
                providerId: "wahoo",
                sourceName: null,
                label: "Wahoo",
                description: null,
                url: null,
                children: [],
              },
            ],
          },
        },
        lastProcessedAt: "2026-03-18T08:07:00.000Z",
      }),
    );
    const listQuery = String(vi.mocked(sensorStore.query).mock.calls[0]?.[1]);
    expect(listQuery.match(/activity\.provider_id = 'mountain-project'/g)).toHaveLength(2);
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
    expect(normalizeSql(compiledQuery.sql)).toContain("FROM fitness.v_activity");
    expect(sensorStore.query).toHaveBeenCalledTimes(2);
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
      kind: "recorded_gps",
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
  it.each([
    ["processing", { kind: "processing" }],
    ["awaiting_summary", { kind: "processing" }],
    ["unavailable", null],
    [undefined, null],
  ] as const)(
    "projects active map readiness %s into its display state",
    async (status, location) => {
      const sensorStore = makeSensorStore([
        [
          makeActivityRow({
            id: "pending",
            member_activity_ids: status === undefined ? [] : ["pending-member"],
          }),
        ],
        [{ max_hr: null, resting_hr: null, ftp: null }],
        ...(status === undefined ? [] : [[{ activity_id: "pending", status }]]),
      ]);
      const repository = new ActivitiesCalendarRepository(
        makeDatabase([]),
        "user-1",
        "UTC",
        sensorStore,
      );

      const result = await repository.getWeekList({ weeks: 1, endDate: "2026-03-20" });

      expect(result[0]?.activities[0]?.location).toEqual(location);
      if (status === undefined) {
        expect(sensorStore.query).toHaveBeenCalledTimes(2);
      } else {
        expect(vi.mocked(sensorStore.query).mock.lastCall?.[2]).toEqual({
          userId: "user-1",
          activityIds: ["pending"],
          routeActivityIds: ["pending"],
          memberActivityIds: ["pending-member"],
        });
      }
    },
  );

  it("checks readiness only for active activities without complete GPS or a climbing map", async () => {
    const sourceLocation = {
      coordinates: { latitude: 40.007, longitude: -105.4 },
      scope: "climb" as const,
      objectId: "source-climb",
      providerId: "mountain-project",
      name: "Mapped climb",
    };
    vi.spyOn(
      ClimbingActivityLogEntryRepository.prototype,
      "getActivityMapLocations",
    ).mockResolvedValue(new Map([["mapped-climb", [sourceLocation]]]));
    const rows = [
      { id: "no-centroid", centroid_lat: null, centroid_lng: null },
      { id: "missing-latitude", centroid_lat: null, centroid_lng: -105.4 },
      { id: "missing-longitude", centroid_lat: 40.007, centroid_lng: null },
      { id: "mapped-climb", centroid_lat: null, centroid_lng: null },
      { id: "recorded-gps", centroid_lat: 0, centroid_lng: 0 },
    ].map((row) =>
      makeActivityRow({
        ...row,
        member_activity_ids: [`${row.id}-member-1`, `${row.id}-member-2`],
      }),
    );
    const sensorStore = makeSensorStore([
      rows,
      [{ max_hr: null, resting_hr: null, ftp: null }],
      [],
      ["no-centroid", "missing-latitude", "missing-longitude"].map((id) => ({
        activity_id: id,
        status: "processing",
      })),
    ]);
    const repository = new ActivitiesCalendarRepository(
      makeDatabase([]),
      "user-1",
      "UTC",
      sensorStore,
    );

    const [day] = await repository.getWeekList({ weeks: 1, endDate: "2026-03-20" });

    expect(vi.mocked(sensorStore.query).mock.lastCall?.[2]).toEqual({
      userId: "user-1",
      activityIds: [
        "no-centroid",
        "no-centroid",
        "missing-latitude",
        "missing-latitude",
        "missing-longitude",
        "missing-longitude",
      ],
      routeActivityIds: [
        "no-centroid",
        "no-centroid",
        "missing-latitude",
        "missing-latitude",
        "missing-longitude",
        "missing-longitude",
      ],
      memberActivityIds: [
        "no-centroid-member-1",
        "no-centroid-member-2",
        "missing-latitude-member-1",
        "missing-latitude-member-2",
        "missing-longitude-member-1",
        "missing-longitude-member-2",
      ],
    });
    expect(day?.activities.map((entry) => entry.location?.kind)).toEqual([
      "processing",
      "processing",
      "processing",
      "climbing_source",
      "recorded_gps",
    ]);
    expect(day?.activities[3]?.location).toMatchObject({
      sourcePoints: [expect.objectContaining({ location: sourceLocation })],
    });
    expect(day?.activities[4]?.location).toMatchObject({ centroidLat: 0, centroidLng: 0 });
  });
});
