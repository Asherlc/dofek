import { describe, expect, it } from "vitest";
import { routeMapPreview } from "../lib/map-preview.ts";
import {
  activityRowSchema,
  createActiveCalendarEntry,
  createProviderAbsentCalendarEntry,
} from "./activity-calendar-entry.ts";
import { makeActivityRow } from "./activity-calendar-test-helpers.ts";

describe("activity calendar entries", () => {
  it("uses canonical per-activity power stress even without heart rate", () => {
    const row = activityRowSchema.parse({
      ...makeActivityRow({ avg_hr: null, max_hr: null, avg_power: 50 }),
      power_tss: 83.25,
    });
    expect(createActiveCalendarEntry(row, {}).tss).toBe(83.3);
  });

  it("keeps the primary source type separate from the representative classification", () => {
    const row = activityRowSchema.parse(
      makeActivityRow({
        canonical_type: "walking",
        primary_canonical_type: "running",
        name: null,
      }),
    );
    const entry = createActiveCalendarEntry(row, {});

    expect(entry).toMatchObject({
      name: null,
      activityType: "walking",
      primaryActivityType: "running",
      tss: null,
      stats: [],
    });
  });

  it.each([
    ["processing", { kind: "processing" }, { kind: "processing" }],
    ["awaiting_summary", { kind: "processing" }, null],
    ["unavailable", null, null],
    [undefined, null, null],
  ] as const)("projects active and absent map readiness %s", (mapReadiness, active, absent) => {
    const row = activityRowSchema.parse(makeActivityRow());
    const context = {
      mapReadiness,
    };

    expect(createActiveCalendarEntry(row, context).location).toEqual(active);
    expect(
      createProviderAbsentCalendarEntry(
        { ...row, provider_absent_at: "2026-03-18T09:00:00.000Z" },
        context,
      ).location,
    ).toEqual(absent);
  });

  it("exposes timezone fields only for authoritative timezone provenance", () => {
    const rows = [
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
      makeActivityRow({
        id: "home-timezone-context",
        timezone: "America/Los_Angeles",
        start_utc_offset_minutes: -480,
        end_utc_offset_minutes: -420,
        local_time_source: "user_home_timezone",
      }),
    ];

    const entries = rows.map((row) => createActiveCalendarEntry(activityRowSchema.parse(row), {}));
    const contextById = new Map(entries.map((entry) => [entry.id, entry.localTimeContext]));
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
    expect(contextById.get("home-timezone-context")).toEqual({
      timezone: "America/Los_Angeles",
      startUtcOffsetMinutes: -480,
      endUtcOffsetMinutes: -420,
      source: "user_home_timezone",
    });
  });

  it("adds a clamped location tile and preserves distance/elevation for outdoor activities", () => {
    const rows = [
      makeActivityRow({
        canonical_type: "running",
        total_distance: 5000,
        elevation_gain_m: 125,
        centroid_lat: 90,
        centroid_lng: 180,
        avg_power: null,
        local_date: "2026-03-19",
      }),
    ];

    const entries = rows.map((row) => createActiveCalendarEntry(activityRowSchema.parse(row), {}));
    expect(entries[0]).toEqual(
      expect.objectContaining({
        distanceMeters: 5000,
        distanceState: { status: "available" },
        elevationGainM: 125,
        elevationState: { status: "available" },
      }),
    );
    expect(entries[0]?.location).toEqual({
      kind: "recorded_gps",
      centroidLat: 90,
      centroidLng: 180,
      mapPreview: routeMapPreview([{ lat: 90, lng: 180 }]),
    });
  });

  it("adds route preview path points for outdoor activities", () => {
    const rows = [
      makeActivityRow({
        id: "00000000-0000-0000-0000-000000000001",
        canonical_type: "running",
        total_distance: 5000,
        elevation_gain_m: 125,
        centroid_lat: 37.7749,
        centroid_lng: -122.4194,
        avg_power: null,
      }),
    ];
    const routeRows = [
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
    ];
    const entries = rows.map((row) =>
      createActiveCalendarEntry(activityRowSchema.parse(row), {
        routePreview: routeMapPreview(routeRows),
      }),
    );
    expect(entries[0]?.location).toMatchObject({
      mapPreview: routeMapPreview([
        { lat: 37.7749, lng: -122.4194 },
        { lat: 37.7752, lng: -122.4188 },
        { lat: 37.7756, lng: -122.4182 },
      ]),
    });
  });

  it("preserves metric values and states when no centroid can produce a map", () => {
    const rows = [
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
    ];

    const entries = rows.map((row) => createActiveCalendarEntry(activityRowSchema.parse(row), {}));
    const activities = entries;
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

  it("authors missing and available states without treating zero as missing", () => {
    const rows = [
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
    ];

    const entries = rows.map((row) => createActiveCalendarEntry(activityRowSchema.parse(row), {}));
    const activities = entries;
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

  it("explains cycling power prerequisites when stress data is unavailable", () => {
    const rows = [makeActivityRow({ avg_power: null, avg_hr: null })];

    const entries = rows.map((row) => createActiveCalendarEntry(activityRowSchema.parse(row), {}));
    expect(entries[0]).toEqual(
      expect.objectContaining({
        tss: null,
        stats: [
          {
            status: "missing",
            label: "Training Stress Score",
            reason:
              "Record cycling power with sufficient sustained-effort evidence for computed eFTP.",
          },
        ],
      }),
    );
  });

  it("does not compute stress for zero-duration activities", () => {
    const rows = [makeActivityRow({ duration_min: 0 })];

    const entries = rows.map((row) => createActiveCalendarEntry(activityRowSchema.parse(row), {}));
    expect(entries[0]).toEqual(
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

  it("retains canonical zero stress even when heart rate is available", () => {
    const row = activityRowSchema.parse(makeActivityRow({ power_tss: 0, avg_hr: 150 }));
    expect(createActiveCalendarEntry(row, {}).tss).toBe(0);
  });

  it("includes partial absence summaries for canonical activities with absent source links", () => {
    const rows = [
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
    ];

    const entries = rows.map((row) => createActiveCalendarEntry(activityRowSchema.parse(row), {}));
    expect(entries[0]?.partialAbsentSources).toEqual([
      {
        providerId: "strava",
        providerAbsentAt: "2026-03-05T14:30:00.000Z",
      },
    ]);
  });

  it("builds complete hidden activity entries with stress, stats, and tombstone metadata", () => {
    const rows = [
      makeActivityRow({
        id: "hidden-power",
        power_tss: 100,
        name: "Hidden Ride",
        canonical_type: "cycling",
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
        local_date: "2026-03-18",
        provider_id: "strava",
        provider_absent_at: "2026-03-05T14:30:00.000Z",
        last_processed_at: null,
      }),
    ];

    const entries = rows.map((row) =>
      createProviderAbsentCalendarEntry(
        {
          ...activityRowSchema.parse(row),
          provider_absent_at: row.provider_absent_at,
        },
        {},
      ),
    );
    expect(entries[0]).toEqual({
      id: "hidden-power",
      name: "Hidden Ride",
      primaryActivityType: null,
      activityType: "cycling",
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
        tree: {
          primary: null,
          otherSources: [
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

  it("omits hidden locations when only longitude is present", () => {
    const rows = [
      makeActivityRow({
        id: "hidden-longitude-only",
        name: "Hidden Run",
        canonical_type: "running",
        started_at: "2026-03-18T07:00:00.000Z",
        ended_at: "2026-03-18T08:00:00.000Z",
        duration_min: 60,
        avg_hr: null,
        max_hr: null,
        avg_power: null,
        total_distance: 5000,
        elevation_gain_m: 125,
        centroid_lat: null,
        centroid_lng: -122.4,
        local_date: "2026-03-18",
        provider_id: "strava",
        provider_absent_at: "2026-03-05T14:30:00.000Z",
        last_processed_at: null,
      }),
    ];

    const entries = rows.map((row) =>
      createProviderAbsentCalendarEntry(
        {
          ...activityRowSchema.parse(row),
          provider_absent_at: row.provider_absent_at,
        },
        {},
      ),
    );
    expect(entries[0]?.location).toBeNull();
  });

  it("uses the route preview tile for hidden outdoor activities when available", () => {
    const routePoints = [
      { lat: 37.7749, lng: -122.4194 },
      { lat: 37.7752, lng: -122.4188 },
      { lat: 37.7756, lng: -122.4182 },
    ];
    const routePreview = routeMapPreview(routePoints);
    const rows = [
      makeActivityRow({
        id: "hidden-outdoor-route",
        name: "Hidden Run",
        canonical_type: "running",
        started_at: "2026-03-18T07:00:00.000Z",
        ended_at: "2026-03-18T08:00:00.000Z",
        duration_min: 60,
        avg_hr: null,
        max_hr: null,
        avg_power: null,
        total_distance: 5000,
        elevation_gain_m: 125,
        centroid_lat: 37.7749,
        centroid_lng: -122.4194,
        local_date: "2026-03-18",
        provider_id: "strava",
        provider_absent_at: "2026-03-05T14:30:00.000Z",
        last_processed_at: null,
      }),
    ];

    const routeRows = routePoints.map((point) => ({
      activity_id: "hidden-outdoor-route",
      lat: point.lat,
      lng: point.lng,
    }));
    const entries = rows.map((row) =>
      createProviderAbsentCalendarEntry(
        {
          ...activityRowSchema.parse(row),
          provider_absent_at: row.provider_absent_at,
        },
        {
          routePreview: routeMapPreview(routeRows),
        },
      ),
    );
    expect(entries[0]).toEqual(
      expect.objectContaining({
        distanceMeters: 5000,
        distanceState: { status: "available" },
        elevationGainM: 125,
        elevationState: { status: "available" },
      }),
    );
    expect(entries[0]?.location).toEqual({
      kind: "recorded_gps",
      centroidLat: 37.7749,
      centroidLng: -122.4194,
      mapPreview: routePreview,
    });
  });

  it("falls back to an osm tile when hidden activities have no route preview", () => {
    const rows = [
      makeActivityRow({
        id: "hidden-outdoor-fallback",
        name: "Hidden Run",
        canonical_type: "running",
        started_at: "2026-03-18T07:00:00.000Z",
        ended_at: "2026-03-18T08:00:00.000Z",
        duration_min: 60,
        avg_hr: null,
        max_hr: null,
        avg_power: null,
        total_distance: 5000,
        elevation_gain_m: 125,
        centroid_lat: 37.8,
        centroid_lng: -122.4,
        local_date: "2026-03-18",
        provider_id: "strava",
        provider_absent_at: "2026-03-05T14:30:00.000Z",
        last_processed_at: null,
      }),
    ];

    const entries = rows.map((row) =>
      createProviderAbsentCalendarEntry(
        {
          ...activityRowSchema.parse(row),
          provider_absent_at: row.provider_absent_at,
        },
        {},
      ),
    );
    expect(entries[0]).toEqual(
      expect.objectContaining({
        distanceMeters: 5000,
        distanceState: { status: "available" },
        elevationGainM: 125,
        elevationState: { status: "available" },
      }),
    );
    expect(entries[0]?.location).toEqual({
      kind: "recorded_gps",
      centroidLat: 37.8,
      centroidLng: -122.4,
      mapPreview: routeMapPreview([{ lat: 37.8, lng: -122.4 }]),
    });
  });

  it("omits hidden locations when only one centroid coordinate is present", () => {
    const rows = [
      makeActivityRow({
        id: "hidden-latitude-only",
        name: "Hidden Run",
        canonical_type: "running",
        started_at: "2026-03-18T07:00:00.000Z",
        ended_at: "2026-03-18T08:00:00.000Z",
        duration_min: 60,
        avg_hr: null,
        max_hr: null,
        avg_power: null,
        total_distance: 5000,
        elevation_gain_m: 125,
        centroid_lat: 37.8,
        centroid_lng: null,
        local_date: "2026-03-18",
        provider_id: "strava",
        provider_absent_at: "2026-03-05T14:30:00.000Z",
        last_processed_at: null,
      }),
    ];

    const entries = rows.map((row) =>
      createProviderAbsentCalendarEntry(
        {
          ...activityRowSchema.parse(row),
          provider_absent_at: row.provider_absent_at,
        },
        {},
      ),
    );
    expect(entries[0]?.location).toBeNull();
  });
});
